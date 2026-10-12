"""Tests for the interactive remote-session relay (remote_session.py, spec 24).

WinRM and the HTTP relay are mocked; the logic under test is run_remote_session's
loop: open → mark active → run each input line → post output → finish on the
owner's `closing`. A connect failure finishes `failed`; a lost claim (409) stops
without writing a finish it no longer owns.
"""

from __future__ import annotations

import remote_session
from config import Config

CLAIM = {
    "id": "11111111-1111-1111-1111-111111111111",
    "assetTag": "PC-1",
    "targetIp": "192.168.70.5",
    "shell": "powershell",
    "workerId": "w1",
    "claimedAt": "2026-10-12T10:00:00.000Z",
}


class _PsResult:
    def __init__(self, out=b"", err=b"", code=0):
        self.std_out, self.std_err, self.status_code = out, err, code


class _FakeSession:
    def __init__(self, result: _PsResult):
        self._r = result
        self.ran: list[str] = []
        self.cmd: tuple[str, list[str]] | None = None

    def run_ps(self, line: str) -> _PsResult:
        self.ran.append(line)
        return self._r

    def run_cmd(self, command: str, args=None) -> _PsResult:
        self.cmd = (command, list(args or []))
        return self._r


class _Resp:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = ""

    def json(self):
        return self._payload


def _cfg() -> Config:
    return Config(ingest_url="http://web")


def _patch_posts(monkeypatch) -> list[dict]:
    posts: list[dict] = []

    def fake_post(url, json=None, headers=None, timeout=None):
        posts.append(json)
        return _Resp(200)

    monkeypatch.setattr(remote_session.httpx, "post", fake_post)
    return posts


def _patch_gets(monkeypatch, responses: list[_Resp]) -> None:
    seq = iter(responses)

    def fake_get(url, params=None, headers=None, timeout=None):
        return next(seq)

    monkeypatch.setattr(remote_session.httpx, "get", fake_get)


def test_relays_command_then_closes_on_owner_end(monkeypatch):
    posts = _patch_posts(monkeypatch)
    session = _FakeSession(_PsResult(out=b"opus\\me\r\n"))
    monkeypatch.setattr(remote_session, "_open_session", lambda c, ip: (session, "me"))
    _patch_gets(
        monkeypatch,
        [
            _Resp(200, {"events": [{"seq": 1, "direction": "input", "data": "whoami"}], "status": "active"}),
            _Resp(200, {"events": [], "status": "closing"}),
        ],
    )

    remote_session.run_remote_session(_cfg(), lambda: "tok", "w1", CLAIM)

    assert any("whoami" in c for c in session.ran)
    statuses = [p.get("status") for p in posts]
    assert "active" in statuses  # runspace opened
    assert "closed" in statuses  # torn down on owner end
    # The command's stdout was relayed back.
    stdout = [
        e["data"]
        for p in posts
        for e in (p.get("events") or [])
        if e.get("channel") == "stdout"
    ]
    assert any("opus\\me" in d for d in stdout)


def test_connect_failure_finishes_failed(monkeypatch):
    posts = _patch_posts(monkeypatch)

    def boom(_c, _ip):
        raise RuntimeError("Access is denied")

    monkeypatch.setattr(remote_session, "_open_session", boom)

    remote_session.run_remote_session(_cfg(), lambda: "tok", "w1", CLAIM)

    assert posts and posts[-1].get("status") == "failed"
    assert "Access is denied" in posts[-1].get("error", "")


def test_lost_claim_stops_without_finish(monkeypatch):
    posts = _patch_posts(monkeypatch)
    session = _FakeSession(_PsResult(out=b"x"))
    monkeypatch.setattr(remote_session, "_open_session", lambda c, ip: (session, "me"))
    # Active posts fine, then the input poll reports the claim is no longer ours.
    _patch_gets(monkeypatch, [_Resp(409)])

    remote_session.run_remote_session(_cfg(), lambda: "tok", "w1", CLAIM)

    statuses = [p.get("status") for p in posts]
    assert "active" in statuses
    # A stale worker must not write a finish it no longer owns.
    assert "closed" not in statuses and "failed" not in statuses


