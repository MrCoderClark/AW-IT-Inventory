"""rembg background-removal worker (spec 18, phase 3).

A separate long-running process (its own `cutout` command) because rembg pulls heavy
dependencies — onnxruntime plus a model download — that not every deploy wants.
Outbound-only like the rest of the collector: it polls the web app for pending
cut-out jobs, runs rembg on the returned image bytes, and posts the transparent PNG
back. Nothing ever connects in.

Usage:
    uv sync --extra cutout        # install rembg
    uv run python main.py cutout
"""

from __future__ import annotations

import argparse
import base64
import time

import httpx
from rich.console import Console

from config import load_config
from worker import WORKER_VERSION, TokenCache, _worker_id

console = Console()


def _remove_background(image_bytes: bytes) -> bytes:
    """Run rembg → a PNG with the background removed. Imported lazily so the heavy
    dependency is only required when this worker actually runs."""
    try:
        from rembg import remove
    except ImportError as e:  # pragma: no cover - exercised only without the extra
        raise RuntimeError(
            "rembg is not installed. Install the cutout extra "
            "(`uv sync --extra cutout`), then re-run `python main.py cutout`."
        ) from e
    return remove(image_bytes)


def _claim(config, token: str, worker_id: str) -> dict | None:
    resp = httpx.post(
        f"{config.ingest_url}/api/media/cutout/claim",
        json={"workerId": worker_id},
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    if resp.status_code == 204:
        return None
    if resp.status_code != 200:
        raise RuntimeError(f"claim failed ({resp.status_code}): {resp.text[:200]}")
    return resp.json()


def _post_result(
    config,
    token: str,
    media_id: str,
    worker_id: str,
    *,
    ok: bool,
    cutout_b64: str | None = None,
    error: str | None = None,
) -> bool:
    body: dict = {"workerId": worker_id, "status": "done" if ok else "failed"}
    if ok and cutout_b64 is not None:
        body["cutoutB64"] = cutout_b64
    if error:
        body["error"] = error[:500]
    resp = httpx.post(
        f"{config.ingest_url}/api/media/cutout/{media_id}/result",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    # 409 = claim lost (the job was reaped and re-claimed); drop our stale result.
    if resp.status_code == 409:
        console.print(f"  [yellow]claim lost[/yellow] on {media_id}; dropping result.")
        return False
    if resp.status_code != 200:
        raise RuntimeError(f"result failed ({resp.status_code}): {resp.text[:200]}")
    return True


def process_one(config, tokens: TokenCache, worker_id: str, job: dict) -> None:
    """Process one claimed cut-out job: rembg the image, post the PNG back; any
    failure is reported as a failed job (retryable), never crashes the worker."""
    media_id = job.get("mediaId")
    if not media_id:
        return
    img_b64 = job.get("imageB64")
    if not img_b64:
        # The claim found the original missing — nothing to process, fail it.
        console.print(f"  [yellow]job {media_id}: original missing — failing.[/yellow]")
        _post_result(config, tokens.get(), media_id, worker_id, ok=False, error="original missing")
        return

    console.print(f"[bold]Cut-out[/bold] {media_id}: removing background …")
    try:
        cutout = _remove_background(base64.b64decode(img_b64))
        out_b64 = base64.b64encode(cutout).decode("ascii")
        if _post_result(config, tokens.get(), media_id, worker_id, ok=True, cutout_b64=out_b64):
            console.print(f"  [green]done[/green] — {media_id}")
    except Exception as e:  # noqa: BLE001 — a bad job is failed, not fatal
        console.print(f"  [red]cut-out failed:[/red] {e}")
        _post_result(config, tokens.get(), media_id, worker_id, ok=False, error=str(e))


def run_cutout_worker(args: argparse.Namespace) -> int:
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
            "[red]Missing service-account credentials.[/red] Set the client id/secret "
            "in .env (the account needs the scan:dequeue scope)."
        )
        return 2

    worker_id = _worker_id()
    tokens = TokenCache(config)
    poll = config.cutout_poll_interval
    console.print(
        f"[bold]Cut-out worker[/bold] {worker_id} (v{WORKER_VERSION}) — polling "
        f"{config.ingest_url} every {poll}s. Ctrl+C to stop."
    )

    try:
        while True:
            try:
                job = _claim(config, tokens.get(), worker_id)
                if job is None:
                    time.sleep(poll)
                    continue
                process_one(config, tokens, worker_id, job)
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
        console.print("\n[dim]cut-out worker stopped.[/dim]")
        return 0
