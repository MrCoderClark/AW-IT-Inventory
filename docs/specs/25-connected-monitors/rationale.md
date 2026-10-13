# 25. Connected monitors — rationale

Why the choices in [index.md](index.md). This is a collect→store→surface feature in
the mold of spec 15 (software inventory) and spec 21 (compliance), so most decisions
are "reuse the proven path"; the interesting ones are about EDID and reconciliation.

## 1. Read EDID in the existing WinRM call vs a separate pass

The collector already makes one WinRM/PowerShell round-trip per computer
(`collect_windows`) and reads hardware, health, software, and posture in it. Adding
the two `WmiMonitorID` / `WmiMonitorBasicDisplayParams` queries there costs almost
nothing and avoids a second connection, extra auth, and extra latency. The one risk
is command-line length — pywinrm runs the script as `powershell -EncodedCommand` and
the WinRS cmd shell caps the line at ~8 KB (this is exactly what bit spec 21, forcing
posture into its own `PS_POSTURE` call). The monitor block is small, but if the
combined `collect_windows` script is already near the cap we put the monitor read in
its **own `PS_MONITORS` sub-call** like posture, rather than overflow. Chosen:
in-collect, split out only if the length budget requires it.

## 2. `WmiMonitorID` vs `Win32_DesktopMonitor` vs raw EDID bytes

- **`Win32_DesktopMonitor`** is the old class; it usually reports "Generic PnP
  Monitor" with no serial — useless for inventory.
- **Parsing raw EDID** from the registry (`HKLM\SYSTEM\...\DISPLAY\...\Device
  Parameters\EDID`) gives everything but means shipping an EDID byte-parser and
  walking the registry per display — more code, more fragility.
- **`WmiMonitorID`** (root\wmi) already decodes EDID into manufacturer, model,
  serial, product code, and year as WMI properties; `WmiMonitorBasicDisplayParams`
  adds physical size. It's the standard, least-code source and is what the live
  fleet test returned cleanly.

Chosen: `WmiMonitorID` (+ basic params for size). Raw-EDID parsing is a follow-up
only if we need fields WMI doesn't expose.

## 3. Where to decode the EDID arrays

The WMI fields come back as `UInt16[]` (char arrays). We can decode in PowerShell on
the target (emit clean JSON) or ship the arrays and decode web-side. Decoding **on
the target in the PowerShell** keeps the payload small and the web ingest simple
(it already trusts the collector's JSON), and matches how `collect_windows` shapes
everything else. The **PnP→vendor-name map**, by contrast, lives **web-side** (a
constants table): it's presentation, it changes independently of the collector, and
keeping it in the web lets us extend it without redeploying collectors. Chosen:
decode strings on the target, map vendor code → name in the web.

## 4. Store a monitor↔computer link, or compute it from serials

OPUS already has **Monitor assets with serials**. We could write an explicit link
(set the Monitor asset's "connected to" field at ingest). But that duplicates truth
(the serial is already the join key), risks drift (a monitor unplugged won't clear a
stored link until the next scan of *that* computer), and complicates the asset
engine. Instead the reconciliation is a **read-time join** on `serial`
(`connected_monitors.serial` ↔ `assets.serial where type='Monitor'`): always current,
no new writer, and a monitor that moves shows up on the new computer's next scan
automatically. Chosen: read-time serial join; no stored link.

## 5. Current state, no history (like software inventory)

A display set is "what's attached now." Storing history (every scan's set) would
bloat for little v1 value. We replace the set per scan (`monitors == null` = not read
→ keep prior), exactly like `installed_software`. "Monitor moved" events are a
follow-up if demand appears.

## 6. No new permission / scope

Viewing displays is just more asset detail, so it rides `asset:read` like software
and compliance. Collection rides the existing ingest (`ingest:write`), so no collector
scope change. Nothing here widens the trust boundary.
