"""The long-running collector worker (spec 12).

Outbound-only, like the rest of the collector: it polls the web app for manual
scan jobs, runs them through the same collect pipeline as `scan`, posts the
results through the existing ingest API, then reports the job status back. It
never accepts an inbound connection.

Alongside the manual-scan queue, the worker runs an in-process scheduler
(APScheduler) that checks every manually-entered printer three times a day and
posts the reachability result, plus a daily retention prune (spec 12,
milestone 3).

Usage:
    uv run python main.py worker
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import platform
import time
from zoneinfo import ZoneInfo

import httpx
from rich.console import Console

from config import Config, load_config
from ingest import get_token, post_scan
from models import RunReport
from reachability import run_reachability_check, run_retention_prune

console = Console()

WORKER_VERSION = "0.1.0"


def _worker_id() -> str:
    """A stable-per-process id: host + pid. Two workers on one host differ by
    pid; the claim is atomic regardless (AC-3)."""
    return f"{platform.node()}:{os.getpid()}"


def _jwt_exp(token: str) -> float | None:
    """Read a JWT's `exp` (seconds) without verifying — just to know when to
    refresh our cached access token. Verification happens server-side."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        exp = data.get("exp")
        return float(exp) if exp is not None else None
    except Exception:  # noqa: BLE001
        return None


class TokenCache:
    """Caches the client-credentials access token and refreshes it shortly
    before expiry, so a 5-second poll loop doesn't mint a token every tick."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._token: str | None = None
        self._exp: float = 0.0

    def get(self) -> str:
        now = time.time()
        if self._token and now < self._exp - 60:
            return self._token
        token = get_token(self._config)
        self._token = token
        self._exp = _jwt_exp(token) or (now + 240)
        return token

    def invalidate(self) -> None:
        self._token = None


def _job_config(config: Config, targets: list[str]) -> Config:
    """A copy of the config scoped to just this job's target IPs."""
    cfg = config.model_copy(deep=True)
    cfg.networks = list(targets)
    return cfg


def _summarize(
    targets: list[str], report: RunReport, ingest_res: dict
) -> dict:
    """Build the fixed-shape job result: ingest counters plus a per-target
    status. A target the discovery never reached is recorded as `unreachable`
    and does NOT fail the job (AC-3)."""
    host_by_ip = {h.ip: h for h in report.hosts}
    target_status = []
    for ip in targets:
        host = host_by_ip.get(ip)
        if host is None:
            status = "unreachable"
        elif host.errors:
            status = "error"
        else:
            status = "ok"
        target_status.append({"ip": ip, "status": status})
    return {
        "matched": ingest_res.get("matched", 0),
        "discovered": ingest_res.get("discovered", 0),
        "upserted": ingest_res.get("upserted", 0),
        "skipped": ingest_res.get("skipped", 0),
        "targets": target_status,
    }


