"""Tests for WinRM collection credential handling (collect_windows).

Focus: every candidate profile's failure is reported (not just the last tried),
no-password profiles are skipped without an auth attempt, and the first profile
that authenticates wins. `winrm.Session` is the boundary and is monkeypatched.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import collect_windows


class FakeAuthError(Exception):
    """Stand-in for pywinrm's InvalidCredentialsError etc."""


def _config():
    return SimpleNamespace(
        ports=SimpleNamespace(winrm=5985),
        winrm_scheme="http",
        winrm_transport="ntlm",
    )


def _profile(pid: str, username: str, password: str):
    return SimpleNamespace(id=pid, username=username, password=password)


def _result(status_code: int, std_out: bytes = b"", std_err: bytes = b""):
    return SimpleNamespace(status_code=status_code, std_out=std_out, std_err=std_err)


def _patch_winrm(monkeypatch, plan: dict, attempted: list[str]):
    """plan: qualified-username -> Exception (raise) | result (run_ps returns it)."""

    class FakeSession:
        def __init__(self, action):
            self._action = action

        def run_ps(self, _ps):
            if isinstance(self._action, Exception):
                raise self._action
            return self._action

    def factory(endpoint, auth=None, transport=None, server_cert_validation=None):
        user = auth[0]
        attempted.append(user)
        action = plan[user]
        if isinstance(action, Exception):
            raise action
        return FakeSession(action)

    monkeypatch.setattr(collect_windows.winrm, "Session", factory)


def test_reports_every_profile_failure_not_just_the_last(monkeypatch):
    attempted: list[str] = []
    plan = {
        "alice": FakeAuthError("rejected"),
        "bob": _result(1, std_err=b"Access is denied"),
        # carol has no password → never attempted, so no plan entry.
    }
    _patch_winrm(monkeypatch, plan, attempted)

    profiles = [
        _profile("exc", "alice", "pw1"),
        _profile("psfail", "bob", "pw2"),
        _profile("nopw", "carol", ""),
    ]
    out = collect_windows.collect_windows("10.0.0.5", [5985], profiles, _config())

    assert out["hardware"] is None
    assert out["credential_profile"] is None
    assert len(out["errors"]) == 1
    e = out["errors"][0]
    assert e.startswith("auth_failed_all_profiles (3 profile(s):")
    # Each profile is named, with its qualified username and reason.
    assert "[exc] user='alice': FakeAuthError" in e
    assert "[psfail] user='bob': ps_exit_1 Access is denied" in e
    assert "[nopw] user='carol': no password in .env" in e
    # The no-password profile is skipped, not attempted.
    assert attempted == ["alice", "bob"]


def test_no_password_profile_is_skipped_without_an_auth_attempt(monkeypatch):
    attempted: list[str] = []
    _patch_winrm(monkeypatch, {}, attempted)

    profiles = [_profile("nopw", "carol", "")]
    out = collect_windows.collect_windows("10.0.0.5", [5985], profiles, _config())

    assert attempted == []
    assert "[nopw] user='carol': no password in .env" in out["errors"][0]


def test_first_authenticating_profile_wins_and_no_error(monkeypatch):
    attempted: list[str] = []
    payload = json.dumps(
        {"hostname": "PC1", "serial": "SN1", "model": "OptiPlex"}
    ).encode()
    plan = {
        "alice": FakeAuthError("rejected"),
        "bob": _result(0, std_out=payload),
    }
    _patch_winrm(monkeypatch, plan, attempted)

    profiles = [
        _profile("bad", "alice", "pw1"),
        _profile("good", "bob", "pw2"),
    ]
    out = collect_windows.collect_windows("10.0.0.5", [5985], profiles, _config())

    assert out["credential_profile"] == "good"
    assert out["hostname"] == "PC1"
    assert out["hardware"] is not None and out["hardware"].serial == "SN1"
    assert out["errors"] == []
    assert attempted == ["alice", "bob"]  # stopped at the first that worked


def test_winrm_port_closed_short_circuits(monkeypatch):
    attempted: list[str] = []
    _patch_winrm(monkeypatch, {}, attempted)

    profiles = [_profile("p", "alice", "pw")]
    out = collect_windows.collect_windows("10.0.0.5", [445], profiles, _config())

    assert out["errors"] == ["winrm_port_closed"]
    assert attempted == []
