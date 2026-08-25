"""Printer collection over SNMP v2c (pysnmp 7, asyncio).

Best-effort: any failure is captured per host and never breaks the run.
"""

from __future__ import annotations

import asyncio

from models import PrinterInfo

# Numeric OIDs (Printer-MIB / Host-Resources-MIB); lookupMib disabled for speed.
OIDS = {
    "description": "1.3.6.1.2.1.1.1.0",  # sysDescr
    "serial": "1.3.6.1.2.1.43.5.1.1.17.1",  # prtGeneralSerialNumber
    "page_count": "1.3.6.1.2.1.43.10.2.1.4.1.1",  # prtMarkerLifeCount
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


async def _snmp_get(ip: str, community: str, timeout: float, oids: list[str]):
    from pysnmp.hlapi.v3arch.asyncio import (
        CommunityData,
        ContextData,
        ObjectIdentity,
        ObjectType,
        SnmpEngine,
        UdpTransportTarget,
        get_cmd,
    )

    target = await UdpTransportTarget.create((ip, 161), timeout=timeout, retries=1)
    err_indication, err_status, _err_index, var_binds = await get_cmd(
        SnmpEngine(),
        CommunityData(community, mpModel=1),  # v2c
        target,
        ContextData(),
        *[ObjectType(ObjectIdentity(o)) for o in oids],
        lookupMib=False,
    )
    if err_indication or err_status:
        return None
    return [str(vb[1]) for vb in var_binds]


async def collect_printer(
    ip: str, community: str, timeout: float
) -> tuple[PrinterInfo | None, list[str]]:
    keys = list(OIDS.keys())
    try:
        values = await _snmp_get(ip, community, timeout, [OIDS[k] for k in keys])
    except Exception as e:  # noqa: BLE001
        return None, [f"snmp_error: {type(e).__name__}: {e}"]
    if values is None:
        return None, ["snmp_no_response"]

    m = dict(zip(keys, values))
    printer = PrinterInfo(
        description=_clean(m.get("description")),
        model=_clean(m.get("description")),  # refined from sysDescr later
        serial=_clean(m.get("serial")),
        page_count=_to_int(_clean(m.get("page_count"))),
        status=PRINTER_STATUS.get(_to_int(_clean(m.get("status"))) or 0),
    )
    return printer, []


async def collect_printers(
    ips: list[str], community: str, timeout: float
) -> dict[str, tuple[PrinterInfo | None, list[str]]]:
    tasks = {ip: asyncio.create_task(collect_printer(ip, community, timeout)) for ip in ips}
    return {ip: await task for ip, task in tasks.items()}
