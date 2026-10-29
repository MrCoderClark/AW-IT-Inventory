"""Diagnostic: does the Canon expose prtMarkerSuppliesTable / prtInputTable?

Usage:  uv run python diag_supplies.py 192.168.70.209
"""

import asyncio
import sys


async def probe(ip: str) -> None:
    # First verify next_cmd import works
    try:
        from pysnmp.hlapi.v3arch.asyncio import next_cmd
        print(f"next_cmd import: OK ({next_cmd})")
    except ImportError as e:
        print(f"next_cmd import FAILED: {e}")
        return

    from pysnmp.hlapi.v3arch.asyncio import (
        CommunityData,
        ContextData,
        ObjectIdentity,
        ObjectType,
        SnmpEngine,
        UdpTransportTarget,
        next_cmd,
    )

    target = await UdpTransportTarget.create((ip, 161), timeout=3, retries=1)

    tables = {
        "prtMarkerSuppliesDesc": "1.3.6.1.2.1.43.11.1.1.6.1",
        "prtMarkerSuppliesMax":  "1.3.6.1.2.1.43.11.1.1.8.1",
        "prtMarkerSuppliesLvl":  "1.3.6.1.2.1.43.11.1.1.9.1",
        "prtInputDesc":          "1.3.6.1.2.1.43.8.2.1.18.1",
        "prtInputMedia":         "1.3.6.1.2.1.43.8.2.1.12.1",
        "prtInputMax":           "1.3.6.1.2.1.43.8.2.1.9.1",
        "prtInputLevel":         "1.3.6.1.2.1.43.8.2.1.10.1",
    }

    # Canon is v1 only (mp=0)
    mp = 0

    for label, base_oid in tables.items():
        print(f"\n{'='*50}")
        print(f"  {label}  base_oid={base_oid}  (v1)")
        print(f"{'='*50}")

        engine = SnmpEngine()
        current = ObjectType(ObjectIdentity(base_oid))
        base_parts = base_oid.split(".")
        rows = 0

        while rows < 10:
            try:
                err_ind, err_status, err_idx, var_binds = await next_cmd(
                    engine,
                    CommunityData("public", mpModel=mp),
                    target,
                    ContextData(),
                    current,
                    lookupMib=False,
                )
            except Exception as e:
                print(f"  next_cmd raised: {type(e).__name__}: {e}")
                break

            print(f"  err_indication: {err_ind!r}")
            print(f"  err_status:     {err_status!r}")

            if err_ind or err_status:
                print("  -> stopping (error)")
                break
            if not var_binds:
                print("  -> stopping (no var_binds)")
                break

            oid, val = var_binds[0]
            oid_str = str(oid)
            oid_parts = oid_str.split(".")
            print(f"  OID:   {oid_str}")
            print(f"  type:  {type(val).__name__}")
            print(f"  value: {val!r}")
            print(f"  str:   {str(val)!r}")

            if oid_parts[:len(base_parts)] != base_parts:
                print("  -> left subtree, stopping")
                break

            suffix = ".".join(oid_parts[len(base_parts):])
            print(f"  suffix: {suffix}")
            current = ObjectType(ObjectIdentity(str(oid)))
            rows += 1
            print()

        if rows == 0:
            print("  (no rows returned)")


if __name__ == "__main__":
    ip = sys.argv[1] if len(sys.argv) > 1 else "192.168.70.209"
    asyncio.run(probe(ip))