_PROGRESS_CLIXML = (
    "#< CLIXML\r\n"
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
    '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T>'
    "</TN><MS><I64 N=\"SourceId\">1</I64><PR N=\"Record\"><AV>Preparing modules for first use.</AV>"
    "<AI>0</AI></PR></MS></Obj></Objs>"
)


def test_clean_stderr_drops_progress_clixml():
    # Pure progress noise → nothing to show.
    assert remote_session._clean_stderr(_PROGRESS_CLIXML) == ""
    # Plain stderr is untouched.
    assert remote_session._clean_stderr("boom\r\n") == "boom\r\n"


def test_clean_stderr_keeps_error_text():
    clixml = (
        "#< CLIXML\r\n<Objs xmlns=\"http://schemas.microsoft.com/powershell/2004/04\">"
        '<S S="Error">Get-Item : Cannot find path _x000D__x000A_</S></Objs>'
    )
    out = remote_session._clean_stderr(clixml)
    assert "Cannot find path" in out and "#< CLIXML" not in out


def test_exec_suppresses_progress_and_strips_clixml():
    session = _FakeSession(_PsResult(out=b"ok\r\n", err=_PROGRESS_CLIXML.encode()))
    events, _cwd = remote_session._exec(session, "dir", "C:\\X")

    assert session.ran[0].startswith(remote_session._PROGRESS_OFF)
    channels = {e["channel"] for e in events}
    assert channels == {"stdout"}  # the progress-only stderr was dropped


def test_exec_tracks_cwd_and_hides_marker():
    out = b"opus\\me\r\n" + (remote_session._CWD_MARKER + "C:\\Users\\me\\Documents\r\n").encode()
    session = _FakeSession(_PsResult(out=out))
    events, cwd = remote_session._exec(session, "cd Documents", "C:\\Users\\me")

    assert cwd == "C:\\Users\\me\\Documents"
    stdout = "".join(e["data"] for e in events if e["channel"] == "stdout")
    assert "opus\\me" in stdout and remote_session._CWD_MARKER not in stdout
    # The tracked cwd is restored before the user's line runs.
    assert "Set-Location -LiteralPath 'C:\\Users\\me'" in session.ran[0]


def test_exec_routes_through_pwsh_when_requested():
    session = _FakeSession(_PsResult(out=b"x\r\n"))
    remote_session._exec(session, "dir", "C:\\X", use_pwsh=True)

    assert session.cmd is not None
    cmd, args = session.cmd
    assert cmd == "pwsh" and "-EncodedCommand" in args
    assert not session.ran  # did not fall back to powershell.exe


def test_prompt_robbyrussell_abbreviates_home():
    p = remote_session._prompt("robbyrussell", "C:\\Users\\me\\Documents", "C:\\Users\\me")
    assert "\u279c" in p and "~\\Documents" in p
    assert remote_session._prompt("plain", "C:\\Temp", "C:\\Users\\me") == "PS C:\\Temp> "


def test_idle_timeout_closes_session(monkeypatch):
    posts = _patch_posts(monkeypatch)
    session = _FakeSession(_PsResult(out=b""))
    monkeypatch.setattr(remote_session, "_open_session", lambda c, ip: (session, "me"))
    # Idle poll returns no events; a tiny idle cap makes one empty poll trip it.
    monkeypatch.setattr(remote_session, "_INPUT_POLL_TIMEOUT", 1.0)
    _patch_gets(monkeypatch, [_Resp(200, {"events": [], "status": "active"})])
    cfg = Config(ingest_url="http://web", remote_session_idle_timeout=0.5)

    remote_session.run_remote_session(cfg, lambda: "tok", "w1", CLAIM)

    assert posts[-1].get("status") == "closed"
