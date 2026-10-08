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


def _patch_winrm(monkeypatch, plan: dict, attempted: list[str], posture=None):
    """plan: qualified-username -> Exception (raise) | result (main PS_COLLECT run).
    posture: the result the (second) PS_POSTURE call returns on a successful session;
    None means the posture call reports a failure (status 1) → compliance stays None."""

    class FakeSession:
        def __init__(self, action):
            self._action = action

        def run_ps(self, script):
            if "Get-BitLockerVolume" in script:  # the PS_POSTURE call
                return posture if posture is not None else _result(1)
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


def test_posture_second_call_populates_compliance(monkeypatch):
    # Posture (spec 21) is a SEPARATE PS_POSTURE call; its JSON lands on
    # out["compliance"] after the hardware collect succeeds.
    attempted: list[str] = []
    main = _result(0, std_out=json.dumps({"hostname": "PC1"}).encode())
    posture = _result(
        0,
        std_out=json.dumps(
            {
                "bitlocker": "on",
                "defender_realtime": True,
                "defender_sig_age_days": 3,
                "av_product": "Windows Defender",
                "tpm_ready": True,
                "secure_boot": "on",
                "updates_last_days": 9,
                "updates_pending": None,
                "system_drive_pct_used": 72.5,
                "local_admins": ["AWINYC\\Domain Admins", "PC1\\localadmin"],
            }
        ).encode(),
    )
    _patch_winrm(monkeypatch, {"alice": main}, attempted, posture=posture)

    out = collect_windows.collect_windows(
        "10.0.0.5", [5985], [_profile("good", "alice", "pw")], _config()
    )
    c = out["compliance"]
    assert c is not None
    assert c.bitlocker == "on"
    assert c.defender_realtime is True
    assert c.tpm_ready is True
    assert c.updates_last_days == 9
    assert c.system_drive_pct_used == 72.5
    assert c.local_admins == ["AWINYC\\Domain Admins", "PC1\\localadmin"]
    assert out["hostname"] == "PC1"
    assert out["errors"] == []


def test_posture_coerces_single_local_admin_to_a_list(monkeypatch):
    # ConvertTo-Json collapses a 1-element array to a scalar; _parse_posture coerces.
    attempted: list[str] = []
    main = _result(0, std_out=json.dumps({"hostname": "PC1"}).encode())
    posture = _result(0, std_out=json.dumps({"local_admins": "PC1\\onlyadmin"}).encode())
    _patch_winrm(monkeypatch, {"alice": main}, attempted, posture=posture)

    out = collect_windows.collect_windows(
        "10.0.0.5", [5985], [_profile("good", "alice", "pw")], _config()
    )
    assert out["compliance"].local_admins == ["PC1\\onlyadmin"]


def test_posture_failure_leaves_compliance_none_without_failing_collect(monkeypatch):
    # If the posture call fails (older host / filtered token), the hardware collect
    # still succeeds — compliance is None, no error (AC-1).
    attempted: list[str] = []
    main = _result(0, std_out=json.dumps({"hostname": "PC1", "serial": "SN1"}).encode())
    # posture=None → the fake's PS_POSTURE call returns status 1 (failure).
    _patch_winrm(monkeypatch, {"alice": main}, attempted, posture=None)

    out = collect_windows.collect_windows(
        "10.0.0.5", [5985], [_profile("good", "alice", "pw")], _config()
    )
    assert out["hostname"] == "PC1"
    assert out["hardware"] is not None
    assert out["compliance"] is None
    assert out["errors"] == []
