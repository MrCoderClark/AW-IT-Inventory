# Verify: type-specific asset forms · spec 10 · 2026-09-18

_Steps derived from spec 10 acceptance criteria. `/check verify` runs these;
`/test` locks the durable ones._

## Commands
- [ ] `cd web && npx tsc --noEmit` → typechecks clean → all
- [ ] `cd web && npm test` → the Vitest suite passes (existing + new per-type
  schema / registry / action tests) → all
- [ ] After `npm run db:push`, confirm the live schema: `computer_details`,
  `monitor_details`, `printer_details`, `phone_details`, `network_details` exist,
  each keyed by `asset_id` (PK/FK, cascade), with indexes on `printer_details.ip_address`,
  `phone_details.imei`, `phone_details.phone_number`, `network_details.ip_address`,
  `network_details.mac_address` → AC-2, AC-5, AC-9

## UI / manual (signed in as a user with `asset:write`)
- [ ] Open **New asset** on `/printers`: the form shows printer fields (IP address,
  color mode, duplex, page count, connection, management URL) and **no Assignee** →
  AC-1
- [ ] Save a printer with an IP, color mode, and page count → it persists, the
  detail page shows those fields, and the printer appears in the list → AC-1, AC-2, AC-3
- [ ] Repeat for each other type: Computer (form factor, OS, CPU, RAM, storage),
  Monitor (size, resolution, panel, refresh, ports, curved), Phone (IMEI, number,
  carrier, storage, OS, plan), Network (IP, MAC, role, port count, firmware,
  management URL); each form shows its own fields and Network hides Assignee → AC-1, AC-3
- [ ] Edit a saved asset → the type-specific fields are pre-filled with current
  values; changing one and saving updates it → AC-3
- [ ] Search the top bar for a printer's IP, a phone's number, and a switch's MAC →
  each device is found → AC-5
- [ ] Search a MAC with different separators/case (`aabbcc`, `AA:BB:CC`, `aa-bb-cc`)
  and a phone number with and without punctuation → all find the same device → AC-5
- [ ] A monitor's `sizeInches` (e.g. 34.5) saves and displays correctly (numeric
  round-trips as a string through Drizzle; coercion must hold) → AC-4
- [ ] Enter an invalid type-specific value (e.g. a non-numeric page count) → inline
  error, nothing written → AC-4
- [ ] Try to save a Printer with the IP address left blank → inline "required"
  error, nothing written; saving with an IP succeeds → AC-1, AC-4
- [ ] Delete an asset that had type-specific fields → the asset and its detail row
  are gone (no orphan detail row) → AC-2

## Failure / edge
- [ ] Edit an asset created before this feature (no detail row yet) → the form opens
  with empty type-specific fields and saving creates the detail row (lazy upsert) →
  AC-2, AC-9
- [ ] Type stays locked on edit → an asset never changes detail table → AC-6

## Permissions
- [ ] A user without `asset:write` sees no New/Edit controls, and a direct
  `createAsset` / `updateAsset` call is rejected with the forbidden result → AC-7

## Regression
- [ ] Shared fields, tag generation, the assignee picker, the location picker (spec
  09), the category tables, the dashboard, and the discovered inbox all still work;
  the freeform `spec` note still shows on every type → AC-8

## Acceptance-criteria coverage
- AC-1 … per-type field sets, shared fields hidden where they do not apply (UI steps 1–3)
- AC-2 … detail row upserted in the asset transaction, cascade on delete (commands; UI save/delete)
- AC-3 … detail page + edit prefill render type fields (UI steps 2–4)
- AC-4 … per-type validation on client + server (UI validation step)
- AC-5 … indexed identifier fields are searchable (commands; UI search step)
- AC-6 … type locked, no detail-table migration (edge step)
- AC-7 … type-specific writes gated on asset:write (perms)
- AC-8 … no regression across shared surfaces (regression step)
- AC-9 … additive migration, existing assets keep data, lazy detail row (commands; edge step)
