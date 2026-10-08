"""Tests for the Windows software collection parsing (spec 15, AC-2).

The WinRM/CIM call itself needs a real host, so it is out of scope here; what is
testable is the parsing of the PowerShell JSON into `Software` models: the blank
to None normalization and the filtering of entries with no DisplayName. See
docs/specs/15-software-inventory/index.md (AC-2).
"""

from __future__ import annotations

from collect_windows import _clean, _parse


# ── _clean: registry blanks become None ──────────────────────────────────────


def test_clean_blank_and_whitespace_become_none():
    # covers: AC-2 — the PS "$(...)" coercion yields "" for absent values.
    assert _clean("") is None
    assert _clean("   ") is None
    assert _clean(None) is None
    assert _clean(123) is None


def test_clean_keeps_and_trims_real_values():
    assert _clean("  Google Chrome  ") == "Google Chrome"
    assert _clean("128.0") == "128.0"


# ── _parse: the software list ─────────────────────────────────────────────────


def _base(software):
    """A minimal CIM payload carrying just the software list under test."""
    return {"hostname": "PC-1", "software": software}


def test_parse_extracts_software_entries():
    _, _, hostname, software, _ = _parse(
        _base(
            [
                {
                    "name": "Google Chrome",
                    "version": "128.0.6613.120",
                    "publisher": "Google LLC",
                    "install_date": "20240901",
                }
            ]
        )
    )
    assert hostname == "PC-1"
    assert len(software) == 1
    s = software[0]
    assert s.name == "Google Chrome"
    assert s.version == "128.0.6613.120"
    assert s.publisher == "Google LLC"
    assert s.install_date == "20240901"


def test_parse_normalizes_blank_fields_to_none():
    _, _, _, software, _ = _parse(
        _base([{"name": "7-Zip", "version": "", "publisher": "   ", "install_date": ""}])
    )
    assert len(software) == 1
    assert software[0].name == "7-Zip"
    assert software[0].version is None
    assert software[0].publisher is None
    assert software[0].install_date is None


def test_parse_drops_entries_without_a_name():
    _, _, _, software, _ = _parse(
        _base(
            [
                {"name": "", "version": "1"},
                {"version": "2"},
                {"name": "   ", "version": "3"},
                {"name": "Slack", "version": "4"},
            ]
        )
    )
    assert [s.name for s in software] == ["Slack"]


def test_parse_handles_missing_software_key():
    # A collect that returned no software list at all yields an empty list, never
    # an error (the ingest treats an empty list as "nothing tracked found").
    _, _, _, software, _ = _parse({"hostname": "PC-1"})
    assert software == []
