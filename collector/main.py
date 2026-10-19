"""H2Tecs collector — agentless fleet scanner (standalone / dry-run).

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

from collect_phone import read_phone
from collect_snmp import collect_printers
from collect_windows import collect_windows
from config import Config, load_config
from creds import resolve_profiles
from discovery import discover
from ingest import get_discovery_settings, post_scan
from models import HostResult, RunReport
from phone_creds import resolve_phone_credential
from report import print_summary, write_report
from cutout_worker import run_cutout_worker
from worker import run_worker

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


def _scan_type_flags(
    args: argparse.Namespace,
    settings: dict[str, bool],
    *,
    explicit_targets: bool,
) -> tuple[bool, bool, bool]:
    """``(no_windows, no_printers, no_phones)`` for this run.

    Auto-sweeps (config.yaml networks, no ``--target``) honor the app discovery
    toggles — phones stay opt-in/off. An explicit ``--target`` / ``--targets-file``
    is a manual scan of hosts the operator named, so it bypasses the toggles
    the same way a worker job does (spec 13 AC-4, spec 27). ``--no-*`` CLI flags
    still narrow either kind of run.
    """
    if args.ignore_discovery_settings or explicit_targets:
        return args.no_windows, args.no_printers, args.no_phones
    return (
        args.no_windows or not settings.get("computer", True),
        args.no_printers or not settings.get("printer", True),
        args.no_phones or not settings.get("phone", False),
    )


def scan_targets(
    config: Config,
    *,
    no_windows: bool = False,
    no_printers: bool = False,
    no_phones: bool = False,
    limit: int | None = None,
) -> RunReport:
    """Discover and collect the hosts on ``config.networks`` and return a report.

    Shared by the ``scan`` command and the ``worker`` command's manual scan jobs
    (spec 12): the caller sets ``config.networks`` to the targets first.
    """
    run_id = datetime.datetime.now().strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:6]
    started = _now()

    console.print(f"[bold]Discovering[/bold] {', '.join(config.networks)} …")
    discovered = discover(config, limit=limit)
    console.print(f"  {len(discovered)} reachable host(s).")

    win_targets = (
        [] if no_windows else [d for d in discovered if d["device_type"] == "windows"]
    )
    prn_targets = (
        [] if no_printers else [d for d in discovered if d["device_type"] == "printer"]
    )
    phn_targets = (
        [] if no_phones else [d for d in discovered if d["device_type"] == "phone"]
    )
    other = [d for d in discovered if d["device_type"] == "unknown"]

    skipped: list[str] = []
    if no_windows:
        n = sum(1 for d in discovered if d["device_type"] == "windows")
        if n:
            skipped.append(f"{n} computer(s)")
    if no_printers:
        n = sum(1 for d in discovered if d["device_type"] == "printer")
        if n:
            skipped.append(f"{n} printer(s)")
    if no_phones:
        n = sum(1 for d in discovered if d["device_type"] == "phone")
        if n:
            skipped.append(f"{n} phone(s)")
    if skipped:
        console.print(
            f"[yellow]  skipped {', '.join(skipped)} "
            "(type switched off — pass --target or --ignore-discovery-settings "
            "to collect them).[/yellow]"
        )

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
                software=res["software"],
                compliance=res["compliance"],
                monitors=res["monitors"],
                updates=res.get("updates"),
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
                config.counter_oids,
                config.snmp_version,
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

    # VoIP phones (spec 27): confirm each 443 candidate via its device TLS cert and
    # read MAC + model — no credentials. A candidate that isn't a Yealink phone is
    # downgraded to "unknown". read_phone is blocking (TLS + HTTPS), so thread it.
    if phn_targets:
        console.print(
            f"[bold]Phone[/bold] identifying {len(phn_targets)} candidate(s) …"
        )

        def do_phone(d: dict) -> HostResult:
            # Phase-2 enrichment runs opportunistically: when the configured
            # per-phone CSV has a credential for this IP, read_phone logs in
            # and fills extension/display name/firmware/serial/register. No
            # credential = phase-1 identity only (MAC + model). Always
            # outbound, read-only.
            credential = resolve_phone_credential(config, d["ip"])
            info = read_phone(
                d["ip"], config.phone_timeout, credential=credential
            )
            errors: list[str] = []
            # A CSV row was present but the phone rejected the login (wrong
            # unique admin password, lockout). Phase 1 still identifies it.
            if credential is not None and (
                info is None
                or not (info.extension or info.display_name or info.serial)
            ):
                errors.append("phone_login_failed")
            return HostResult(
                ip=d["ip"],
                subnet=d["subnet"],
                device_type="phone" if info else "unknown",
                reachable=True,
                open_ports=d["open_ports"],
                phone=info,
                errors=errors,
            )

        with ThreadPoolExecutor(max_workers=min(config.concurrency, 16)) as pool:
            hosts.extend(pool.map(do_phone, phn_targets))

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

    return RunReport(
        run_id=run_id,
        started_at=started,
        finished_at=_now(),
        networks=config.networks,
        hosts=hosts,
    )


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

    # Honor the app's discovery type toggles (spec 13) on an auto-sweep.
    # Explicit --target / --targets-file is a manual scan of named hosts, so it
    # bypasses the toggles the same way worker jobs do (spec 13 AC-4).
    # --ignore-discovery-settings does the same for a sweep of config networks.
    # --no-windows / --no-printers / --no-phones still narrow either kind of run.
    bypass = bool(args.ignore_discovery_settings or targets)
    if bypass:
        settings: dict[str, bool] = {}
        source = "bypassed"
    else:
        settings, source = get_discovery_settings(config)
    no_windows, no_printers, no_phones = _scan_type_flags(
        args, settings, explicit_targets=bypass
    )
    if args.ignore_discovery_settings:
        console.print(
            "[dim]Discovery settings: ignored for this run "
            "(--ignore-discovery-settings); all types on.[/dim]"
        )
    elif targets:
        console.print(
            "[dim]Discovery settings: bypassed (explicit --target, like a "
            "manual job); all types on.[/dim]"
        )
    else:
        console.print(
            f"[dim]Discovery settings ({source}): "
            f"computers {'on' if settings['computer'] else 'off'}, "
            f"printers {'on' if settings['printer'] else 'off'}, "
            f"phones {'on' if settings.get('phone') else 'off'}.[/dim]"
        )
    if no_windows and no_printers and no_phones:
        console.print(
            "[yellow]Every device type is switched off — this sweep will "
            "discover nothing.[/yellow]"
        )

    report = scan_targets(
        config,
        no_windows=no_windows,
        no_printers=no_printers,
        no_phones=no_phones,
        limit=args.limit,
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
    parser = argparse.ArgumentParser(prog="collector", description="H2Tecs fleet scanner")
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
    scan.add_argument("--no-phones", action="store_true")
    scan.add_argument(
        "--ingest",
        action="store_true",
        help="POST results to the inventory API (default is dry-run to JSON).",
    )
    scan.add_argument(
        "--ignore-discovery-settings",
        action="store_true",
        help="Ignore the app's Computers/Printers/Phones discovery switches for "
        "this run. Explicit --target already bypasses them. Still narrowed by "
        "--no-windows / --no-printers / --no-phones.",
    )
    scan.set_defaults(func=run_scan)

    worker = sub.add_parser(
        "worker",
        help="Run the long-running worker: drain manual scan jobs and run the "
        "printer reachability schedule (spec 12).",
    )
    worker.add_argument("--config", default="config.yaml")
    worker.set_defaults(func=run_worker)

    cutout = sub.add_parser(
        "cutout",
        help="Run the rembg background-removal worker (spec 18 phase 3). Needs the "
        "cutout extra: `uv sync --extra cutout`.",
    )
    cutout.add_argument("--config", default="config.yaml")
    cutout.set_defaults(func=run_cutout_worker)
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
