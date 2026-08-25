"""Persist a run report as JSON and print a readable console summary."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from rich.console import Console
from rich.table import Table

from config import BASE_DIR, Config
from models import RunReport


def write_report(report: RunReport, config: Config) -> Path:
    out_dir = Path(config.output_dir)
    if not out_dir.is_absolute():
        out_dir = BASE_DIR / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{report.run_id}.json"
    path.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    return path


def print_summary(report: RunReport, saved_to: Path) -> None:
    console = Console()
    by_type = Counter(h.device_type for h in report.hosts)
    collected = sum(
        1 for h in report.hosts if h.hardware or h.printer
    )
    failed = sum(1 for h in report.hosts if h.errors)

    console.print()
    console.rule(f"[bold]Scan {report.run_id}[/bold]")
    console.print(
        f"networks: [cyan]{', '.join(report.networks)}[/cyan]   "
        f"reachable: [bold]{len(report.hosts)}[/bold]   "
        f"windows: {by_type.get('windows', 0)}   "
        f"printers: {by_type.get('printer', 0)}   "
        f"unknown: {by_type.get('unknown', 0)}   "
        f"collected: [green]{collected}[/green]   "
        f"with errors: [yellow]{failed}[/yellow]"
    )

    table = Table(show_lines=False, header_style="bold")
    table.add_column("IP")
    table.add_column("Type")
    table.add_column("Host / Model")
    table.add_column("Detail")
    table.add_column("Cred")
    table.add_column("Status")

    for h in sorted(report.hosts, key=lambda x: x.ip):
        if h.device_type == "windows" and h.hardware:
            name = h.hostname or "?"
            detail = f"{h.hardware.cpu or '?'} · {h.hardware.ram_gb or '?'}GB"
            status = "[green]ok[/green]"
        elif h.device_type == "printer" and h.printer:
            name = (h.printer.model or "printer")[:32]
            detail = f"pages {h.printer.page_count or '?'} · {h.printer.status or '?'}"
            status = "[green]ok[/green]"
        else:
            name = h.hostname or "-"
            detail = ",".join(str(p) for p in h.open_ports)
            status = "[yellow]" + (h.errors[0][:40] if h.errors else "no data") + "[/yellow]"
        table.add_row(
            h.ip, h.device_type, name, detail, h.credential_profile or "-", status
        )

    console.print(table)
    console.print(f"\nReport written to [bold]{saved_to}[/bold]")
    console.print(
        "[dim]dry-run: ingest to the inventory API is not wired up yet.[/dim]"
    )
