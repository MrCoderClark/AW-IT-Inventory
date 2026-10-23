"""Patch install jobs — WUA OS KBs + winget per-id (spec 31 phase 3).

Claimed by the worker; runs selected items over WinRM. Never reboots the host.
Never ``winget upgrade --all``. Credentials come from config profiles only.

When winget fails for a package listed in ``config.app_upgrade_mirrors``, retries
by downloading a versioned installer from the configured mirror URL.
"""

from __future__ import annotations

import json
import re
import time
from urllib.parse import urlparse

import httpx
import winrm
from rich.console import Console

from collect_windows import _run_ps_timeout, _winrm_username
from config import AppUpgradeMirror, Config
from creds import resolve_profiles

console = Console()

# Safe version tokens for mirror URL substitution (no path traversal).
_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")

# Per-OS-item install — start only. Placeholders __KB__, __TAG__.
# WUA Download/Install is E_ACCESSDENIED under WinRM; run as SYSTEM via a
# one-shot scheduled task. Do NOT wait here (large CUs exceed WinRM budgets) —
# Python polls PS_INSTALL_OS_POLL for out.json.
# Match BOTH KB#### and Identity.UpdateID (inventory may store a GUID).
PS_INSTALL_OS_START = r"""
$ErrorActionPreference='Stop'
$kb='__KB__'
$tag='__TAG__'
$dir=Join-Path $env:windir ('Temp\h2tecs-wua\'+$tag)
$work=Join-Path $dir 'work.ps1'
$outf=Join-Path $dir 'out.json'
$task='h2tecs-wua-'+$tag
$out=[ordered]@{ok=$false;started=$false;exitCode=1;rebootRequired=$false;detail=''}
try{
  New-Item -ItemType Directory -Force -Path $dir|Out-Null
  if(Test-Path -LiteralPath $outf){Remove-Item -LiteralPath $outf -Force}
  $inner=@'
$ErrorActionPreference='SilentlyContinue'
$kb=('__KB__').Trim().Trim('{}')
$outf='__OUT__'
$o=[ordered]@{ok=$false;exitCode=1;rebootRequired=$false;detail='not found'}
try{
  $s=New-Object -ComObject Microsoft.Update.Session
  $searcher=$s.CreateUpdateSearcher()
  $c=New-Object -ComObject Microsoft.Update.UpdateColl
  $isGuid=($kb -match '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')
  if($isGuid){
    # Direct UpdateID lookup — IsInstalled=0 often omits GUID-only / bundled rows.
    $r=$searcher.Search("UpdateID='$kb'")
    foreach($u in @($r.Updates)){[void]$c.Add($u)}
  }else{
    $r=$searcher.Search('IsInstalled=0')
    foreach($u in @($r.Updates)){
      $ids=@()
      try{if($u.KBArticleIDs){foreach($k in @($u.KBArticleIDs)){if("$k"){$ids+='KB'+$k}}}}catch{}
      try{$g=("$($u.Identity.UpdateID)").Trim().Trim('{}');if($g){$ids+=$g}}catch{}
      if($ids -contains $kb){[void]$c.Add($u)}
    }
  }
  if($c.Count -eq 0){
    $n=0;try{$n=@($r.Updates).Count}catch{}
    $o.detail="not found (search returned $n)"
  }elseif($c.Count -gt 0 -and $c.Item(0).IsInstalled){
    $o.ok=$true;$o.exitCode=0;$o.detail='already installed'
  }else{
    foreach($u in @($c)){try{if(-not $u.EulaAccepted){[void]$u.AcceptEula()}}catch{}}
    $d=$s.CreateUpdateDownloader();$d.Updates=$c;$d.Download()|Out-Null
    $i=$s.CreateUpdateInstaller();$i.Updates=$c;$i.AllowSourcePrompts=$false
    try{$i.ForceQuiet=$true}catch{}
    $res=$i.Install()
    $rc=[int]$res.ResultCode
    $o.exitCode=$rc
    $o.rebootRequired=[bool]$res.RebootRequired
    $o.ok=($rc -eq 2 -or $rc -eq 3)
    $o.detail= if($o.ok){''}else{"ResultCode=$rc"}
  }
}catch{$o.detail="$_"}
($o|ConvertTo-Json -Compress)|Set-Content -LiteralPath $outf -Encoding utf8
'@
  $inner=$inner.Replace('__KB__',$kb).Replace('__OUT__',$outf.Replace("'","''"))
  Set-Content -LiteralPath $work -Value $inner -Encoding utf8
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -EA SilentlyContinue
  $a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "'+$work+'"')
  $p=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $task -Action $a -Principal $p -Force|Out-Null
  Start-ScheduledTask -TaskName $task
  $out.ok=$true;$out.started=$true;$out.exitCode=0;$out.detail='started'
}catch{$out.detail="$_"}
$out|ConvertTo-Json -Compress
"""

