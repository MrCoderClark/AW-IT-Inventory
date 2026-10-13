"""Tests for connected-monitor EDID parsing (collect_windows._parse_monitors, spec 25).

The PowerShell decode is what runs on the target; here we lock the parse of its JSON:
a list of displays, a single display (PowerShell collapses a 1-element array to an
object), the not-read (None) case, and blank-field normalization.
"""

from __future__ import annotations

from collect_windows import _parse_monitors


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
