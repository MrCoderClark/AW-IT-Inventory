"""Interactive remote terminal sessions (spec 24).

Outbound-only, like the rest of the collector: the worker claims a remote session
from the web app, opens a PowerShell-remoting channel into the target (the same
WinRM transport used to scan it), then relays a live terminal — long-polling for
the owner's input lines and posting the command output back. It never accepts an
inbound connection; the web never connects into the fleet.

This is a command-streaming REPL, **not** a PTY: WinRM/pywinrm runs each input
line as its own ``powershell -command`` invocation, so there is no raw TTY and no
state (cwd, variables, module imports) carried between lines. That honest limit is
spelled out in the spec; a true persistent runspace would need pypsrp/OpenSSH.

The session's whole lifecycle rides the same claim → fence → reaper machinery as
the scan and printer-install queues. The worker carries the fence (``workerId`` +
``claimedAt``) on every call so a reaped/replaced claim is rejected (409) and this
worker drops out instead of writing to a session it no longer owns.
"""

from __future__ import annotations

import base64
import re
import time
from collections.abc import Callable
from xml.sax.saxutils import unescape

import httpx
import winrm
from rich.console import Console

from collect_windows import _winrm_username
from config import Config
from creds import resolve_profiles
from install_printer import _psstr, _session

console = Console()

# The owner's input long-poll holds server-side for ~25s; give the HTTP call room
# past that before it's considered a network error.
_INPUT_POLL_TIMEOUT = 35.0
_OUTPUT_TIMEOUT = 30.0
# One command's captured output cap (the web layer also caps each chunk at 64 KB).
_MAX_OUTPUT = 60_000

# pywinrm runs each line as `powershell -command`, so PowerShell serializes its
# progress / verbose / error streams to stderr as CLIXML (a `#< CLIXML` marker then
# an `<Objs>` blob). Suppress progress at the source, and decode whatever CLIXML is
# left into plain text so a real error still reads cleanly instead of as raw XML.
_PROGRESS_OFF = "$ProgressPreference='SilentlyContinue';"
# Force PowerShell 7's formatter to EMIT ANSI colour even though WinRM captures
# stdout (it otherwise detects redirection and renders plain). A no-op on Windows
# PowerShell 5.1, which has no $PSStyle and no coloured output at all.
_ANSI_ON = "if ($PSStyle) { $PSStyle.OutputRendering = 'Ansi' }"
_CLIXML_STRING_RE = re.compile(r"<S[^>]*>(.*?)</S>", re.DOTALL)

# Each command runs in a fresh `powershell -command`, so cwd/vars don't persist. We
# make at least the working directory sticky: before each line we Set-Location back
# to the tracked cwd, and after it we echo the (possibly changed) location on a line
# led by this control-char marker so it can never collide with real output.
_CWD_MARKER = "\x1e__H2TECS_CWD__"

TokenFn = Callable[[], str]


def _clean_stderr(text: str) -> str:
    """Turn pywinrm's CLIXML stderr into readable text. Keeps any text carried in
    `<S>` string records (errors, warnings) and drops the progress/object scaffolding;
    plain (non-CLIXML) stderr is returned unchanged."""
    if "#< CLIXML" not in text:
        return text
    head, _, rest = text.partition("#< CLIXML")
    strings = _CLIXML_STRING_RE.findall(rest)
    decoded = "".join(strings).replace("_x000D_", "\r").replace("_x000A_", "\n")
    return (head + unescape(decoded)).strip()


# ---------------- WinRM session ----------------


def _open_session(
    config: Config, ip: str
) -> tuple[winrm.Session, str]:
    """Resolve credentials for the target and return the first profile's live
    session plus the qualified username. Probes with ``$env:COMPUTERNAME`` so a
    profile that connects but can't run PowerShell is treated as a failure and the
    next profile is tried. Raises with every attempt on total failure."""
    profiles = resolve_profiles(ip, config)
    if not profiles:
        raise RuntimeError(f"no credential profiles resolved for {ip}")

    attempts: list[str] = []
    for prof in profiles:
        user = _winrm_username(prof.username)
        try:
            session = _session(ip, prof, config)
            probe = session.run_ps("$env:COMPUTERNAME")
            if probe.status_code != 0:
                err = (probe.std_err or b"").decode("utf-8", "ignore").strip()
                attempts.append(f"{prof.id} (as {user}): probe exit {probe.status_code} {err[:120]}")
                continue
            return session, user
        except Exception as e:  # noqa: BLE001 — try the next profile
            attempts.append(f"{prof.id} (as {user}): {type(e).__name__}: {e}")
            continue

    raise RuntimeError("failed on all credential profiles -> " + " | ".join(attempts))


