"""Printer collection over SNMP v2c (pysnmp 7, asyncio).

Best-effort: any failure is captured per host and never breaks the run.
"""

from __future__ import annotations

import asyncio

from models import PrinterInfo, SupplyLevel, TrayLevel

# Numeric OIDs (Printer-MIB / Host-Resources-MIB); lookupMib disabled for speed.
# The page_count OID is the standard prtMarkerLifeCount default; it is overridable
# per run (spec 14) so a vendor-specific counter OID can be read instead.
DEFAULT_COUNTER_OID = "1.3.6.1.2.1.43.10.2.1.4.1.1"  # prtMarkerLifeCount
OIDS = {
    "description": "1.3.6.1.2.1.1.1.0",  # sysDescr
    "serial": "1.3.6.1.2.1.43.5.1.1.17.1",  # prtGeneralSerialNumber
    "page_count": DEFAULT_COUNTER_OID,
    "status": "1.3.6.1.2.1.25.3.5.1.1.1",  # hrPrinterStatus
    "error_state": "1.3.6.1.2.1.25.3.5.1.2.1",  # hrPrinterDetectedErrorState
}
PRINTER_STATUS = {1: "other", 2: "unknown", 3: "idle", 4: "printing", 5: "warmup"}

# hrPrinterDetectedErrorState (RFC 3805): a 2-byte OCTET STRING bitmask.
# Each tuple: (byte index, bit mask, error flag name).
_ERROR_BITS: list[tuple[int, int, str]] = [
    (0, 0x80, "lowPaper"),
    (0, 0x40, "noPaper"),
    (0, 0x20, "lowToner"),
    (0, 0x10, "noToner"),
    (0, 0x08, "doorOpen"),
    (0, 0x04, "jammed"),
    (0, 0x02, "offline"),
    (0, 0x01, "serviceRequested"),
    (1, 0x80, "inputTrayMissing"),
    (1, 0x40, "outputTrayMissing"),
    (1, 0x20, "markerSupplyMissing"),
    (1, 0x10, "outputNearFull"),
    (1, 0x08, "outputFull"),
    (1, 0x04, "inputTrayEmpty"),
    (1, 0x02, "overduePreventMaint"),
]


def _parse_error_bits(raw: bytes) -> list[str]:
    """Decode the hrPrinterDetectedErrorState bitmask into a list of flag names."""
    return [
        name
        for byte_idx, mask, name in _ERROR_BITS
        if byte_idx < len(raw) and raw[byte_idx] & mask
    ]


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


async def _read_error_state(
    ip: str,
    community: str,
    timeout: float,
    versions: tuple[int, ...],
) -> list[str]:
    """Read hrPrinterDetectedErrorState and decode the bitmask.

    Uses the shared ``_snmp_get`` path (same SnmpEngine lifecycle as every other
    per-OID read) and recovers the raw bytes from pysnmp's str-encoded OctetString
    via ISO-8859-1 (the pyasn1 default encoding, a lossless byte↔char roundtrip).
    Its own GET on purpose (v1 rule, see _read_page_count)."""
    try:
        got = await _snmp_get(ip, community, timeout, [OIDS["error_state"]], versions)
    except Exception:  # noqa: BLE001
        return []
    if not got or not got[0]:
        return []
    text = got[0]
    if "No Such" in text:
        return []
    try:
        raw = text.encode("latin-1")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return []
    return _parse_error_bits(raw)


async def _snmp_walk_column(
    ip: str,
    community: str,
    timeout: float,
    base_oid: str,
    versions: tuple[int, ...],
    max_rows: int = 32,
) -> dict[str, str]:
    """Walk one table column via GETNEXT, return {trailing_index: str_value}.

    Stops when the returned OID leaves the subtree or ``max_rows`` is hit.
    Its own engine per walk on purpose (same lifecycle as ``_snmp_get``).
    """
    from pysnmp.hlapi.v3arch.asyncio import (
        CommunityData,
        ContextData,
        ObjectIdentity,
        ObjectType,
        SnmpEngine,
        UdpTransportTarget,
        next_cmd,
    )

    base_parts = base_oid.split(".")
    result: dict[str, str] = {}

    for mp_model in versions:
        target = await UdpTransportTarget.create((ip, 161), timeout=timeout, retries=1)
        engine = SnmpEngine()
        current = ObjectType(ObjectIdentity(base_oid))
        rows = 0

        while rows < max_rows:
            err_ind, err_status, _err_idx, var_binds = await next_cmd(
                engine,
                CommunityData(community, mpModel=mp_model),
                target,
                ContextData(),
                current,
                lookupMib=False,
            )
            if err_ind or err_status or not var_binds:
                break

            oid, val = var_binds[0]
            oid_str = str(oid)
            oid_parts = oid_str.split(".")
            if oid_parts[: len(base_parts)] != base_parts:
                break

            suffix = ".".join(oid_parts[len(base_parts) :])
            result[suffix] = str(val)
            current = ObjectType(ObjectIdentity(str(oid)))
            rows += 1

        if result:
            return result
    return result


