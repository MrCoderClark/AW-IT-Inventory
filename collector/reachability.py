"""Printer reachability checks for the worker (spec 12, milestone 3).

Runs on the worker's in-process scheduler: three times a day it probes every
manually-entered printer over TCP and posts the up/down result to the web app,
which records the history and fires the down/recovery emails. The first check of
the day additionally does a full SNMP collect and ingests it, so printer data
stays fresh (AC-6). A daily task prunes old history (AC-10).

Outbound-only like the rest of the collector: it fetches the printer list and
posts results; nothing ever connects into the fleet.
"""

from __future__ import annotations

import asyncio
import datetime
import socket
import time

import httpx
from rich.console import Console

from config import Config

console = Console()


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def tcp_probe(
    ip: str, ports: list[int], timeout: float
) -> tuple[bool, int | None]:
    """Reachable if a TCP connect to ANY of ``ports`` succeeds. Returns
    ``(reachable, latency_ms)`` where latency is the first successful connect."""
    for port in ports:
        start = time.perf_counter()
        try:
            with socket.create_connection((ip, port), timeout=timeout):
                latency = int((time.perf_counter() - start) * 1000)
                return True, latency
        except OSError:
            continue
    return False, None


def _fetch_printer_targets(config: Config, token: str) -> list[dict]:
    """The printers to check: ``[{assetId, ipAddress}, ...]`` (AC-6)."""
    resp = httpx.get(
        f"{config.ingest_url}/api/scan/printers",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    resp.raise_for_status()
    printers = resp.json().get("printers") or []
    return [p for p in printers if isinstance(p, dict) and p.get("ipAddress")]


def _post_reachability(config: Config, token: str, checks: list[dict]) -> dict:
    resp = httpx.post(
        f"{config.ingest_url}/api/scan/reachability",
        json={"checks": checks},
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"reachability post failed ({resp.status_code}): {resp.text[:200]}"
        )
    return resp.json()


def _snmp_reachable_by_ip(config: Config, ips: list[str]) -> dict[str, bool]:
    """Run an SNMP collect on the printer IPs and report which responded. Used by
    the daily full check; failures are per-IP and never raise."""
    from collect_snmp import collect_printers

    try:
        prn_map = asyncio.run(
            collect_printers(
                ips,
                config.snmp_community,
                config.snmp_timeout,
                config.counter_oids,
                config.snmp_version,
            )
        )
    except Exception as e:  # noqa: BLE001 — SNMP is best-effort enrichment
        console.print(f"  [yellow]SNMP collect failed:[/yellow] {e}")
        return {}
    return {ip: (printer is not None) for ip, (printer, _errors) in prn_map.items()}


def _ingest_full_snmp(config: Config, ips: list[str]) -> None:
    """Full SNMP collect + ingest for the printer IPs (AC-6 daily). Reuses the
    same discover/collect/ingest path as a manual scan; errors are logged only."""
    from ingest import post_scan
    from main import scan_targets

    try:
        cfg = config.model_copy(deep=True)
        cfg.networks = list(ips)
        report = scan_targets(cfg, no_windows=True)
        res = post_scan(config, report)
        console.print(
            f"  [green]daily SNMP ingested[/green] — matched: {res.get('matched')} · "
            f"upserted: {res.get('upserted')}"
        )
    except Exception as e:  # noqa: BLE001 — enrichment must never break the check
        console.print(f"  [yellow]daily SNMP ingest failed:[/yellow] {e}")


def run_reachability_check(
    config: Config, token: str, *, full_snmp: bool
) -> None:
    """One reachability sweep over every printer (AC-6). Records exactly one
    check per printer: TCP-probe based, tagged ``snmp`` on the daily full run
    (which also ingests fresh SNMP data), ``tcp`` otherwise. A printer stays
    "reachable" if EITHER TCP or (on the daily run) SNMP answers, so a printer
    with SNMP disabled is never falsely marked down."""
    targets = _fetch_printer_targets(config, token)
    if not targets:
        console.print("[dim]reachability: no printers to check.[/dim]")
        return

    ips = [t["ipAddress"] for t in targets]
    tcp_results = {ip: tcp_probe(ip, config.reachability_ports, config.reachability_timeout) for ip in ips}

    snmp_reach: dict[str, bool] = {}
    if full_snmp:
        console.print(f"[bold]Daily SNMP[/bold] collect for {len(ips)} printer(s) …")
        _ingest_full_snmp(config, ips)
        snmp_reach = _snmp_reachable_by_ip(config, ips)

    checked_at = _now_iso()
    checks: list[dict] = []
    for t in targets:
        ip = t["ipAddress"]
        tcp_ok, latency = tcp_results.get(ip, (False, None))
        reachable = tcp_ok or (snmp_reach.get(ip, False) if full_snmp else False)
        checks.append(
            {
                "assetId": t["assetId"],
                "reachable": reachable,
                "latencyMs": latency,
                "method": "snmp" if full_snmp else "tcp",
                "source": "scheduled",
                "checkedAt": checked_at,
            }
        )

    res = _post_reachability(config, token, checks)
    up = sum(1 for c in checks if c["reachable"])
    console.print(
        f"  [green]reachability[/green] — {up}/{len(checks)} up · "
        f"transitions: {res.get('transitions', 0)} · alerts: {res.get('alertsFired', 0)}"
    )


def run_manual_reachability(
    config: Config, token: str, target_ips: list[str]
) -> None:
    """Record an on-demand TCP reachability check for the printers in a manual
    scan (spec 12 follow-up).

    This is the SAME TCP probe the schedule uses (ports 9100/631/515), tagged
    ``method="tcp"`` / ``source="manual"`` — deliberately NOT the SNMP page-count
    collect the scan already ran. It just refreshes the reachability badge on
    demand, so a newly added or freshly scanned printer doesn't sit "unknown"
    until the next scheduled sweep. Best-effort: only printers among the job's
    targets are probed; non-printer targets are ignored.
    """
    # A manual scan's targets are IPs; tolerate an occasional CIDR/32 suffix.
    wanted = {ip.split("/")[0].strip() for ip in target_ips if ip}
    printers = [
        t for t in _fetch_printer_targets(config, token) if t["ipAddress"] in wanted
    ]
    if not printers:
        return

    checked_at = _now_iso()
    checks: list[dict] = []
    for t in printers:
        reachable, latency = tcp_probe(
            t["ipAddress"], config.reachability_ports, config.reachability_timeout
        )
        checks.append(
            {
                "assetId": t["assetId"],
                "reachable": reachable,
                "latencyMs": latency,
                "method": "tcp",
                "source": "manual",
                "checkedAt": checked_at,
            }
        )

    res = _post_reachability(config, token, checks)
    up = sum(1 for c in checks if c["reachable"])
    console.print(
        f"  [green]reachability (manual)[/green] — {up}/{len(checks)} up · "
        f"transitions: {res.get('transitions', 0)} · alerts: {res.get('alertsFired', 0)}"
    )


def run_counter_report(config: Config, token: str) -> None:
    """Trigger the daily printer page-counter report (spec 14, AC-4).

    Web assembles the rows and sends via aw-auth; the worker just fires the daily
    trigger at ``counter_report_time`` (just after the 08:00 SNMP collect, so the
    day's reading is already in). Outbound-only like the rest of the worker."""
    try:
        resp = httpx.post(
            f"{config.ingest_url}/api/scan/counter-report/send",
            json={},
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        console.print(
            f"[dim]counter report: {data.get('printers', 0)} printer(s) · "
            f"sent={data.get('sent')}.[/dim]"
        )
    except Exception as e:  # noqa: BLE001 — a report failure must never kill the scheduler
        console.print(f"  [yellow]counter report failed:[/yellow] {e}")


def run_retention_prune(config: Config, token: str) -> None:
    """Prune reachability history older than the retention window (AC-10)."""
    try:
        resp = httpx.post(
            f"{config.ingest_url}/api/scan/reachability/prune",
            json={"retentionDays": config.reachability_retention_days},
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        resp.raise_for_status()
        pruned = resp.json().get("pruned", 0)
        console.print(f"[dim]retention: pruned {pruned} old check(s).[/dim]")
    except Exception as e:  # noqa: BLE001
        console.print(f"  [yellow]retention prune failed:[/yellow] {e}")
