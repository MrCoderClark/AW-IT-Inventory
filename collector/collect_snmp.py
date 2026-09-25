"""Printer collection over SNMP v2c (pysnmp 7, asyncio).

Best-effort: any failure is captured per host and never breaks the run.
"""

from __future__ import annotations

import asyncio

from models import PrinterInfo

# Numeric OIDs (Printer-MIB / Host-Resources-MIB); lookupMib disabled for speed.
# The page_count OID is the standard prtMarkerLifeCount default; it is overridable
# per run (spec 14) so a vendor-specific counter OID can be read instead.
DEFAULT_COUNTER_OID = "1.3.6.1.2.1.43.10.2.1.4.1.1"  # prtMarkerLifeCount
OIDS = {
    "description": "1.3.6.1.2.1.1.1.0",  # sysDescr
    "serial": "1.3.6.1.2.1.43.5.1.1.17.1",  # prtGeneralSerialNumber
    "page_count": DEFAULT_COUNTER_OID,
    "status": "1.3.6.1.2.1.25.3.5.1.1.1",  # hrPrinterStatus
}
PRINTER_STATUS = {1: "other", 2: "unknown", 3: "idle", 4: "printing", 5: "warmup"}


def _to_int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _clean(value: str | None) -> str | None:
    if not value or "No Such" in value or "No SNMP" in value:
        return None
    return value.strip() or None


# SNMP message model per pysnmp: mpModel=1 is v2c, mpModel=0 is v1.
_MP_V2C = 1
_MP_V1 = 0


def mp_models_for(version: str | None) -> tuple[int, ...]:
    """The SNMP versions to try, in order, for a `snmp_version` config value.

    "auto" (default) tries v2c then falls back to v1, so a v1-only device (e.g.
    the Canon imageFORCE, which offers only SNMPv1/v3 and silently drops v2c
    requests) is still read. "v2c" / "v1" pin a single version and skip the other
    (and the extra timeout)."""
    v = (version or "auto").strip().lower()
    if v in ("v1", "1"):
        return (_MP_V1,)
    if v in ("v2c", "v2", "2c", "2"):
        return (_MP_V2C,)
    return (_MP_V2C, _MP_V1)  # auto


async def _snmp_get(
    ip: str,
    community: str,
    timeout: float,
    oids: list[str],
    versions: tuple[int, ...] = (_MP_V2C, _MP_V1),
):
    from pysnmp.hlapi.v3arch.asyncio import (
        CommunityData,
        ContextData,
        ObjectIdentity,
        ObjectType,
        SnmpEngine,
        UdpTransportTarget,
        get_cmd,
    )

    # Try each configured version in order; a device that ignores one version
    # times out, so fall through to the next rather than giving up.
    for mp_model in versions:
        target = await UdpTransportTarget.create((ip, 161), timeout=timeout, retries=1)
        err_indication, err_status, _err_index, var_binds = await get_cmd(
            SnmpEngine(),
            CommunityData(community, mpModel=mp_model),
            target,
            ContextData(),
            *[ObjectType(ObjectIdentity(o)) for o in oids],
            lookupMib=False,
        )
        if err_indication or err_status:
            continue
        return [str(vb[1]) for vb in var_binds]
    return None


async def _read_page_count(
    ip: str,
    community: str,
    timeout: float,
    counter_oids: list[str],
    versions: tuple[int, ...],
) -> int | None:
    """Read a printer's page counter, trying each candidate OID in priority order
    and taking the first that returns a number (spec 14).

    Each candidate is a SEPARATE GET on purpose: under SNMP v1 a GET of a missing
    OID fails the WHOLE request (noSuchName), so a vendor-specific counter OID that
    some models lack must never be bundled with another. This lets one config serve
    a mixed fleet, e.g. Canon "Total" first with the standard prtMarkerLifeCount as
    a universal fallback."""
    for oid in counter_oids or [DEFAULT_COUNTER_OID]:
        try:
            got = await _snmp_get(ip, community, timeout, [oid], versions)
        except Exception:  # noqa: BLE001 — a bad candidate must not fail the read
            continue
        if not got:
            continue
        value = _to_int(_clean(got[0]))
        if value is not None:
            return value
    return None


async def _read_one(
    ip: str,
    community: str,
    timeout: float,
    oid: str,
    versions: tuple[int, ...],
) -> str | None:
    """Read a single OID best-effort: the raw value, or None if it is missing or
    the request fails. Its own GET on purpose, so a missing OID never fails the
    read of another one under SNMP v1 (see the note on _read_page_count)."""
    try:
        got = await _snmp_get(ip, community, timeout, [oid], versions)
    except Exception:  # noqa: BLE001 — one missing OID must not fail the collect
        return None
    return got[0] if got else None


async def _pick_version(
    ip: str,
    community: str,
    timeout: float,
    versions: tuple[int, ...],
) -> tuple[str | None, tuple[int, ...]]:
    """Establish reachability on sysDescr and pin the version that answered.

    sysDescr exists on every SNMP device, so it is the reachability anchor. We
    probe each configured version with a plain sysDescr GET and keep the first
    that responds; every later read is pinned to that one version, so a v1-only
    device costs a single v2c timeout, not one per OID. Returns
    ``(sysDescr, (version,))`` or ``(None, ())`` when nothing responds."""
    for mp_model in versions:
        got = await _snmp_get(ip, community, timeout, [OIDS["description"]], (mp_model,))
        if got:
            return _clean(got[0]), (mp_model,)
    return None, ()


async def collect_printer(
    ip: str,
    community: str,
    timeout: float,
    counter_oids: list[str] | None = None,
    snmp_version: str | None = None,
) -> tuple[PrinterInfo | None, list[str]]:
    versions = mp_models_for(snmp_version)

    # Reachability anchors on sysDescr (present on every device) and pins the
    # responding SNMP version. Everything else is read SEPARATELY, best-effort:
    # under SNMP v1 a GET of a missing OID fails the WHOLE request, and some
    # printers (e.g. the Canon iR1750) do not implement prtGeneralSerialNumber,
    # so bundling serial/status with sysDescr would drop identity AND the counter.
    # A missing serial or status now just stays blank.
    try:
        description, versions_ok = await _pick_version(ip, community, timeout, versions)
    except Exception as e:  # noqa: BLE001
        return None, [f"snmp_error: {type(e).__name__}: {e}"]
    if not versions_ok:
        return None, ["snmp_no_response"]

    serial = await _read_one(ip, community, timeout, OIDS["serial"], versions_ok)
    status = await _read_one(ip, community, timeout, OIDS["status"], versions_ok)
    page_count = await _read_page_count(
        ip, community, timeout, counter_oids or [DEFAULT_COUNTER_OID], versions_ok
    )

    printer = PrinterInfo(
        description=description,
        model=description,  # refined from sysDescr later
        serial=_clean(serial),
        page_count=page_count,
        status=PRINTER_STATUS.get(_to_int(_clean(status)) or 0),
    )
    return printer, []


async def collect_printers(
    ips: list[str],
    community: str,
    timeout: float,
    counter_oids: list[str] | None = None,
    snmp_version: str | None = None,
) -> dict[str, tuple[PrinterInfo | None, list[str]]]:
    tasks = {
        ip: asyncio.create_task(
            collect_printer(ip, community, timeout, counter_oids, snmp_version)
        )
        for ip in ips
    }
    return {ip: await task for ip, task in tasks.items()}
