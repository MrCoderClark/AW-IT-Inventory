"""Tests for connected-monitor EDID parsing (collect_windows._parse_monitors, spec 25).

The PowerShell decode is what runs on the target; here we lock the parse of its JSON:
a list of displays, a single display (PowerShell collapses a 1-element array to an
object), the not-read (None) case, and blank-field normalization.
"""

from __future__ import annotations

from collect_windows import _edid_native_mode, _parse_monitors


def _edid_1080p60() -> list[int]:
    """A 128-byte EDID whose preferred (first) detailed timing is 1920x1080 @ 60 Hz
    (pixel clock 148.5 MHz, Htotal 2200, Vtotal 1125)."""
    edid = [0] * 128
    # pixclk 14850 (×10 kHz) LE, then H active/blank + V active/blank per EDID DTD.
    edid[54:62] = [0x02, 0x3A, 0x80, 0x18, 0x71, 0x38, 0x2D, 0x40]
    return edid


def test_parses_a_list_of_displays():
    data = {
        "monitors": [
            {
                "vendor_code": "DEL",
                "model": "DELL P2217H",
                "serial": "4RDG973R2PWB",
                "product_code": "A0D8",
                "year": 2017,
                "active": True,
                "diagonal_in": 21.5,
            },
            {
                "vendor_code": "SAM",
                "model": "S24",
                "serial": "",
                "year": 0,
                "active": False,
                "diagonal_in": None,
            },
        ]
    }
    mons = _parse_monitors(data)
    assert len(mons) == 2
    assert mons[0].vendor_code == "DEL"
    assert mons[0].serial == "4RDG973R2PWB"
    assert mons[0].year == 2017 and mons[0].diagonal_in == 21.5
    # Blank serial → None; year 0 → None; active preserved.
    assert mons[1].serial is None and mons[1].year is None and mons[1].active is False


def test_coerces_a_single_object_to_a_list():
    data = {"monitors": {"vendor_code": "DEL", "model": "X", "serial": "S1", "year": 2020}}
    mons = _parse_monitors(data)
    assert len(mons) == 1 and mons[0].serial == "S1"


def test_none_or_missing_is_empty():
    assert _parse_monitors({"monitors": None}) == []
    assert _parse_monitors({}) == []


def test_edid_native_mode_parses_preferred_timing():
    assert _edid_native_mode(_edid_1080p60()) == ("1920x1080", 60)


def test_edid_native_mode_handles_bad_input():
    assert _edid_native_mode(None) == (None, None)
    assert _edid_native_mode([0] * 10) == (None, None)  # too short
    assert _edid_native_mode([0] * 128) == (None, None)  # pixel clock 0


def test_parse_monitors_reads_resolution_and_refresh_from_edid():
    data = {
        "monitors": [
            {"vendor_code": "DEL", "model": "U2415", "serial": "S1", "edid": _edid_1080p60()},
            {"vendor_code": "DEL", "model": "No EDID", "serial": "S2"},
        ]
    }
    mons = _parse_monitors(data)
    assert mons[0].resolution == "1920x1080" and mons[0].refresh_hz == 60
    # A display whose host didn't return the raw EDID stays None (graceful).
    assert mons[1].resolution is None and mons[1].refresh_hz is None
