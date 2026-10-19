"""Missing OS-update Search for the worker (spec 31 phase 2).

Dedicated daily (configurable) loop — NOT on the full computer scan. Per host,
time-boxed WUA ``Search("IsInstalled=0")`` over WinRM; posts current missing
KBs to ``/api/ingest/missing-updates``. Read-only against the update service
(no download/install). A host that times out or fails is a gap (prior rows stay).
"""

from __future__ import annotations

import datetime
import json
from concurrent.futures import ThreadPoolExecutor

import httpx
import winrm
from rich.console import Console

from collect_windows import _as_int, _as_list, _clean, _run_ps_timeout, _winrm_username
from config import Config
from creds import resolve_profiles
from sweep import _fetch_computer_targets

console = Console()

# WUA Search for not-installed updates. Keep tiny — EncodedCommand ~8 KB cap.
# KB from KBArticleIDs when present; else the update's Identity.UpdateID (stable).
PS_MISSING_UPDATES = r"""
$ErrorActionPreference='SilentlyContinue'
$m=@()
try{
  $s=(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
  $r=$s.Search('IsInstalled=0')
  foreach($u in @($r.Updates)){
    $kb=$null
    try{ if($u.KBArticleIDs -and $u.KBArticleIDs.Count -gt 0){ $kb='KB'+$u.KBArticleIDs[0] } }catch{}
    if(-not $kb){ try{ $kb="$($u.Identity.UpdateID)" }catch{} }
    if(-not $kb){ continue }
    $sev=$null; try{ if("$($u.MsrcSeverity)"){ $sev="$($u.MsrcSeverity)" } }catch{}
    $sz=$null; try{ $sz=[int64]$u.MaxDownloadSize }catch{}
    $m+=[ordered]@{ kb="$kb"; title="$($u.Title)"; severity=$sev; size_bytes=$sz }
  }
}catch{}
[ordered]@{ count=@($m).Count; missing=@($m) }|ConvertTo-Json -Depth 5 -Compress
"""


def _parse_missing(data: dict) -> tuple[int, list[dict]]:
    """Normalize Search JSON → (count, rows). Duplicate kb ids collapse."""
    seen: set[str] = set()
    rows: list[dict] = []
    for item in _as_list(data.get("missing")):
        if not isinstance(item, dict):
            continue
        kb = _clean(item.get("kb"))
        title = _clean(item.get("title"))
        if not kb or not title or kb in seen:
            continue
        seen.add(kb)
        size = item.get("size_bytes")
        size_i = None
        if isinstance(size, bool):
            size_i = None
        elif isinstance(size, int):
            size_i = size
        elif isinstance(size, float):
            size_i = int(size)
        rows.append(
            {
                "kb": kb,
                "title": title,
                "severity": _clean(item.get("severity")),
                "size_bytes": size_i,
            }
        )
    declared = _as_int(data.get("count"))
    count = declared if declared is not None else len(rows)
    # Prefer actual unique rows if the script's count drifted.
    if count != len(rows):
        count = len(rows)
    return count, rows


def _search_one(ip: str, config: Config) -> dict | None:
    """Run Search on one host. None = gap (timeout / auth / unparseable)."""
    timeout = float(getattr(config, "missing_patch_timeout", 120) or 120)
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
            r = _run_ps_timeout(session, PS_MISSING_UPDATES, timeout)
            if r is None or r.status_code != 0:
                continue
            raw = (r.std_out or b"").decode("utf-8", errors="ignore").strip() or "{}"
            count, missing = _parse_missing(json.loads(raw))
            return {"count": count, "missing": missing}
        except Exception:  # noqa: BLE001 — try next profile; never hang the loop
            continue
    return None


def sample_missing_updates(config: Config, token: str) -> None:
    """One missing-patch pass over every known Computer (spec 31 phase 2)."""
    targets = _fetch_computer_targets(config, token)
    targets = [t for t in targets if t.get("assetId")]
    if not targets:
        return

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    def work(t: dict) -> dict | None:
        data = _search_one(t["ipAddress"], config)
        if data is None:
            return None
        return {
            "assetId": t["assetId"],
            "collected_at": now,
            "count": data["count"],
            "missing": data["missing"],
        }

    with ThreadPoolExecutor(max_workers=min(config.concurrency, 8)) as pool:
        results = [r for r in pool.map(work, targets) if r is not None]

    if not results:
        console.print("[dim]missing-patches: no computers searched.[/dim]")
        return

    resp = httpx.post(
        f"{config.ingest_url}/api/ingest/missing-updates",
        json={"results": results},
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    resp.raise_for_status()
    recorded = resp.json().get("recorded", 0)
    console.print(
        f"[dim]missing-patches: searched {len(results)}/{len(targets)} computer(s), "
        f"recorded {recorded}.[/dim]"
    )
