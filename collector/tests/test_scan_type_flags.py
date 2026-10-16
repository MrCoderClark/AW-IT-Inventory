"""CLI scan type flags: auto-sweep honors toggles; --target bypasses them."""

from __future__ import annotations

from argparse import Namespace

from main import _scan_type_flags


def _args(**kwargs) -> Namespace:
    base = {
        "no_windows": False,
        "no_printers": False,
        "no_phones": False,
        "ignore_discovery_settings": False,
    }
    base.update(kwargs)
    return Namespace(**base)


PHONES_OFF = {"computer": True, "printer": True, "phone": False}


def test_auto_sweep_honors_phones_off():
    no_w, no_p, no_ph = _scan_type_flags(
        _args(), PHONES_OFF, explicit_targets=False
    )
    assert (no_w, no_p, no_ph) == (False, False, True)


def test_explicit_target_bypasses_phones_off():
    no_w, no_p, no_ph = _scan_type_flags(
        _args(), PHONES_OFF, explicit_targets=True
    )
    assert (no_w, no_p, no_ph) == (False, False, False)


def test_ignore_flag_bypasses_phones_off():
    no_w, no_p, no_ph = _scan_type_flags(
        _args(ignore_discovery_settings=True), PHONES_OFF, explicit_targets=False
    )
    assert (no_w, no_p, no_ph) == (False, False, False)


def test_no_phones_cli_flag_still_narrows_a_targeted_scan():
    no_w, no_p, no_ph = _scan_type_flags(
        _args(no_phones=True), PHONES_OFF, explicit_targets=True
    )
    assert (no_w, no_p, no_ph) == (False, False, True)
