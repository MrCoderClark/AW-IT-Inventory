"""Tests for the WinRM username normalization (fix/collector-local-username).

A local account must reach pywinrm's NTLM as a BARE username — a `.\\name` prefix
is sent as the domain "." literally and the target rejects it. Domain and UPN
formats are left untouched.
"""

from __future__ import annotations

from collect_windows import _as_int, _parse_posture, _winrm_username


def test_strips_local_dot_prefix():
    assert _winrm_username(".\\infotech") == "infotech"


def test_leaves_bare_local_username():
    assert _winrm_username("infotech") == "infotech"


def test_leaves_domain_qualified_username():
    assert _winrm_username("AWINYC\\admin") == "AWINYC\\admin"


def test_leaves_upn_username():
    assert _winrm_username("admin@awinyc.local") == "admin@awinyc.local"


# ── Posture numeric coercion (spec 21 — updates_last_days bug) ────────────────


def test_as_int_coerces_and_rejects():
    assert _as_int(5) == 5
    assert _as_int(5.9) == 5
    assert _as_int("7") == 7
    assert _as_int("x") is None
    assert _as_int(None) is None
    assert _as_int(True) is None  # a posture count is never a bool


def test_as_int_unwraps_receive_job_object():
    # Receive-Job attaches note-properties, so ConvertTo-Json emits an object.
    wrapped = {
        "value": 1,
        "PSComputerName": "localhost",
        "RunspaceId": "2022dda0-bb64-446a-9542-995f74a65447",
        "PSShowComputerName": False,
    }
    assert _as_int(wrapped) == 1
    assert _as_int({"PSComputerName": "localhost"}) is None  # no numeric value


def test_parse_posture_survives_wrapped_updates_last_days():
    """The real-world payload from 192.168.70.20: a wrapped updates_last_days must
    NOT blow up the whole posture (which previously nulled every signal)."""
    data = {
        "bitlocker": "off",
        "defender_realtime": True,
        "defender_sig_age_days": None,
        "av_product": "Security Manager AV Defender Antimalware",
        "tpm_ready": False,
        "secure_boot": "on",
        "updates_last_days": {
            "value": 1,
            "PSComputerName": "localhost",
            "RunspaceId": "x",
            "PSShowComputerName": False,
        },
        "updates_pending": None,
        "system_drive_pct_used": 46,
    }
    c = _parse_posture(data)
    assert c.updates_last_days == 1  # unwrapped, not discarded
    assert c.bitlocker == "off"
    assert c.secure_boot == "on"
    assert c.tpm_ready is False
    assert c.av_product == "Security Manager AV Defender Antimalware"
    assert c.system_drive_pct_used == 46
