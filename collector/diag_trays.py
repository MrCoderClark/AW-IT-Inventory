"""Quick diagnostic: raw prtInputTable values for one printer.

Usage:  uv run python diag_trays.py 192.168.70.203
"""

import asyncio
import sys

from collect_snmp import (
    _snmp_walk_column,
    _TRAY_DESC_OID,
    _TRAY_NAME_OID,
    _TRAY_MAX_OID,
    _TRAY_LEVEL_OID,
    _TRAY_MEDIA_OID,
)

LABELS = {
    _TRAY_DESC_OID: "prtInputDescription (.18)",
    _TRAY_NAME_OID: "prtInputName (.13)",
    _TRAY_MEDIA_OID: "prtInputMediaName (.12)",
    _TRAY_MAX_OID: "prtInputMaxCapacity (.9)",
    _TRAY_LEVEL_OID: "prtInputCurrentLevel (.10)",
}


async def main(ip: str) -> None:
    versions = (0,)  # Canon = v1 only
    for oid, label in LABELS.items():
        data = await _snmp_walk_column(ip, "public", 3, oid, versions)
        print(f"{label}:")
        if not data:
            print("  (empty)")
        for idx, val in sorted(data.items()):
            print(f"  [{idx}] = {val!r}")
        print()


if __name__ == "__main__":
    ip = sys.argv[1] if len(sys.argv) > 1 else "192.168.70.203"
    asyncio.run(main(ip))