def _claim(config: Config, token: str, worker_id: str) -> dict | None:
    """Claim one pending job (or None). Also records our heartbeat server-side."""
    resp = httpx.post(
        f"{config.ingest_url}/api/scan/claim",
        json={"workerId": worker_id, "version": WORKER_VERSION},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    if resp.status_code == 204:
        return None
    if resp.status_code != 200:
        raise RuntimeError(f"claim failed ({resp.status_code}): {resp.text[:200]}")
    return resp.json()  # {id, targets, workerId, claimedAt}


def _post_status(
    config: Config,
    token: str,
    job_id: str,
    worker_id: str,
    claimed_at: str,
    status: str,
    *,
    result: dict | None = None,
    run_id: str | None = None,
    error: str | None = None,
) -> bool:
    """Report a job's status back, fenced by the claim. Returns False on 409
    (the claim is no longer ours — the reaper reclaimed it and another worker
    re-ran it, so we drop our now-stale result rather than overwrite the newer
    one, AC-4)."""
    body: dict = {"workerId": worker_id, "claimedAt": claimed_at, "status": status}
    if result is not None:
        body["result"] = result
    if run_id is not None:
        body["runId"] = run_id
    if error is not None:
        body["error"] = error
    resp = httpx.post(
        f"{config.ingest_url}/api/scan/jobs/{job_id}/status",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    if resp.status_code == 409:
        console.print(
            f"  [yellow]claim lost[/yellow] on job {job_id} — another worker "
            "owns it now; dropping this result."
        )
        return False
    if resp.status_code != 200:
        raise RuntimeError(
            f"status update failed ({resp.status_code}): {resp.text[:200]}"
        )
    return True


def _run_job(config: Config, tokens: TokenCache, worker_id: str, job: dict) -> None:
    # Imported lazily so main.py can import this module at load time without a cycle.
    from main import scan_targets

    job_id = job["id"]
    claimed_at = job["claimedAt"]
    targets = [t for t in (job.get("targets") or []) if isinstance(t, str)]
    console.print(f"[bold]Job[/bold] {job_id}: scanning {len(targets)} target(s) …")

    # Mark running under the claim fence; if we've already lost it, stop here.
    if not _post_status(
        config, tokens.get(), job_id, worker_id, claimed_at, "running"
    ):
        return

    try:
        # Manual jobs always scan their explicit targets: they intentionally
        # bypass the discovery type toggles (spec 13, AC-4). Do not gate this on
        # get_discovery_settings — an off type must never block a targeted scan.
        report = scan_targets(_job_config(config, targets))
        ingest_res = post_scan(config, report)
        result = _summarize(targets, report, ingest_res)
    except Exception as e:  # noqa: BLE001 — a worker-level error fails the job (AC-3)
        console.print(f"  [red]job failed:[/red] {e}")
        _post_status(
            config,
            tokens.get(),
            job_id,
            worker_id,
            claimed_at,
            "failed",
            error=str(e)[:500],
        )
        return

    if _post_status(
        config,
        tokens.get(),
        job_id,
        worker_id,
        claimed_at,
        "succeeded",
        result=result,
        run_id=report.run_id,
    ):
        console.print(
            f"  [green]done[/green] — matched: {result['matched']} · "
            f"discovered: {result['discovered']} · upserted: {result['upserted']}"
        )


def _resolve_tz(config: Config) -> ZoneInfo | None:
    """The explicit schedule zone, so fire times don't drift with the host OS or
    DST (spec 12). None means APScheduler uses the host's local zone."""
    if not config.schedule_timezone:
        return None
    try:
        return ZoneInfo(config.schedule_timezone)
    except Exception:  # noqa: BLE001
        console.print(
            f"[yellow]Unknown schedule_timezone '{config.schedule_timezone}'; "
            "falling back to the host local zone.[/yellow]"
        )
        return None


def _build_scheduler(config: Config, tokens: "TokenCache"):
    """APScheduler with a cron job per configured check time plus a daily prune.

    The reachability jobs use the worker's cached token. The first check of the
    day (``daily_snmp_time``) also does a full SNMP collect (AC-6). Returns the
    started-elsewhere scheduler, or None when scheduling isn't available/needed."""
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.triggers.cron import CronTrigger
    except ImportError:
        console.print(
            "[yellow]APScheduler not installed — printer reachability checks are "
            "disabled. Run `uv add apscheduler` to enable them.[/yellow]"
        )
        return None

    tz = _resolve_tz(config)
    scheduler = BackgroundScheduler(timezone=tz) if tz else BackgroundScheduler()

    def reachability_job(full_snmp: bool) -> None:
        try:
            run_reachability_check(config, tokens.get(), full_snmp=full_snmp)
        except Exception as e:  # noqa: BLE001 — a check must never kill the scheduler
            console.print(f"  [red]reachability job error:[/red] {e}")
            tokens.invalidate()

    def prune_job() -> None:
        try:
            run_retention_prune(config, tokens.get())
        except Exception as e:  # noqa: BLE001
            console.print(f"  [red]retention job error:[/red] {e}")
            tokens.invalidate()

    scheduled: list[str] = []
    for t in config.schedule_times:
        try:
            hour, minute = (int(x) for x in t.split(":"))
        except ValueError:
            console.print(f"[yellow]Skipping malformed schedule time '{t}'.[/yellow]")
            continue
        full = t == config.daily_snmp_time
        scheduler.add_job(
            reachability_job,
            CronTrigger(hour=hour, minute=minute, timezone=tz),
            kwargs={"full_snmp": full},
            id=f"reachability-{t}",
            replace_existing=True,
            misfire_grace_time=300,
        )
        scheduled.append(f"{t}{' (full SNMP)' if full else ''}")

    # Daily retention prune at a quiet hour (AC-10).
    scheduler.add_job(
        prune_job,
        CronTrigger(hour=3, minute=15, timezone=tz),
        id="retention-prune",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    zone = config.schedule_timezone or "host local"
    console.print(
        f"[bold]Reachability schedule[/bold] ({zone}): "
        f"{', '.join(scheduled) if scheduled else 'none'} · prune 03:15."
    )
    return scheduler


def run_worker(args: argparse.Namespace) -> int:
    try:
        config = load_config(args.config)
    except FileNotFoundError:
        console.print(
            f"[red]Config not found:[/red] {args.config}. "
            "Copy config.example.yaml to config.yaml first."
        )
        return 2
    if not config.client_id or not config.client_secret:
        console.print(
            "[red]Missing service-account credentials.[/red] Set "
            f"{config.client_id_env} and {config.client_secret_env} in .env "
            "(the collector account needs the scan:dequeue scope)."
        )
        return 2

    worker_id = _worker_id()
    tokens = TokenCache(config)
    poll = config.worker_poll_interval
    console.print(
        f"[bold]Worker[/bold] {worker_id} (v{WORKER_VERSION}) — polling "
        f"{config.ingest_url} every {poll}s. Ctrl+C to stop."
    )

    scheduler = _build_scheduler(config, tokens)
    if scheduler is not None:
        scheduler.start()

    try:
        while True:
            try:
                token = tokens.get()
                job = _claim(config, token, worker_id)
                if job is None:
                    # Nothing queued; wait a beat before polling again.
                    time.sleep(poll)
                    continue
                _run_job(config, tokens, worker_id, job)
                # Loop straight back to drain any other queued jobs.
            except KeyboardInterrupt:
                raise
            except httpx.HTTPError as e:
                console.print(f"  [red]network error:[/red] {e}; retrying …")
                tokens.invalidate()
                time.sleep(poll)
            except Exception as e:  # noqa: BLE001 — never let one bad poll kill the worker
                console.print(f"  [red]worker error:[/red] {e}; continuing …")
                time.sleep(poll)
    except KeyboardInterrupt:
        console.print("\n[dim]worker stopped.[/dim]")
        return 0
    finally:
        if scheduler is not None:
            scheduler.shutdown(wait=False)
