"""Patch install jobs — WUA OS KBs + winget per-id (spec 31 phase 3).

Claimed by the worker; runs selected items over WinRM. Never reboots the host.
Never ``winget upgrade --all``. Credentials come from config profiles only.
"""

from __future__ import annotations

import json
import time

import httpx
import winrm
from rich.console import Console

from collect_windows import _run_ps_timeout, _winrm_username
from config import Config
from creds import resolve_profiles

console = Console()

# Per-OS-item install. Placeholder __KB__ replaced before run. Keep under EncodedCommand cap.
PS_INSTALL_OS = r"""
$ErrorActionPreference='SilentlyContinue'
$kb='__KB__'
$out=[ordered]@{ok=$false;exitCode=1;rebootRequired=$false;detail='not found'}
try{
  $s=(New-Object -ComObject Microsoft.Update.Session)
  $r=$s.CreateUpdateSearcher().Search('IsInstalled=0')
  $c=New-Object -ComObject Microsoft.Update.UpdateColl
  foreach($u in @($r.Updates)){
    $id=$null
    try{if($u.KBArticleIDs -and $u.KBArticleIDs.Count -gt 0){$id='KB'+$u.KBArticleIDs[0]}}catch{}
    if(-not $id){try{$id="$($u.Identity.UpdateID)"}catch{}}
    if($id -eq $kb){[void]$c.Add($u)}
  }
  if($c.Count -gt 0){
    $d=$s.CreateUpdateDownloader();$d.Updates=$c;$d.Download()|Out-Null
    $i=$s.CreateUpdateInstaller();$i.Updates=$c;$i.AllowSourcePrompts=$false;$res=$i.Install()
    $rc=[int]$res.ResultCode
    $out.exitCode=$rc
    $out.rebootRequired=[bool]$res.RebootRequired
    $out.ok=($rc -eq 2 -or $rc -eq 3)
    $out.detail= if($out.ok){''}else{"ResultCode=$rc"}
  }
}catch{$out.detail="$_"}
$out|ConvertTo-Json -Compress
"""

# Per-app winget upgrade. Placeholder __ID__. InstallLocation winget only (no WindowsApps).
PS_INSTALL_APP = r"""
$ErrorActionPreference='SilentlyContinue'
$id='__ID__'
function FWx{
  try{foreach($p in @(Get-AppxPackage Microsoft.DesktopAppInstaller -EA Stop)){$x=Join-Path $p.InstallLocation 'winget.exe';if(Test-Path -LiteralPath $x){return $x}}}catch{}
  try{foreach($p in @(Get-AppxPackage -AllUsers Microsoft.DesktopAppInstaller -EA Stop)){$x=Join-Path $p.InstallLocation 'winget.exe';if(Test-Path -LiteralPath $x){return $x}}}catch{}
  $c=Get-Command winget -EA SilentlyContinue
  if($c.Source -and $c.Source -notmatch '\\WindowsApps\\winget\.exe$'){return $c.Source}
  return $null
}
$e=FWx
$out=[ordered]@{ok=$false;exitCode=1;rebootRequired=$false;detail='winget not found'}
if($e){
  $p=Start-Process -FilePath $e -ArgumentList @('upgrade','--id',$id,'--silent','--accept-package-agreements','--accept-source-agreements','--disable-interactivity') -Wait -PassThru -NoNewWindow
  $rc=[int]$p.ExitCode
  $out.exitCode=$rc
  # 0 = OK; -1978335138 (0x8A150106) = reboot required (still success for us).
  $out.ok=($rc -eq 0 -or $rc -eq -1978335138)
  $out.rebootRequired=($rc -eq -1978335138)
  $out.detail= if($out.ok){''}else{"exit $rc"}
}
$out|ConvertTo-Json -Compress
"""


def _parse_item(raw: str) -> dict:
    try:
        data = json.loads(raw.strip() or "{}")
    except json.JSONDecodeError:
        return {
            "ok": False,
            "exitCode": None,
            "rebootRequired": False,
            "detail": "unparseable output",
            "outputTail": raw[-400:],
        }
    if not isinstance(data, dict):
        return {
            "ok": False,
            "exitCode": None,
            "rebootRequired": False,
            "detail": "bad json",
            "outputTail": raw[-400:],
        }
    return {
        "ok": bool(data.get("ok")),
        "exitCode": data.get("exitCode"),
        "rebootRequired": bool(data.get("rebootRequired")),
        "detail": str(data.get("detail") or "")[:400],
        "outputTail": str(data.get("detail") or "")[:400],
    }


