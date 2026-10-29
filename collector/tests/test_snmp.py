"""Regression tests for SNMP printer collection (collect_snmp.py).

The Canon iR1750 answers SNMP v1 only and does not implement
prtGeneralSerialNumber. The collector used to bundle sysDescr, serial, and status
into one GET; under v1 a GET that contains a missing OID fails the whole request
(noSuchName), so that printer read as `snmp_no_response` and neither its identity
nor its page counter reached ingest. These tests pin the fixed behavior: identity
and the page counter survive a missing serial. See
docs/specs/14-printer-page-counter/index.md (AC-1, AC-2).
"""

from __future__ import annotations

import asyncio

import collect_snmp
from collect_snmp import OIDS, _parse_error_bits, collect_printer


def _run(coro):
    return asyncio.run(coro)


def _fake_snmp(present: dict[str, str], *, v1_only: bool = False):
    """A stand in for `_snmp_get` with real SNMP v1 semantics. It tries each
    requested version in order; a v1_only device stays silent on v2c; and a GET
    that includes ANY missing OID fails the whole request, so it falls through to
    the next version (and returns None when none answer)."""

    async def fake(ip, community, timeout, oids, versions):
        for mp in versions:
            if v1_only and mp == collect_snmp._MP_V2C:
                continue  # device drops v2c, only speaks v1
            if all(o in present for o in oids):
                return [present[o] for o in oids]
            # a missing OID fails this whole request; try the next version
        return None

    return fake


def _fake_walk(table: dict[str, dict[str, str]] | None = None):
    """Stand-in for ``_snmp_walk_column``. ``table`` maps base_oid to
    {suffix: value}; absent base OIDs return an empty dict."""
    data = table or {}

    async def fake(ip, community, timeout, base_oid, versions, max_rows=32):
        return dict(data.get(base_oid, {}))

    return fake


def _patch_snmp(monkeypatch, present, *, v1_only=False, walk_table=None):
    """Patch both ``_snmp_get`` and ``_snmp_walk_column`` in one call."""
    monkeypatch.setattr(collect_snmp, "_snmp_get", _fake_snmp(present, v1_only=v1_only))
    monkeypatch.setattr(collect_snmp, "_snmp_walk_column", _fake_walk(walk_table))


def test_v1_printer_missing_serial_still_reads_identity_and_counter(monkeypatch):
    # covers: the Canon iR1750 (v1 only, no prtGeneralSerialNumber). The collector
    # must still return identity plus page_count, not snmp_no_response.
    present = {
        OIDS["description"]: "Canon iR1750 /P",
        OIDS["status"]: "1",  # hrPrinterStatus: other
        OIDS["page_count"]: "581851",  # standard prtMarkerLifeCount
        # OIDS["serial"] is intentionally absent (the missing OID)
    }
    _patch_snmp(monkeypatch, present, v1_only=True)

    printer, errors = _run(collect_printer("192.168.70.203", "public", 0.1))

    assert errors == []
    assert printer is not None
    assert printer.description == "Canon iR1750 /P"
    assert printer.serial is None  # the missing OID stays blank
    assert printer.page_count == 581851  # the counter still reads
    assert printer.status == "other"
    assert printer.errors == []


def test_no_snmp_answer_returns_snmp_no_response(monkeypatch):
    # covers: a device that answers on no version (not even sysDescr) is reported
    # as snmp_no_response, the reachability anchor failing closed.
    _patch_snmp(monkeypatch, {}, v1_only=True)

    printer, errors = _run(collect_printer("10.0.0.9", "public", 0.1))

    assert printer is None
    assert errors == ["snmp_no_response"]


def test_healthy_v2c_printer_reads_all_fields(monkeypatch):
    # covers: the common case still works. Every OID present over v2c.
    present = {
        OIDS["description"]: "HP LaserJet",
        OIDS["serial"]: "SN123",
        OIDS["status"]: "3",  # idle
        OIDS["page_count"]: "42",
    }
    _patch_snmp(monkeypatch, present)

    printer, errors = _run(collect_printer("10.0.0.5", "public", 0.1))

    assert errors == []
    assert printer is not None
    assert printer.serial == "SN123"
    assert printer.page_count == 42
    assert printer.status == "idle"
    assert printer.errors == []


# ── hrPrinterDetectedErrorState bitmask parsing ──────────────────────────────


def test_parse_error_bits_empty():
    assert _parse_error_bits(b"\x00\x00") == []


def test_parse_error_bits_single_byte_zero():
    assert _parse_error_bits(b"\x00") == []


def test_parse_error_bits_low_toner():
    # bit 2 = lowToner → byte 0, mask 0x20
    assert _parse_error_bits(b"\x20\x00") == ["lowToner"]


def test_parse_error_bits_multiple():
    # lowPaper (0x80) + doorOpen (0x08) = byte 0 0x88; outputFull (0x08) = byte 1
    assert _parse_error_bits(b"\x88\x08") == ["lowPaper", "doorOpen", "outputFull"]


def test_parse_error_bits_all_set():
    flags = _parse_error_bits(b"\xff\xfe")
    assert "lowPaper" in flags
    assert "noToner" in flags
    assert "jammed" in flags
    assert "overduePreventMaint" in flags
    assert len(flags) == 15


