"""Scheduled computer sweep for the worker.

On its own schedule, WinRM-collects every **manually-entered** computer — a Computer
asset with an IP (computer_details.ipAddress) — and ingests the result. It is a
targeted scan of known hosts the admin listed, NOT a subnet discovery, so it
bypasses the discovery type toggles (like a manual scan): the operator chose these
machines by entering their IPs.

Outbound-only like the rest of the collector: it fetches the target list from the
web app and posts results through the existing ingest path; nothing connects in.
"""

from __future__ import annotations

import httpx
from rich.console import Console

from config import Config

console = Console()


def _fetch_computer_targets(config: Config, token: str) -> list[dict]:
    """The computers to scan: ``[{assetId, ipAddress}, ...]``."""
    resp = httpx.get(
        f"{config.ingest_url}/api/scan/computers",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    resp.raise_for_status()
    computers = resp.json().get("computers") or []
    return [c for c in computers if isinstance(c, dict) and c.get("ipAddress")]


def run_computer_sweep(config: Config, token: str) -> None:
    """One sweep: WinRM-collect every manually-entered computer and ingest it.

    Reuses the same discover/collect/ingest path as a manual scan, scoped to the
    target IPs and to Windows hosts only. Bypasses the discovery toggles on purpose
    — these are explicit targets, so an off Computers switch must not block them.
    """
    # Imported lazily so main.py can import the worker modules without a cycle.
    from ingest import post_scan
    from main import scan_targets

    targets = _fetch_computer_targets(config, token)
    if not targets:
        console.print(
            "[dim]computer sweep: no manually-entered computers to scan.[/dim]"
        )
        return

    ips = [t["ipAddress"] for t in targets]
    console.print(f"[bold]Computer sweep[/bold] — scanning {len(ips)} computer(s) …")

    cfg = config.model_copy(deep=True)
    cfg.networks = list(ips)
    report = scan_targets(cfg, no_printers=True)  # computers only
    res = post_scan(config, report)
    console.print(
        f"  [green]computer sweep ingested[/green] — matched: {res.get('matched')} · "
        f"upserted: {res.get('upserted')} · discovered: {res.get('discovered')}"
    )
