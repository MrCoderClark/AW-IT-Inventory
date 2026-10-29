"""Diagnostic: what does pysnmp return for hrPrinterDetectedErrorState?

Usage:  uv run python diag_error_state.py 192.168.70.209
"""

import asyncio
import sys

from pysnmp.hlapi.v3arch.asyncio import (
    CommunityData,
    ContextData,
    ObjectIdentity,
    ObjectType,
    SnmpEngine,
    UdpTransportTarget,
    get_cmd,
)

OID = "1.3.6.1.2.1.25.3.5.1.2.1"  # hrPrinterDetectedErrorState.1


async def probe(ip: str) -> None:
    target = await UdpTransportTarget.create((ip, 161), timeout=2, retries=1)

    for mp, label in [(0, "v1"), (1, "v2c")]:
        print(f"\n{'='*40}")
        print(f"  {label}  →  {ip}  OID {OID}")
        print(f"{'='*40}")
        err_ind, err_status, err_idx, vbs = await get_cmd(
            SnmpEngine(),
            CommunityData("public", mpModel=mp),
            target,
            ContextData(),
            ObjectType(ObjectIdentity(OID)),
            lookupMib=False,
        )
        print(f"  err_indication : {err_ind!r}")
        print(f"  err_status     : {err_status!r}")
        print(f"  err_index      : {err_idx!r}")
        if not vbs:
            print("  var_binds      : (empty)")
            continue

        val = vbs[0][1]
        print(f"  val type       : {type(val).__name__}  (mro: {[c.__name__ for c in type(val).__mro__[:5]]})")
        print(f"  val repr       : {val!r}")
        print(f"  str(val)       : {str(val)!r}")
        print(f"  bool(val)      : {bool(val)}")

        for attr in ("asOctets", "asNumbers", "__bytes__", "prettyPrint"):
            if hasattr(val, attr):
                try:
                    result = getattr(val, attr)()
                    print(f"  .{attr}()   : {result!r}")
                except Exception as e:
                    print(f"  .{attr}()   : ERROR {e}")
            else:
                print(f"  .{attr}()   : (not available)")

        # Try bytes() directly
        try:
            raw = bytes(val)
            print(f"  bytes(val)     : {raw!r}  (hex: {raw.hex()})")
        except Exception as e:
            print(f"  bytes(val)     : ERROR {e}")


if __name__ == "__main__":
    ip = sys.argv[1] if len(sys.argv) > 1 else "192.168.70.209"
    asyncio.run(probe(ip))
