"""OPUS collector — agentless fleet scanner (standalone / dry-run).

Discovers hosts on the configured subnets, resolves credentials, collects
hardware/health over WinRM and printers over SNMP, and writes a JSON report.
Ingest to the inventory API is added in a later step.

Usage:
    uv run python main.py scan
    uv run python main.py scan --network 192.168.72.0/24 --limit 50
    uv run python main.py scan --no-printers
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from rich.console import Console

from collect_snmp import collect_printers
from collect_windows import collect_windows
from config import load_config
from creds import resolve_profiles
from discovery import discover
from ingest import post_scan
from models import HostResult, RunReport
from report import print_summary, write_report

console = Console()


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _collect_targets(args: argparse.Namespace) -> list[str]:
    """Merge --target (repeatable/comma-separated), --targets-file and --network
    into an ordered, de-duplicated list of IPs/CIDRs."""
    targets: list[str] = []
    for value in args.target or []:
        targets += [x.strip() for x in value.split(",") if x.strip()]
    if args.targets_file:
        path = Path(args.targets_file)
        if not path.exists():
            console.print(f"[yellow]targets-file not found:[/yellow] {path}")
        else:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    targets.append(line)
    if args.network:  # backward-compatible single target
        targets.append(args.network)

    seen: set[str] = set()
    ordered: list[str] = []
    for t in targets:
        if t not in seen:
            seen.add(t)
            ordered.append(t)
    return ordered


def run_scan(args: argparse.Namespace) -> int:
    try:
        config = load_config(args.config)
    except FileNotFoundError:
        console.print(
            f"[red]Config not found:[/red] {args.config}. "
            "Copy config.example.yaml to config.yaml and set your networks/profiles."
        )
        return 2

    targets = _collect_targets(args)
    if targets:
        config.networks = targets
    if not config.networks:
        console.print(
            "[red]No targets.[/red] Use --target / --targets-file, or set "
            "`networks:` in config.yaml."
        )
        return 2

    run_id = datetime.datetime.now().strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:6]
    started = _now()

    console.print(f"[bold]Discovering[/bold] {', '.join(config.networks)} …")
    discovered = discover(config, limit=args.limit)
    console.print(f"  {len(discovered)} reachable host(s).")

    win_targets = (
        [] if args.no_windows else [d for d in discovered if d["device_type"] == "windows"]
    )
    prn_targets = (
        [] if args.no_printers else [d for d in discovered if d["device_type"] == "printer"]
    )
    other = [d for d in discovered if d["device_type"] == "unknown"]

    hosts: list[HostResult] = []

    # Windows hosts (threaded — WinRM is blocking).
    if win_targets:
        console.print(f"[bold]WinRM[/bold] collecting {len(win_targets)} Windows host(s) …")

        def do_windows(d: dict) -> HostResult:
            profiles = resolve_profiles(d["ip"], config)
            res = collect_windows(d["ip"], d["open_ports"], profiles, config)
            return HostResult(
                ip=d["ip"],
                subnet=d["subnet"],
                device_type="windows",
                reachable=True,
                open_ports=d["open_ports"],
                hostname=res["hostname"],
                credential_profile=res["credential_profile"],
                hardware=res["hardware"],
                health=res["health"],
                errors=res["errors"],
            )

        with ThreadPoolExecutor(max_workers=min(config.concurrency, 16)) as pool:
            hosts.extend(pool.map(do_windows, win_targets))

    # Printers (async SNMP).
    if prn_targets:
        console.print(f"[bold]SNMP[/bold] collecting {len(prn_targets)} printer(s) …")
        prn_map = asyncio.run(
            collect_printers(
                [d["ip"] for d in prn_targets],
                config.snmp_community,
                config.snmp_timeout,
            )
        )
        for d in prn_targets:
            printer, errors = prn_map.get(d["ip"], (None, ["not_scanned"]))
            hosts.append(
                HostResult(
                    ip=d["ip"],
                    subnet=d["subnet"],
                    device_type="printer",
                    reachable=True,
                    open_ports=d["open_ports"],
                    printer=printer,
                    errors=errors,
                )
            )

    for d in other:
        hosts.append(
            HostResult(
                ip=d["ip"],
                subnet=d["subnet"],
                device_type="unknown",
                reachable=True,
                open_ports=d["open_ports"],
            )
        )

    report = RunReport(
        run_id=run_id,
        started_at=started,
        finished_at=_now(),
        networks=config.networks,
        hosts=hosts,
    )
    saved = write_report(report, config)
    print_summary(report, saved)

    if args.ingest:
        try:
            console.print("\n[bold]Ingesting[/bold] to the inventory API …")
            result = post_scan(config, report)
            console.print(
                f"  [green]ingested[/green] — matched: {result.get('matched')} · "
                f"discovered: {result.get('discovered')} · "
                f"upserted: {result.get('upserted')} · skipped: {result.get('skipped')}"
            )
        except Exception as e:  # noqa: BLE001
            console.print(f"  [red]ingest failed:[/red] {e}")
            return 1
    else:
        console.print(
            "\n[dim]dry-run — JSON only. Re-run with --ingest to post to the "
            "inventory API.[/dim]"
        )

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="collector", description="OPUS fleet scanner")
    sub = parser.add_subparsers(dest="command")
    scan = sub.add_parser("scan", help="Discover and scan the fleet (dry-run)")
    scan.add_argument("--config", default="config.yaml")
    scan.add_argument(
        "--target",
        action="append",
        metavar="IP|CIDR",
        help="Scan specific target(s): an IP or CIDR. Repeatable and/or "
        "comma-separated. Overrides config networks.",
    )
    scan.add_argument(
        "--targets-file",
        metavar="PATH",
        help="File with one IP/CIDR per line (# comments allowed).",
    )
    scan.add_argument(
        "--network", help="Single IP/CIDR to scan (alias of --target)."
    )
    scan.add_argument("--limit", type=int, help="Cap number of IPs probed (testing)")
    scan.add_argument("--no-windows", action="store_true")
    scan.add_argument("--no-printers", action="store_true")
    scan.add_argument(
        "--ingest",
        action="store_true",
        help="POST results to the inventory API (default is dry-run to JSON).",
    )
    scan.set_defaults(func=run_scan)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not getattr(args, "func", None):
        parser.print_help()
        return 1
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