# Poll for SYSTEM-task result. Placeholders __TAG__. Short WinRM call.
PS_INSTALL_OS_POLL = r"""
$ErrorActionPreference='SilentlyContinue'
$tag='__TAG__'
$dir=Join-Path $env:windir ('Temp\h2tecs-wua\'+$tag)
$outf=Join-Path $dir 'out.json'
$task='h2tecs-wua-'+$tag
if(Test-Path -LiteralPath $outf){
  $raw=(Get-Content -LiteralPath $outf -Raw).Trim()
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -EA SilentlyContinue
  Remove-Item -LiteralPath $dir -Recurse -Force -EA SilentlyContinue
  Write-Output $raw
}else{
  Write-Output '{"ok":false,"exitCode":null,"rebootRequired":false,"detail":"pending","pending":true}'
}
"""

# Back-compat alias for tests that still reference the install script body.
PS_INSTALL_OS = PS_INSTALL_OS_START

# Per-app winget upgrade. Placeholder __ID__. InstallLocation winget only (no WindowsApps).
# Redirect winget stdout/err to temp files so only our JSON hits WinRM stdout
# (otherwise winget chatter + CLIXML makes json.loads fail → exitCode null).
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
  $o=[IO.Path]::GetTempFileName();$r=[IO.Path]::GetTempFileName()
  try{
    $p=Start-Process -FilePath $e -ArgumentList @('upgrade','--id',$id,'--silent','--accept-package-agreements','--accept-source-agreements','--disable-interactivity') -Wait -PassThru -NoNewWindow -RedirectStandardOutput $o -RedirectStandardError $r
    $rc=[int]$p.ExitCode
  }finally{Remove-Item -LiteralPath $o,$r -Force -EA SilentlyContinue}
  $out.exitCode=$rc
  # 0 = OK; -1978335138 (0x8A150106) = reboot required; -1978335189 (0x8A15002B) = no upgrade available.
  $out.ok=($rc -eq 0 -or $rc -eq -1978335138 -or $rc -eq -1978335189)
  $out.rebootRequired=($rc -eq -1978335138)
  $out.detail= if($out.ok){''}else{"exit $rc"}
}
$out|ConvertTo-Json -Compress
"""

# Mirror fallback: download installer then silent-run. Placeholders __URL__,
# __ARGS__, __TYPE__ (exe|msi), __TAG__ (job id for temp dir), __HOST__ (log label).
PS_INSTALL_MIRROR = r"""
$ErrorActionPreference='Stop'
$url='__URL__'
$sa='__ARGS__'
$type='__TYPE__'
$tag='__TAG__'
$hostLabel='__HOST__'
$out=[ordered]@{ok=$false;exitCode=1;rebootRequired=$false;detail=''}
$dir=$null
try{
  $dir=Join-Path $env:TEMP ('h2tecs-patch\'+$tag)
  New-Item -ItemType Directory -Force -Path $dir|Out-Null
  $name=[IO.Path]::GetFileName(([Uri]$url).AbsolutePath)
  if(-not $name){$name='installer.bin'}
  $path=Join-Path $dir $name
  (New-Object Net.WebClient).DownloadFile($url,$path)
  if($type -eq 'msi'){
    $p=Start-Process -FilePath 'msiexec.exe' -ArgumentList ("/i `"$path`" "+$sa).Trim() -Wait -PassThru -NoNewWindow
  }else{
    $p=Start-Process -FilePath $path -ArgumentList $sa -Wait -PassThru -NoNewWindow
  }
  $rc=[int]$p.ExitCode
  $out.exitCode=$rc
  $out.ok=($rc -eq 0 -or $rc -eq 3010)
  $out.rebootRequired=($rc -eq 3010)
  $out.detail= if($out.ok){"mirror:$hostLabel"}else{"mirror:$hostLabel exit $rc"}
}catch{$out.detail="mirror:$hostLabel $_"}
finally{if($dir){Remove-Item -LiteralPath $dir -Recurse -Force -EA SilentlyContinue}}
$out|ConvertTo-Json -Compress
"""


def build_mirror_url(template: str, version: str) -> str | None:
    """Substitute ``{version}`` into a mirror URL template, or None if unsafe/invalid."""
    v = (version or "").strip()
    if not v or not _VERSION_RE.match(v):
        return None
    if "{version}" not in template:
        return None
    return template.replace("{version}", v)


def resolve_mirror_installer_type(entry: AppUpgradeMirror, url: str) -> str:
    """Return ``exe`` or ``msi`` from config override or URL extension."""
    if entry.type in ("exe", "msi"):
        return entry.type
    path = urlparse(url).path.lower()
    if path.endswith(".msi"):
        return "msi"
    return "exe"


def _ps_single_quote(s: str) -> str:
    return (s or "").replace("'", "''")


def _extract_json_object(raw: str) -> str | None:
    """Last JSON object in mixed WinRM stdout (winget text / CLIXML noise)."""
    text = (raw or "").strip()
    if not text:
        return None
    # Prefer a whole-line object (our ConvertTo-Json -Compress line).
    for line in reversed(text.splitlines()):
        s = line.strip()
        if s.startswith("{") and s.endswith("}"):
            return s
    # Fallback: last {...} span in the blob.
    end = text.rfind("}")
    if end < 0:
        return None
    start = text.rfind("{", 0, end)
    if start < 0:
        return None
    return text[start : end + 1]


def _parse_item(raw: str) -> dict:
    blob = _extract_json_object(raw)
    if blob is None:
        return {
            "ok": False,
            "exitCode": None,
            "rebootRequired": False,
            "detail": "unparseable output",
            "outputTail": raw[-400:],
        }
    try:
        data = json.loads(blob)
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
        "started": bool(data.get("started")),
        "pending": bool(data.get("pending")),
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


def _run_os_system_install(
    session: winrm.Session,
    config: Config,
    ip: str,
    kb_ps: str,
    os_tag: str,
    budget: float,
) -> dict:
    """Start SYSTEM WUA task (short WinRM), then poll out.json until done/budget."""
    start = PS_INSTALL_OS_START.replace("__KB__", kb_ps).replace("__TAG__", os_tag)
    started = _run_item(session, start, min(90.0, max(budget, 30.0)))
    if not started.get("started"):
        return {
            "ok": False,
            "exitCode": started.get("exitCode"),
            "rebootRequired": False,
            "detail": started.get("detail") or "failed to start SYSTEM task",
            "outputTail": started.get("outputTail")
            or started.get("detail")
            or "failed to start SYSTEM task",
        }

    poll = PS_INSTALL_OS_POLL.replace("__TAG__", os_tag)
    deadline = time.monotonic() + max(budget - 5.0, 30.0)
    sess = session
    while time.monotonic() < deadline:
        time.sleep(5.0)
        left = deadline - time.monotonic()
        if left < 5.0:
            break
        parsed = _run_item(sess, poll, min(45.0, left))
        # Abandoned WinRM poll — reopen and keep waiting.
        if parsed.get("detail") == "timeout":
            fresh = _open_session(ip, config)
            if fresh is not None:
                sess = fresh
            continue
        if parsed.get("detail") == "pending" or parsed.get("pending"):
            continue
        return parsed

    # Best-effort cleanup so a late out.json doesn't linger forever.
    _run_item(sess, poll, 30.0)
    return {
        "ok": False,
        "exitCode": None,
        "rebootRequired": False,
        "detail": "timeout",
        "outputTail": "timeout waiting for SYSTEM WUA task",
    }


def run_patch_install(config: Config, job: dict) -> tuple[str, dict]:
    """Run one claimed patch-install job. Returns (status, result)."""
    ip = job["targetIp"]
    selection = job.get("selection") or {}
    os_items = selection.get("os") or []
    app_items = selection.get("apps") or []

    total_timeout = float(getattr(config, "patch_install_timeout", 1800) or 1800)
    deadline = time.monotonic() + total_timeout
    # Per-item budget: leave room for remaining items; floor 60s (OS uses the
    # full slice via SYSTEM-task polling, not one long WinRM call).
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
        # Unique SYSTEM task / temp dir per OS item.
        os_tag = re.sub(r"[^A-Za-z0-9_-]", "", f"{job.get('id', 'job')}-{kb}")[:48] or "os"
        per = min(max(remaining() / max(n - len(items), 1), 60.0), remaining())
        console.print(
            f"    [dim]OS {kb}: SYSTEM task (up to {per:.0f}s)…[/dim]"
        )
        parsed = _run_os_system_install(session, config, ip, kb_ps, os_tag, per)
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

    mirrors = getattr(config, "app_upgrade_mirrors", None) or {}
    job_tag = re.sub(r"[^A-Za-z0-9_-]", "", str(job.get("id") or "job"))[:36] or "job"

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

        # Winget failed: optional mirror download using frozen "available" version.
        if not ok and pid in mirrors:
            entry = mirrors[pid]
            url = build_mirror_url(entry.url, str(app.get("available") or ""))
            if url:
                itype = resolve_mirror_installer_type(entry, url)
                host = urlparse(url).hostname or "mirror"
                mirror_script = (
                    PS_INSTALL_MIRROR.replace("__URL__", _ps_single_quote(url))
                    .replace("__ARGS__", _ps_single_quote(entry.silent_args or ""))
                    .replace("__TYPE__", itype)
                    .replace("__TAG__", _ps_single_quote(job_tag))
                    .replace("__HOST__", _ps_single_quote(host))
                )
                per_m = min(max(remaining(), 60.0), remaining())
                if remaining() >= 10:
                    console.print(
                        f"    [dim]winget failed for {pid}; trying mirror {host}…[/dim]"
                    )
                    parsed = _run_item(session, mirror_script, per_m)
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