def test_parse_error_bits_short_bytes():
    # Only 1 byte: only byte-0 bits are decoded, byte-1 bits are skipped.
    assert _parse_error_bits(b"\x04") == ["jammed"]


def test_collect_printer_passes_error_flags(monkeypatch):
    # _snmp_get returns str(OctetString) which decodes the raw bytes via ISO-8859-1.
    # 0x28 = lowToner (0x20) + doorOpen (0x08); _read_error_state encodes back to
    # latin-1 bytes and parses the bitmask.
    present = {
        OIDS["description"]: "HP LaserJet",
        OIDS["serial"]: "SN999",
        OIDS["status"]: "3",
        OIDS["page_count"]: "100",
        OIDS["error_state"]: "\x28\x00",
    }
    _patch_snmp(monkeypatch, present)

    printer, errors = _run(collect_printer("10.0.0.6", "public", 0.1))
    assert printer is not None
    assert printer.errors == ["lowToner", "doorOpen"]


# ── prtMarkerSuppliesTable + prtInputTable (supply levels & paper trays) ────


def test_collect_printer_reads_supply_levels(monkeypatch):
    present = {
        OIDS["description"]: "Canon iR-ADV 4751",
        OIDS["serial"]: "SN100",
        OIDS["status"]: "3",
        OIDS["page_count"]: "167000",
    }
    walk_table = {
        collect_snmp._SUPPLY_DESC_OID: {"1": "Black Toner", "2": "Drum Unit"},
        collect_snmp._SUPPLY_MAX_OID: {"1": "100", "2": "200"},
        collect_snmp._SUPPLY_LEVEL_OID: {"1": "45", "2": "180"},
    }
    _patch_snmp(monkeypatch, present, walk_table=walk_table)

    printer, errors = _run(collect_printer("10.0.0.7", "public", 0.1))
    assert printer is not None
    assert len(printer.supplies) == 2
    assert printer.supplies[0].name == "Black Toner"
    assert printer.supplies[0].level_pct == 45
    assert printer.supplies[0].level_status == "ok"
    assert printer.supplies[1].name == "Drum Unit"
    assert printer.supplies[1].level_pct == 90
    assert printer.supplies[1].level_status == "ok"


def test_collect_printer_reads_paper_trays(monkeypatch):
    present = {
        OIDS["description"]: "Canon iR-ADV 4751",
        OIDS["serial"]: "SN100",
        OIDS["status"]: "3",
        OIDS["page_count"]: "167000",
    }
    walk_table = {
        collect_snmp._TRAY_DESC_OID: {"1": "Tray 1", "2": "Tray 2"},
        collect_snmp._TRAY_MEDIA_OID: {"1": "A4", "2": "Letter"},
        collect_snmp._TRAY_MAX_OID: {"1": "500", "2": "250"},
        collect_snmp._TRAY_LEVEL_OID: {"1": "250", "2": "0"},
    }
    _patch_snmp(monkeypatch, present, walk_table=walk_table)

    printer, errors = _run(collect_printer("10.0.0.8", "public", 0.1))
    assert printer is not None
    assert len(printer.trays) == 2
    assert printer.trays[0].name == "Tray 1"
    assert printer.trays[0].media == "A4"
    assert printer.trays[0].level_pct == 50
    assert printer.trays[0].level_status == "ok"
    assert printer.trays[1].name == "Tray 2"
    assert printer.trays[1].media == "Letter"
    assert printer.trays[1].level_pct == 0
    assert printer.trays[1].level_status == "empty"


def test_supply_unknown_level_is_none(monkeypatch):
    present = {
        OIDS["description"]: "HP LaserJet",
        OIDS["serial"]: "SN200",
        OIDS["status"]: "3",
        OIDS["page_count"]: "50",
    }
    walk_table = {
        collect_snmp._SUPPLY_DESC_OID: {"1": "Black Toner"},
        collect_snmp._SUPPLY_MAX_OID: {"1": "-2"},  # unknown capacity
        collect_snmp._SUPPLY_LEVEL_OID: {"1": "50"},
    }
    _patch_snmp(monkeypatch, present, walk_table=walk_table)

    printer, _ = _run(collect_printer("10.0.0.9", "public", 0.1))
    assert printer is not None
    assert len(printer.supplies) == 1
    assert printer.supplies[0].level_pct is None
    assert printer.supplies[0].level_status == "unknown"


def test_tray_sentinel_minus3_is_ok(monkeypatch):
    # RFC 3805: level=-3 means "at least some remaining" (e.g. Canon iR1750 Drawer2)
    present = {
        OIDS["description"]: "Canon iR1750 /P",
        OIDS["serial"]: "SN300",
        OIDS["status"]: "3",
        OIDS["page_count"]: "100",
    }
    walk_table = {
        collect_snmp._TRAY_NAME_OID: {"1": "Drawer2"},
        collect_snmp._TRAY_MAX_OID: {"1": "550"},
        collect_snmp._TRAY_LEVEL_OID: {"1": "-3"},
    }
    _patch_snmp(monkeypatch, present, walk_table=walk_table)

    printer, _ = _run(collect_printer("10.0.0.10", "public", 0.1))
    assert printer is not None
    assert len(printer.trays) == 1
    assert printer.trays[0].name == "Drawer2"
    assert printer.trays[0].level_pct is None
    assert printer.trays[0].level_status == "ok"