def _run(session: winrm.Session, script: str, use_pwsh: bool):
    """Run a script in PowerShell 7 (`pwsh`, coloured output) when available,
    otherwise Windows PowerShell 5.1 (`powershell.exe`, plain). pwsh is invoked with
    a UTF-16LE base64 payload, the same encoding pywinrm uses for `run_ps`."""
    if use_pwsh:
        enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        return session.run_cmd("pwsh", ["-NoProfile", "-NoLogo", "-EncodedCommand", enc])
    return session.run_ps(script)


def _exec(
    session: winrm.Session, line: str, cwd: str | None, use_pwsh: bool = False
) -> tuple[list[dict], str | None]:
    """Run one input line as a PowerShell command, with the working directory made
    sticky across lines. Returns (output events, new cwd). A command error is
    reported as stderr, not raised — one bad command must not tear the terminal
    down."""
    setloc = (
        f"Set-Location -LiteralPath {_psstr(cwd)} -ErrorAction SilentlyContinue\n"
        if cwd
        else ""
    )
    script = (
        f"{_PROGRESS_OFF}\n"
        f"{_ANSI_ON}\n"
        f"{setloc}"
        f"try {{ {line} }} catch {{ Write-Error $_ }}\n"
        f"'{_CWD_MARKER}' + (Get-Location).Path\n"
    )
    r = _run(session, script, use_pwsh)
    out = (r.std_out or b"").decode("utf-8", "ignore")
    err = _clean_stderr((r.std_err or b"").decode("utf-8", "ignore"))

    # Peel the trailing cwd marker line back off the visible output.
    new_cwd = cwd
    idx = out.rfind(_CWD_MARKER)
    if idx != -1:
        tail = out[idx + len(_CWD_MARKER):].strip()
        if tail:
            new_cwd = tail.splitlines()[0]
        out = out[:idx].rstrip("\r\n")

    events: list[dict] = []
    if out:
        events.append({"channel": "stdout", "data": out[:_MAX_OUTPUT]})
    if err:
        events.append({"channel": "stderr", "data": err[:_MAX_OUTPUT]})
    return events, new_cwd


def _probe_context(session: winrm.Session) -> dict:
    """Read the session's user / host / home / starting directory in one call, to
    seed the prompt. Best-effort: a parse failure just yields empty fields."""
    script = (
        f"{_PROGRESS_OFF}\n"
        "[pscustomobject]@{ user=$env:USERNAME; host=$env:COMPUTERNAME; "
        "home=$HOME; cwd=(Get-Location).Path; "
        "pwsh=[bool](Get-Command pwsh -ErrorAction SilentlyContinue) } "
        "| ConvertTo-Json -Compress"
    )
    try:
        r = session.run_ps(script)
        import json

        data = json.loads((r.std_out or b"").decode("utf-8", "ignore").strip())
        return {
            "user": data.get("user") or "",
            "host": data.get("host") or "",
            "home": data.get("home") or "",
            "cwd": data.get("cwd") or "",
            "pwsh": bool(data.get("pwsh")),
        }
    except Exception:  # noqa: BLE001
        return {"user": "", "host": "", "home": "", "cwd": "", "pwsh": False}


def _abbrev(cwd: str, home: str) -> str:
    """Collapse the home prefix to ``~`` (case-insensitive, Windows paths)."""
    if home and cwd.lower().startswith(home.lower()):
        return "~" + cwd[len(home):]
    return cwd or "~"


