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
from collect_snmp import OIDS, collect_printer


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


def test_v1_printer_missing_serial_still_reads_identity_and_counter(monkeypatch):
    # covers: the Canon iR1750 (v1 only, no prtGeneralSerialNumber). The collector
    # must still return identity plus page_count, not snmp_no_response.
    present = {
        OIDS["description"]: "Canon iR1750 /P",
        OIDS["status"]: "1",  # hrPrinterStatus: other
        OIDS["page_count"]: "581851",  # standard prtMarkerLifeCount
        # OIDS["serial"] is intentionally absent (the missing OID)
    }
    monkeypatch.setattr(collect_snmp, "_snmp_get", _fake_snmp(present, v1_only=True))

    printer, errors = _run(collect_printer("192.168.70.203", "public", 0.1))

    assert errors == []
    assert printer is not None
    assert printer.description == "Canon iR1750 /P"
    assert printer.serial is None  # the missing OID stays blank
    assert printer.page_count == 581851  # the counter still reads
    assert printer.status == "other"


def test_no_snmp_answer_returns_snmp_no_response(monkeypatch):
    # covers: a device that answers on no version (not even sysDescr) is reported
    # as snmp_no_response, the reachability anchor failing closed.
    monkeypatch.setattr(collect_snmp, "_snmp_get", _fake_snmp({}, v1_only=True))

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
    monkeypatch.setattr(collect_snmp, "_snmp_get", _fake_snmp(present))

    printer, errors = _run(collect_printer("10.0.0.5", "public", 0.1))

    assert errors == []
    assert printer is not None
    assert printer.serial == "SN123"
    assert printer.page_count == 42
    assert printer.status == "idle"