def _open_session(ip: str, config: Config) -> winrm.Session | None:
    endpoint = f"{config.winrm_scheme}://{ip}:{config.ports.winrm}/wsman"
    for prof in resolve_profiles(ip, config):
        if not prof.password:
            continue
        try:
            session = winrm.Session(
                endpoint,
                auth=(_winrm_username(prof.username), prof.password),
                transport=config.winrm_transport,
                server_cert_validation="ignore",
            )
            # Cheap probe so we don't burn the job timeout on a dead profile.
            r = session.run_ps("$true")
            if r.status_code == 0:
                return session
        except Exception:  # noqa: BLE001
            continue
    return None


def _run_item(
    session: winrm.Session, script: str, timeout: float
) -> dict:
    r = _run_ps_timeout(session, script, timeout)
    if r is None:
        return {
            "ok": False,
            "exitCode": None,
            "rebootRequired": False,
            "detail": "timeout",
            "outputTail": "timeout",
        }
    raw = (r.std_out or b"").decode("utf-8", errors="ignore")
    err = (r.std_err or b"").decode("utf-8", errors="ignore")
    parsed = _parse_item(raw)
    if not parsed.get("ok") and err.strip():
        parsed["outputTail"] = (parsed.get("outputTail") or "") + "\n" + err.strip()[:300]
    return parsed


def run_patch_install(config: Config, job: dict) -> tuple[str, dict]:
    """Run one claimed patch-install job. Returns (status, result)."""
    ip = job["targetIp"]
    selection = job.get("selection") or {}
    os_items = selection.get("os") or []
    app_items = selection.get("apps") or []

    total_timeout = float(getattr(config, "patch_install_timeout", 600) or 600)
    deadline = time.monotonic() + total_timeout
    # Per-item budget: leave room for remaining items; floor 60s.
    n = max(len(os_items) + len(app_items), 1)

    session = _open_session(ip, config)
    if session is None:
        raise RuntimeError(f"no WinRM credentials worked for {ip}")

    items: list[dict] = []
    any_fail = False
    any_reboot = False

    def remaining() -> float:
        return max(deadline - time.monotonic(), 5.0)

    for osu in os_items:
        if remaining() < 10:
            any_fail = True
            items.append(
                {
                    "kind": "os",
                    "id": osu.get("kbId") or "",
                    "ok": False,
                    "rebootRequired": False,
                    "exitCode": None,
                    "outputTail": "job timeout",
                }
            )
            continue
        kb = str(osu.get("kbId") or "").replace("'", "")
        # Escape for PS single-quoted string: double the quotes.
        kb_ps = kb.replace("'", "''")
        script = PS_INSTALL_OS.replace("__KB__", kb_ps)
        per = min(max(remaining() / max(n - len(items), 1), 60.0), remaining())
        parsed = _run_item(session, script, per)
        ok = bool(parsed["ok"])
        if not ok:
            any_fail = True
        if parsed.get("rebootRequired"):
            any_reboot = True
        items.append(
            {
                "kind": "os",
                "id": kb,
                "ok": ok,
                "rebootRequired": bool(parsed.get("rebootRequired")),
                "exitCode": parsed.get("exitCode"),
                "outputTail": parsed.get("outputTail") or parsed.get("detail"),
            }
        )

    for app in app_items:
        if remaining() < 10:
            any_fail = True
            items.append(
                {
                    "kind": "app",
                    "id": app.get("packageId") or "",
                    "ok": False,
                    "rebootRequired": False,
                    "exitCode": None,
                    "outputTail": "job timeout",
                }
            )
            continue
        pid = str(app.get("packageId") or "").replace("'", "")
        pid_ps = pid.replace("'", "''")
        script = PS_INSTALL_APP.replace("__ID__", pid_ps)
        per = min(max(remaining() / max(n - len(items), 1), 60.0), remaining())
        parsed = _run_item(session, script, per)
        ok = bool(parsed["ok"])
        if not ok:
            any_fail = True
        if parsed.get("rebootRequired"):
            any_reboot = True
        items.append(
            {
                "kind": "app",
                "id": pid,
                "ok": ok,
                "rebootRequired": bool(parsed.get("rebootRequired")),
                "exitCode": parsed.get("exitCode"),
                "outputTail": parsed.get("outputTail") or parsed.get("detail"),
            }
        )

    result = {"items": items, "rebootRequired": any_reboot}
    status = "failed" if any_fail or not items else "succeeded"
    return status, result


def prune_patch_installs(config: Config, token: str) -> None:
    """Daily retention prune of old terminal patch-install jobs."""
    try:
        days = int(getattr(config, "deploy_retention_days", 30) or 30)
        resp = httpx.post(
            f"{config.ingest_url}/api/patch-install/prune",
            json={"retentionDays": days},
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        resp.raise_for_status()
        pruned = resp.json().get("pruned", 0)
        console.print(f"[dim]retention: pruned {pruned} old patch-install job(s).[/dim]")
    except Exception as e:  # noqa: BLE001
        console.print(f"  [yellow]patch-install prune failed:[/yellow] {e}")