def _prompt(theme: str, cwd: str | None, home: str) -> str:
    """Render the shell prompt. `robbyrussell` is oh-my-zsh's default: a bold-green
    arrow then the cyan ~-path. `plain` is the native PowerShell prompt."""
    path = _abbrev(cwd or "", home)
    if theme == "plain":
        return f"PS {cwd or path}> "
    # robbyrussell: green ➜ + cyan path.
    return f"\x1b[1;32m➜\x1b[0m  \x1b[36m{path}\x1b[0m "


# ---------------- Web relay ----------------


def _post_output(
    config: Config,
    token: str,
    session_id: str,
    fence: dict,
    *,
    status: str | None = None,
    events: list[dict] | None = None,
    error: str | None = None,
) -> str:
    """POST to the agent output/status channel (fenced). Returns 'ok', 'gone'
    (404 — session deleted), or 'stale' (409 — claim lost)."""
    body: dict = {"workerId": fence["workerId"], "claimedAt": fence["claimedAt"]}
    if status is not None:
        body["status"] = status
    if events:
        body["events"] = events
    if error is not None:
        body["error"] = error
    resp = httpx.post(
        f"{config.ingest_url}/api/remote/sessions/{session_id}/agent/output",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
        timeout=_OUTPUT_TIMEOUT,
    )
    if resp.status_code == 404:
        return "gone"
    if resp.status_code == 409:
        return "stale"
    if resp.status_code != 200:
        raise RuntimeError(f"output post failed ({resp.status_code}): {resp.text[:200]}")
    return "ok"


def _poll_input(
    config: Config, token: str, session_id: str, fence: dict, after: int
) -> tuple[str, list[dict], str | None]:
    """Long-poll the agent input channel (also the worker heartbeat). Returns
    (outcome, events, status) where outcome is 'ok' | 'gone' (404) | 'stale'
    (409)."""
    resp = httpx.get(
        f"{config.ingest_url}/api/remote/sessions/{session_id}/agent/input",
        params={
            "after": after,
            "workerId": fence["workerId"],
            "claimedAt": fence["claimedAt"],
        },
        headers={"Authorization": f"Bearer {token}"},
        timeout=_INPUT_POLL_TIMEOUT,
    )
    if resp.status_code == 404:
        return "gone", [], None
    if resp.status_code == 409:
        return "stale", [], None
    if resp.status_code != 200:
        raise RuntimeError(f"input poll failed ({resp.status_code}): {resp.text[:200]}")
    data = resp.json()
    return "ok", data.get("events") or [], data.get("status")