# Printer-MIB supply table columns (prtMarkerSuppliesEntry, device index 1).
_SUPPLY_DESC_OID = "1.3.6.1.2.1.43.11.1.1.6.1"
_SUPPLY_MAX_OID = "1.3.6.1.2.1.43.11.1.1.8.1"
_SUPPLY_LEVEL_OID = "1.3.6.1.2.1.43.11.1.1.9.1"

# Printer-MIB input tray table columns (prtInputEntry, device index 1).
_TRAY_DESC_OID = "1.3.6.1.2.1.43.8.2.1.18.1"   # prtInputDescription
_TRAY_NAME_OID = "1.3.6.1.2.1.43.8.2.1.13.1"   # prtInputName (fallback)
_TRAY_MAX_OID = "1.3.6.1.2.1.43.8.2.1.9.1"
_TRAY_LEVEL_OID = "1.3.6.1.2.1.43.8.2.1.10.1"
_TRAY_MEDIA_OID = "1.3.6.1.2.1.43.8.2.1.12.1"


def _level_info(level: int | None, capacity: int | None) -> tuple[int | None, str]:
    """Compute (percentage_or_None, status) from SNMP level/maxCapacity.

    RFC 3805 sentinel values:
      -1 = other (unknown), -2 = unknown, -3 = at least some remaining.
    """
    if level is None or capacity is None:
        return None, "unknown"
    if level == -3:
        return None, "ok"
    if level < 0 or capacity <= 0:
        return None, "unknown"
    if level == 0:
        return 0, "empty"
    pct = max(0, min(100, round(level * 100 / capacity)))
    return pct, "low" if pct <= 10 else "ok"


async def _read_supplies(
    ip: str, community: str, timeout: float, versions: tuple[int, ...],
) -> list[SupplyLevel]:
    """Read prtMarkerSuppliesTable: description, maxCapacity, currentLevel."""
    try:
        descs, maxes, levels = await asyncio.gather(
            _snmp_walk_column(ip, community, timeout, _SUPPLY_DESC_OID, versions),
            _snmp_walk_column(ip, community, timeout, _SUPPLY_MAX_OID, versions),
            _snmp_walk_column(ip, community, timeout, _SUPPLY_LEVEL_OID, versions),
        )
    except Exception:
        return []
    if not descs:
        return []
    result: list[SupplyLevel] = []
    for idx, name_raw in descs.items():
        name = name_raw.strip()
        if not name or "No Such" in name:
            continue
        capacity = _to_int(maxes.get(idx))
        level = _to_int(levels.get(idx))
        pct, status = _level_info(level, capacity)
        result.append(SupplyLevel(name=name, level_pct=pct, level_status=status))
    return result


async def _read_trays(
    ip: str, community: str, timeout: float, versions: tuple[int, ...],
) -> list[TrayLevel]:
    """Read prtInputTable: description/name, media name, maxCapacity, currentLevel.

    Iterates on the level column (always present when a tray exists) and falls
    back through prtInputDescription → prtInputName → "Tray {n}" for the label,
    since not every printer populates both name columns."""
    try:
        descs, names, medias, maxes, levels = await asyncio.gather(
            _snmp_walk_column(ip, community, timeout, _TRAY_DESC_OID, versions),
            _snmp_walk_column(ip, community, timeout, _TRAY_NAME_OID, versions),
            _snmp_walk_column(ip, community, timeout, _TRAY_MEDIA_OID, versions),
            _snmp_walk_column(ip, community, timeout, _TRAY_MAX_OID, versions),
            _snmp_walk_column(ip, community, timeout, _TRAY_LEVEL_OID, versions),
        )
    except Exception:
        return []
    all_indices = set(levels) | set(maxes) | set(descs) | set(names)
    if not all_indices:
        return []
    result: list[TrayLevel] = []
    for n, idx in enumerate(sorted(all_indices), 1):
        desc = _clean(descs.get(idx))
        name = _clean(names.get(idx))
        label = desc or name or f"Tray {n}"
        media = _clean(medias.get(idx))
        capacity = _to_int(maxes.get(idx))
        level = _to_int(levels.get(idx))
        pct, status = _level_info(level, capacity)
        result.append(TrayLevel(name=label, media=media, level_pct=pct, level_status=status))
    return result


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

    serial, status, page_count, errors, supplies, trays = await asyncio.gather(
        _read_one(ip, community, timeout, OIDS["serial"], versions_ok),
        _read_one(ip, community, timeout, OIDS["status"], versions_ok),
        _read_page_count(
            ip, community, timeout, counter_oids or [DEFAULT_COUNTER_OID], versions_ok
        ),
        _read_error_state(ip, community, timeout, versions_ok),
        _read_supplies(ip, community, timeout, versions_ok),
        _read_trays(ip, community, timeout, versions_ok),
    )

    printer = PrinterInfo(
        description=description,
        model=description,  # refined from sysDescr later
        serial=_clean(serial),
        page_count=page_count,
        status=PRINTER_STATUS.get(_to_int(_clean(status)) or 0),
        supplies=supplies,
        trays=trays,
        errors=errors,
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
