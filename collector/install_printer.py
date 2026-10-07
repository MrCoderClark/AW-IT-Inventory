"""Remote printer install (spec 20).

Outbound-only, like the rest of the collector: the worker claims an install job
from the web app, pulls the driver bundle, connects into the target computer over
WinRM (the same channel used to scan it), stages + installs the driver/port/
printer, verifies with Get-Printer, and posts the result back.

The driver bundle is transferred as the zip encoded base64 over WinRM and
reconstructed + Expand-Archive'd on the target (dependency-free; works wherever
WinRM does). SMB admin-share transfer is a future optimisation (see spec 20).

Integrity: the bundle's content hash (sorted relpath\\0 + bytes, matching
web/src/lib/printer-packages.ts) is re-computed after extraction and must equal
the job's frozen snapshot before anything runs on the target.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import zipfile

import httpx
import winrm
from rich.console import Console

from collect_windows import _winrm_username
from config import Config
from creds import resolve_profiles

try:  # SMB admin-share transfer (fast path). Optional dep: `uv add smbprotocol`.
    import smbclient

    _SMB_AVAILABLE = True
except ImportError:  # pragma: no cover
    _SMB_AVAILABLE = False

console = Console()

# Base64 fallback chunk (used only when SMB is unavailable). pywinrm puts each
# run_ps command on the PowerShell command LINE, which Windows caps at ~32 KB, and
# pywinrm re-encodes it (UTF-16 + base64, ~2.7x). So the chunk must be tiny:
# 8 KB base64 → ~22 KB on the wire, under the limit. (This path is slow for big
# files — SMB is the real transfer.)
_CHUNK = 8_000


# ---------------- WinRM helpers ----------------


def _session(ip: str, prof, config: Config) -> winrm.Session:
    endpoint = f"{config.winrm_scheme}://{ip}:{config.ports.winrm}/wsman"
    return winrm.Session(
        endpoint,
        auth=(_winrm_username(prof.username), prof.password),
        transport=config.winrm_transport,
        server_cert_validation="ignore",
    )


def _ps(session: winrm.Session, script: str) -> dict:
    """Run a PowerShell snippet; return a step dict {exitCode, stdout, stderr}."""
    r = session.run_ps(script)
    return {
        "exitCode": r.status_code,
        "stdout": (r.std_out or b"").decode("utf-8", errors="ignore").strip()[:4000],
        "stderr": (r.std_err or b"").decode("utf-8", errors="ignore").strip()[:4000],
    }


def _ps_checked(session: winrm.Session, body: str) -> dict:
    """Run a PowerShell snippet that must FAIL LOUDLY: a cmdlet error becomes a
    non-zero exit + the message on stderr, instead of a silent exit 0 that only
    shows up later as a failed Get-Printer verify."""
    return _ps(
        session,
        f"$ErrorActionPreference='Stop'; try {{ {body} }} "
        f"catch {{ Write-Error $_; exit 1 }}",
    )


def _psstr(value: str) -> str:
    """Single-quote a value for PowerShell (double any embedded single quote)."""
    return "'" + str(value).replace("'", "''") + "'"


# ---------------- Bundle ----------------


def _tree_hash(files: dict[str, bytes]) -> str:
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(files[rel])
    return h.hexdigest()


def _download_bundle(config: Config, token: str, package_id: str) -> bytes:
    resp = httpx.get(
        f"{config.ingest_url}/api/scan/printer-packages/{package_id}/bundle",
        headers={"Authorization": f"Bearer {token}"},
        timeout=120,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"bundle download failed ({resp.status_code}): {resp.text[:200]}"
        )
    return resp.content


def _extract(zip_bytes: bytes) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            files[name] = zf.read(name)
    return files


# ---------------- Transfer ----------------


def _unc(ip: str, local_path: str) -> str:
    """`C:\\dir\\file` on `ip` → its `\\\\ip\\C$\\dir\\file` admin-share path."""
    drive = local_path[0]
    return rf"\\{ip}\{drive}$" + local_path[2:]


def _smb_put_zip(
    ip: str, user: str, password: str, zip_bytes: bytes, remote_dir: str
) -> str:
    """Copy the bundle zip to the target's admin share in one shot; return its
    on-target local path. Raises on any SMB failure so the caller can fall back."""
    unc_dir = _unc(ip, remote_dir)
    zip_unc = unc_dir + r"\bundle.zip"
    smbclient.makedirs(unc_dir, exist_ok=True, username=user, password=password)
    with smbclient.open_file(
        zip_unc, mode="wb", username=user, password=password
    ) as f:
        f.write(zip_bytes)
    return f"{remote_dir}\\bundle.zip"


def _stage(
    session: winrm.Session,
    prof,
    ip: str,
    zip_bytes: bytes,
    remote_dir: str,
    config: Config,
) -> list[dict]:
    """Get the bundle onto the target and expanded. Prefers SMB (one copy, fast);
    falls back to base64-over-WinRM (slow, universal) when SMB is unavailable or
    refused. Returns step dicts."""
    extract_dir = f"{remote_dir}\\pkg"
    steps = [
        {
            "name": "stage-dir",
            **_ps(
                session,
                f"New-Item -ItemType Directory -Force -Path {_psstr(remote_dir)} | Out-Null",
            ),
        }
    ]
    if any(not _ok(s) for s in steps):
        return steps

    user = _winrm_username(prof.username)
    if config.install_smb_transfer and _SMB_AVAILABLE:
        try:
            zip_local = _smb_put_zip(ip, user, prof.password, zip_bytes, remote_dir)
            steps.append(
                {
                    "name": "smb-copy",
                    "exitCode": 0,
                    "stdout": f"copied {len(zip_bytes)} bytes to C$ via SMB",
                    "stderr": "",
                }
            )
            steps.append(
                {
                    "name": "expand",
                    **_ps(
                        session,
                        f"if (Test-Path {_psstr(extract_dir)}) "
                        f"{{ Remove-Item {_psstr(extract_dir)} -Recurse -Force }}; "
                        f"Expand-Archive -Path {_psstr(zip_local)} "
                        f"-DestinationPath {_psstr(extract_dir)} -Force",
                    ),
                }
            )
            return steps
        except Exception as e:  # noqa: BLE001 — SMB blocked/denied → fall back
            console.print(
                f"  [yellow]SMB copy failed ({type(e).__name__}: {e}); "
                "falling back to WinRM base64 chunks (slow).[/yellow]"
            )
    elif config.install_smb_transfer and not _SMB_AVAILABLE:
        console.print(
            "  [yellow]smbprotocol not installed — using slow WinRM base64 "
            "transfer. Run `uv add smbprotocol` for the fast path.[/yellow]"
        )

    steps.extend(_transfer_zip(session, zip_bytes, remote_dir, _CHUNK))
    return steps


def _transfer_zip(
    session: winrm.Session, zip_bytes: bytes, remote_dir: str, chunk: int
) -> list[dict]:
    """Stage the zip on the target and expand it. Returns step dicts."""
    steps: list[dict] = []
    b64_path = f"{remote_dir}\\bundle.b64"
    zip_path = f"{remote_dir}\\bundle.zip"
    extract_dir = f"{remote_dir}\\pkg"

    steps.append(
        {
            "name": "stage-dir",
            **_ps(
                session,
                f"New-Item -ItemType Directory -Force -Path {_psstr(remote_dir)} | Out-Null; "
                f"if (Test-Path {_psstr(b64_path)}) {{ Remove-Item {_psstr(b64_path)} -Force }}",
            ),
        }
    )

    b64 = base64.b64encode(zip_bytes).decode("ascii")
    for i in range(0, len(b64), chunk):
        part = b64[i : i + chunk]
        step = _ps(
            session,
            f"Add-Content -Path {_psstr(b64_path)} -Value {_psstr(part)} -NoNewline -Encoding Ascii",
        )
        if step["exitCode"] != 0:
            steps.append({"name": f"upload-chunk-{i}", **step})
            return steps

    steps.append(
        {
            "name": "decode-and-expand",
            **_ps(
                session,
                f"[IO.File]::WriteAllBytes({_psstr(zip_path)}, "
                f"[Convert]::FromBase64String((Get-Content {_psstr(b64_path)} -Raw))); "
                f"if (Test-Path {_psstr(extract_dir)}) {{ Remove-Item {_psstr(extract_dir)} -Recurse -Force }}; "
                f"Expand-Archive -Path {_psstr(zip_path)} -DestinationPath {_psstr(extract_dir)} -Force",
            ),
        }
    )
    return steps


# ---------------- Install ----------------


def _ok(step: dict, *extra_ok: int) -> bool:
    return step["exitCode"] in (0, *extra_ok)


def _install_on_target(
    session: winrm.Session, job: dict, remote_dir: str, inf_rel: str
) -> tuple[list[dict], str]:
    """Run the install steps. Returns (steps, outcome)."""
    steps: list[dict] = []
    driver_name = job["packageSnapshot"]["driverName"]
    printer_name = job["printerName"]
    conn = job["connection"]
    extract_dir = f"{remote_dir}\\pkg"
    inf_path = f"{extract_dir}\\" + inf_rel.replace("/", "\\")

    # Shared-queue install: the driver comes from the print server. Just connect.
    if conn.get("type") == "share":
        share = conn.get("sharePath", "")
        steps.append(
            {
                "name": "add-printer-connection",
                **_ps_checked(
                    session,
                    f"Add-Printer -ConnectionName {_psstr(share)}",
                ),
            }
        )
        return steps, "installed"

    # Idempotence: is the printer already there?
    pre = _ps(
        session,
        f"if (Get-Printer -Name {_psstr(printer_name)} -ErrorAction SilentlyContinue) "
        f"{{ 'present' }} else {{ 'absent' }}",
    )
    steps.append({"name": "check-existing", **pre})
    already = "present" in pre["stdout"]

    # 1a) Trust the driver's catalog signer, so pnputil doesn't reject it with
    #     "the publisher ... has not yet been established as trusted". Imports the
    #     .cat's signer cert into the machine's Trusted Publisher + Root stores
    #     (the standard way to deploy a third-party driver silently). Needs admin.
    steps.append(
        {
            "name": "trust-driver-cert",
            **_ps_checked(
                session,
                f"$d = Split-Path {_psstr(inf_path)}; "
                f"$added = 0; "
                f"Get-ChildItem $d -Filter *.cat -ErrorAction SilentlyContinue | ForEach-Object {{ "
                f"$c = (Get-AuthenticodeSignature $_.FullName).SignerCertificate; "
                f"if ($c) {{ foreach ($name in @('TrustedPublisher','Root')) {{ "
                f"$store = New-Object System.Security.Cryptography.X509Certificates.X509Store($name,'LocalMachine'); "
                f"$store.Open('ReadWrite'); $store.Add($c); $store.Close(); $added++ }} }} }}; "
                f"Write-Output \"trusted $added cert-store entries\"",
            ),
        }
    )

    # 1b) Driver store (pnputil). 0 ok, 3010 = reboot-required success, 259 = none added.
    steps.append(
        {
            "name": "pnputil-add-driver",
            **_ps(
                session,
                f"pnputil /add-driver {_psstr(inf_path)} /install; exit $LASTEXITCODE",
            ),
        }
    )

    # 2) Register the print driver by model name (pnputil has staged it).
    steps.append(
        {
            "name": "add-printer-driver",
            **_ps_checked(
                session,
                f"if (-not (Get-PrinterDriver -Name {_psstr(driver_name)} -ErrorAction SilentlyContinue)) "
                f"{{ Add-PrinterDriver -Name {_psstr(driver_name)} }}",
            ),
        }
    )

    port_name = "LocalPort"
    if conn.get("type") == "tcpip":
        host = conn.get("host", "")
        port = conn.get("port") or 9100
        pn = f"IP_{host}"

        # Optional cleanup: a decommissioned device that reused this IP leaves a
        # stale printer+port behind, which makes Add-Printer collide. Remove any
        # printer bound to this address (and any with the name we're about to
        # create), then the now-free ports, so we add cleanly (AC: replace).
        if conn.get("replace"):
            steps.append(
                {
                    "name": "remove-conflicting",
                    **_ps_checked(
                        session,
                        f"$addr={_psstr(host)}; "
                        f"$ports=@(Get-PrinterPort | Where-Object {{ $_.PrinterHostAddress -eq $addr }}); "
                        f"$names=@($ports | ForEach-Object {{ $_.Name }}); "
                        f"Get-Printer | Where-Object {{ ($names -contains $_.PortName) "
                        f"-or ($_.Name -eq {_psstr(printer_name)}) }} | "
                        f"ForEach-Object {{ Remove-Printer -Name $_.Name -ErrorAction SilentlyContinue }}; "
                        f"foreach ($p in $ports) {{ Remove-PrinterPort -Name $p.Name -ErrorAction SilentlyContinue }}",
                    ),
                }
            )
            already = False  # we just removed any same-named printer

        # Ensure a port to this address exists; reuse an existing port's name
        # (under any name) instead of failing on a duplicate address.
        port_step = _ps_checked(
            session,
            f"$addr={_psstr(host)}; $pn={_psstr(pn)}; "
            f"$ex=Get-PrinterPort | Where-Object {{ $_.PrinterHostAddress -eq $addr }} | Select-Object -First 1; "
            f"if ($ex) {{ $ex.Name }} else {{ "
            f"Add-PrinterPort -Name $pn -PrinterHostAddress $addr -PortNumber {int(port)}; $pn }}",
        )
        steps.append({"name": "ensure-port", **port_step})
        out = port_step["stdout"].strip()
        port_name = out.splitlines()[-1].strip() if out else pn

    # 3) Create the printer (unless an equally-named one is already present).
    if not already:
        steps.append(
            {
                "name": "add-printer",
                **_ps_checked(
                    session,
                    f"Add-Printer -Name {_psstr(printer_name)} "
                    f"-DriverName {_psstr(driver_name)} -PortName {_psstr(port_name)}",
                ),
            }
        )

    return steps, ("already-present" if already else "installed")


def _verify(session: winrm.Session, printer_name: str) -> tuple[dict | None, dict]:
    step = _ps(
        session,
        f"Get-Printer -Name {_psstr(printer_name)} | "
        f"Select-Object Name,DriverName,PortName | ConvertTo-Json -Compress",
    )
    verified = None
    if step["exitCode"] == 0 and step["stdout"]:
        try:
            import json

            d = json.loads(step["stdout"])
            verified = {
                "name": d.get("Name"),
                "driverName": d.get("DriverName"),
                "portName": d.get("PortName"),
            }
        except Exception:  # noqa: BLE001
            verified = None
    return verified, {"name": "verify", **step}


def _cleanup(session: winrm.Session, remote_dir: str) -> None:
    try:
        _ps(
            session,
            f"Remove-Item {_psstr(remote_dir)} -Recurse -Force -ErrorAction SilentlyContinue",
        )
    except Exception:  # noqa: BLE001
        pass


# ---------------- List / remove printers ----------------

_PS_LIST = r"""
$ports = @{}
Get-PrinterPort | ForEach-Object { if ($_.PrinterHostAddress) { $ports[$_.Name] = "$($_.PrinterHostAddress)" } }
$def = (Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Default } | Select-Object -First 1 -ExpandProperty Name)
@(Get-Printer | ForEach-Object {
    [ordered]@{
        name        = "$($_.Name)"
        driverName  = "$($_.DriverName)"
        portName    = "$($_.PortName)"
        hostAddress = $ports[$_.PortName]
        shared      = [bool]$_.Shared
        isDefault   = ($_.Name -eq $def)
    }
}) | ConvertTo-Json -Compress -Depth 3
"""


def _list_printers(session: winrm.Session) -> list[dict]:
    step = _ps(session, _PS_LIST)
    if step["exitCode"] != 0:
        raise RuntimeError(
            f"Get-Printer failed: {(step['stderr'] or step['stdout'])[:300]}"
        )
    out = step["stdout"].strip()
    if not out:
        return []
    data = json.loads(out)
    items = data if isinstance(data, list) else [data]
    return [
        {
            "name": d.get("name") or "",
            "driverName": d.get("driverName") or "",
            "portName": d.get("portName") or "",
            "hostAddress": d.get("hostAddress"),
            "shared": bool(d.get("shared")),
            "isDefault": bool(d.get("isDefault")),
        }
        for d in items
    ]


def _remove_printer(session: winrm.Session, printer_name: str) -> list[dict]:
    # Remove the printer AND its port if no other printer still uses it (a plain
    # Remove-Printer leaves the TCP/IP port behind).
    steps = [
        {
            "name": "remove-printer",
            **_ps_checked(
                session,
                f"$p = Get-Printer -Name {_psstr(printer_name)} -ErrorAction SilentlyContinue; "
                f"if ($p) {{ $port = $p.PortName; Remove-Printer -Name {_psstr(printer_name)}; "
                f"if ($port -and -not (Get-Printer | Where-Object {{ $_.PortName -eq $port }})) "
                f"{{ Remove-PrinterPort -Name $port -ErrorAction SilentlyContinue }} }} "
                f"else {{ Write-Output 'not-found' }}",
            ),
        }
    ]
    steps.append(
        {
            "name": "verify-removed",
            **_ps(
                session,
                f"if (Get-Printer -Name {_psstr(printer_name)} -ErrorAction SilentlyContinue) "
                f"{{ 'present' }} else {{ 'absent' }}",
            ),
        }
    )
    return steps


# ---------------- Orchestration ----------------


def _with_session(config: Config, ip: str, do):
    """Resolve creds (qualified), authenticate, and run ``do(session, prof)`` on
    the first profile that authenticates. Raises with every attempt on failure."""
    profiles = resolve_profiles(ip, config)
    if not profiles:
        raise RuntimeError(f"no credential profiles resolved for {ip}")
    tried = ", ".join(f"{p.id} as {_winrm_username(p.username)}" for p in profiles)
    console.print(f"  [dim]auth order for {ip}: {tried}[/dim]")

    attempts: list[str] = []
    for prof in profiles:
        user = _winrm_username(prof.username)
        try:
            session = _session(ip, prof, config)
            probe = _ps(session, "$env:COMPUTERNAME")
            if probe["exitCode"] != 0:
                attempts.append(
                    f"{prof.id} (as {user}): probe exit {probe['exitCode']} {probe['stderr'][:120]}"
                )
                continue
            return do(session, prof)
        except Exception as e:  # noqa: BLE001 — try the next profile
            attempts.append(f"{prof.id} (as {user}): {type(e).__name__}: {e}")
            continue

    raise RuntimeError(
        "failed on all credential profiles -> " + " | ".join(attempts)
    )


def run_install(config: Config, token: str, job: dict) -> dict:
    """Perform one printer op (install / list / remove). Returns a result dict for
    the status endpoint, or raises for a worker-level error (reported as failed)."""
    action = job.get("action") or "install"
    ip = job["targetIp"]

    if action == "list":
        printers = _with_session(config, ip, lambda s, _p: _list_printers(s))
        return {"outcome": "listed", "steps": [], "printers": printers}

    if action == "remove":
        name = job.get("printerName") or ""

        def _do_remove(session, _prof):
            steps = _remove_printer(session, name)
            gone = "absent" in (steps[-1].get("stdout") or "")
            return {"outcome": "removed" if gone else "verify-failed", "steps": steps}

        return _with_session(config, ip, _do_remove)

    # --- install ---
    snapshot = job["packageSnapshot"]
    # Pull + integrity-check the bundle BEFORE touching the target (AC-11).
    zip_bytes = _download_bundle(config, token, job["packageId"])
    files = _extract(zip_bytes)
    actual = _tree_hash(files)
    if actual != snapshot["sha256"]:
        raise RuntimeError(
            f"bundle integrity check failed (expected {snapshot['sha256'][:12]}…, "
            f"got {actual[:12]}…)"
        )

    def _do_install(session, prof):
        remote_dir = f"{config.install_temp_dir}\\{job['id']}"
        steps: list[dict] = _stage(session, prof, ip, zip_bytes, remote_dir, config)
        if any(not _ok(s) for s in steps):
            _cleanup(session, remote_dir)
            return {"outcome": "verify-failed", "steps": steps}
        install_steps, outcome = _install_on_target(
            session, job, remote_dir, snapshot["infPath"]
        )
        steps.extend(install_steps)
        verified, verify_step = _verify(session, job["printerName"])
        steps.append(verify_step)
        _cleanup(session, remote_dir)
        if verified is None:
            return {"outcome": "verify-failed", "steps": steps}
        return {"outcome": outcome, "steps": steps, "verifiedPrinter": verified}

    return _with_session(config, ip, _do_install)