def prune_session_events(config: Config, token: str) -> None:
    """Daily retention prune of the remote-session event log (spec 24, AC-7). Called
    from the worker's prune schedule; best-effort, never kills the scheduler."""
    try:
        resp = httpx.post(
            f"{config.ingest_url}/api/remote/sessions/prune",
            json={"retentionDays": config.remote_session_retention_days},
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        resp.raise_for_status()
        pruned = resp.json().get("pruned", 0)
        console.print(f"[dim]retention: pruned {pruned} remote-session event(s).[/dim]")
    except Exception as e:  # noqa: BLE001
        console.print(f"  [yellow]remote-session prune failed:[/yellow] {e}")


# ---------------- Orchestration ----------------


def run_remote_session(
    config: Config, get_token: TokenFn, worker_id: str, claim: dict
) -> None:
    """Run one claimed interactive session to completion. Opens the runspace, marks
    the session active, then relays input→command→output until the owner ends it
    (status `closing`), the session is torn down server-side, or the idle cap trips.
    Never raises: any failure is reported back as a `failed` finish."""
    session_id = claim["id"]
    ip = claim["targetIp"]
    fence = {"workerId": claim["workerId"], "claimedAt": claim["claimedAt"]}
    target = claim.get("assetTag") or ip
    console.print(f"[bold]Remote[/bold] {session_id}: opening terminal to {target} ({ip}) …")

    # 1) Open the runspace. A connect failure fails the session (still 'claimed').
    try:
        session, user = _open_session(config, ip)
    except Exception as e:  # noqa: BLE001
        console.print(f"  [red]connect failed:[/red] {e}")
        _post_output(
            config, get_token(), session_id, fence,
            status="failed", error=f"could not connect to {ip}: {e}"[:800],
        )
        return

    # 2) Mark active (runspace open), then greet with a banner + first prompt.
    if _post_output(config, get_token(), session_id, fence, status="active") != "ok":
        console.print("  [yellow]claim lost before activation; dropping session.[/yellow]")
        return

    ctx = _probe_context(session)
    host = ctx["host"] or target
    home = ctx["home"]
    cwd = ctx["cwd"] or None
    theme = config.remote_session_prompt_theme
    use_pwsh = ctx.get("pwsh", False) and config.remote_session_prefer_pwsh
    shell_label = "PowerShell 7 (colour)" if use_pwsh else "Windows PowerShell 5.1"
    banner = (
        f"Connected to {target} ({ip}) as {user}@{host} — {shell_label}.\r\n"
        "Each line runs as its own command (working directory is kept between lines).\r\n"
    )
    _post_output(
        config, get_token(), session_id, fence,
        events=[
            {"channel": "status", "data": banner},
            {"channel": "stdout", "data": _prompt(theme, cwd, home)},
        ],
    )

    idle_cap = config.remote_session_idle_timeout
    duration_cap = config.remote_session_max_duration
    idle_waited = 0.0
    started = time.monotonic()
    after = 0

    # 3) Relay loop.
    try:
        while True:
            # Hard max-duration ceiling, regardless of activity (spec 24, AC-9).
            if duration_cap and (time.monotonic() - started) >= duration_cap:
                _post_output(
                    config, get_token(), session_id, fence,
                    events=[{"channel": "status", "data": "\r\n[max session duration reached — closed]\r\n"}],
                    status="closed",
                )
                console.print("  [yellow]closed[/yellow] — max duration reached.")
                return

            outcome, events, status = _poll_input(
                config, get_token(), session_id, fence, after
            )
            if outcome == "gone":
                console.print("  [yellow]session gone; stopping.[/yellow]")
                return
            if outcome == "stale":
                console.print("  [yellow]claim lost; another worker owns it now.[/yellow]")
                return

            # Owner ended it (or it's already terminal) → tear down.
            if status == "closing":
                _post_output(
                    config, get_token(), session_id, fence,
                    events=[{"channel": "status", "data": "\r\n[session closed]\r\n"}],
                    status="closed",
                )
                console.print("  [green]closed[/green] by owner.")
                return
            if status in ("canceled", "closed", "failed"):
                console.print(f"  [dim]session {status}; stopping.[/dim]")
                return

            if not events:
                # Idle long-poll returned (status still active). Enforce the idle cap
                # so an abandoned terminal self-closes instead of pinning the worker.
                idle_waited += _INPUT_POLL_TIMEOUT
                if idle_cap and idle_waited >= idle_cap:
                    _post_output(
                        config, get_token(), session_id, fence,
                        events=[{"channel": "status", "data": "\r\n[idle timeout — session closed]\r\n"}],
                        status="closed",
                    )
                    console.print("  [yellow]closed[/yellow] — idle timeout.")
                    return
                continue

            idle_waited = 0.0
            for ev in events:
                if ev.get("direction") != "input":
                    after = max(after, int(ev.get("seq", after)))
                    continue
                line = ev.get("data") or ""
                after = max(after, int(ev.get("seq", after)))
                out_events, cwd = _exec(session, line, cwd, use_pwsh)
                # Put the prompt on its own line after real output (the command's
                # trailing newline was peeled off with the cwd marker). After a
                # no-output command the browser already newlined on Enter, so no
                # extra break — otherwise the prompt would sit on the output's last
                # line.
                lead = "\r\n" if out_events else ""
                out_events.append(
                    {"channel": "stdout", "data": lead + _prompt(theme, cwd, home)}
                )
                if _post_output(
                    config, get_token(), session_id, fence, events=out_events
                ) != "ok":
                    console.print("  [yellow]claim lost mid-session; stopping.[/yellow]")
                    return
    except httpx.HTTPError as e:
        # A transient network blip: report best-effort and let the session reap.
        console.print(f"  [red]network error:[/red] {e}")
        return
    except Exception as e:  # noqa: BLE001 — any worker-level error fails the session
        console.print(f"  [red]session error:[/red] {e}")
        _post_output(
            config, get_token(), session_id, fence,
            status="failed", error=str(e)[:800],
        )
        return
