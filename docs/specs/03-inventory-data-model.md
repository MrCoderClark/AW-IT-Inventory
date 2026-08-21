# 03 — Inventory Data Model

**Status:** Draft v1 · **Last updated:** 2026-08-21 · **DB:** PostgreSQL (owned by `web`)

The domain model for assets, plus the tables that hold scan data and link it back to
managed records. Naming mirrors the registry UI (asset tag, model/spec, status, assignee,
location, warranty) so the screen and the schema stay legible together.

---

## 1. Entity map

```
category ─┐
model ────┼─▶ asset ─┬─▶ assignment_history ─▶ person
          │          ├─▶ activity_event  (the "Audit History" timeline)
location ─┘          ├─▶ warranty (fields)
                     └─▶ machine (1:1 for computers; linked by reconciliation)
                              ├─▶ hardware_snapshot
                              ├─▶ health_snapshot
                              ├─▶ software_item
                              ├─▶ file_check_result
                              └─▶ compliance_snapshot
printer_snapshot ─▶ asset (printers; via SNMP)
discovered_device ─▶ (inbox; unmatched scans awaiting linkage)
```

---

## 2. Core tables

### `category`
Seed values match the fleet and the mock's sidebar.
`id`, `key`, `label`, `icon`, `sort`.
Seed: `computers`, `displays`, `printers`, `mobile_devices`, `peripherals`, `network`.

### `lifecycle_status`
`id`, `key`, `label`, `color`, `sort`.
Seed: `in_use`, `ready`, `maintenance`, `retired` (extensible: `ordered`, `in_stock`,
`lost`, `disposed`).

### `manufacturer` / `model`
- **manufacturer** — `id`, `name` (Apple, Dell, HP, LG, Canon, …).
- **model** — `id`, `manufacturer_id`, `category_id`, `name` (e.g. "MacBook Pro 16\"
  (M3 Max)"), `default_specs` (jsonb), `image_url`.

### `location`
Hierarchical, rendered as `SF — HQ — L4` in the UI.
`id`, `parent_id`, `type` (`site`/`building`/`floor`/`room`/`cage`), `code`, `label`,
`path_cache` (denormalized display string).

### `person`
Assignees. May later sync from AD/`aw-auth`, but stands alone now.
`id`, `display_name`, `email`, `employee_id`, `department`, `title`, `active`,
`auth_user_id` (nullable link to an `aw-auth` user).

### `vendor`
`id`, `name`, `support_url`, `phone`. (e.g. "Apple Enterprise")

### `asset` — the managed record (source of truth)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `asset_tag` | text unique | Human key, e.g. `MAC-2024-001`, `MON-8801-X`, `PRT-0092-K` |
| `category_id` | fk | |
| `model_id` | fk | |
| `serial` | text | Manufacturer serial; a reconciliation key |
| `status_id` | fk → lifecycle_status | |
| `assignee_id` | fk → person (nullable) | null = "Available" |
| `location_id` | fk → location | |
| `vendor_id` | fk → vendor (nullable) | |
| `purchase_date` | date | |
| `warranty_until` | date | Drives amber "warranty" column + expiry reports |
| `cost_center` | text | e.g. `ENG-CORE-SF` |
| `spec_summary` | text | Short spec line for the table (e.g. "64GB RAM / 2TB SSD / Space Black") |
| `specs` | jsonb | Structured spec detail |
| `notes` | text | |
| `photo_url` | text (nullable) | |
| `created_at`/`updated_at` | ts | |

Indexes: `asset_tag`, `serial`, `status_id`, `category_id`, `warranty_until`,
GIN on `specs`. Full-text index across tag/serial/model/assignee for the top search bar.

### `assignment_history`
`id`, `asset_id`, `person_id`, `assigned_at`, `returned_at`, `assigned_by`, `note`.

### `activity_event` — the audit/history timeline
Feeds the right-panel "Audit History".
`id`, `asset_id`, `type` (`received`/`provisioned`/`assigned`/`status_changed`/
`scanned`/`edited`/`retired`), `actor_type`, `actor_id`, `summary`, `detail` (jsonb),
`occurred_at`.

---

## 3. Scan-side tables (written by the collector via ingest)

### `machine` — the live computer entity (1:1 with a computer asset once linked)
| Column | Notes |
|---|---|
| `id` | uuid |
| `asset_id` | fk → asset (nullable until reconciled) |
| `hostname`, `fqdn` | |
| `hardware_uuid` | SMBIOS UUID — strongest match key |
| `serial` | BIOS/chassis serial |
| `primary_mac`, `ips` (jsonb) | |
| `os_name`, `os_version`, `os_build` | |
| `domain_or_workgroup` | which network/identity |
| `subnet` | `192.168.70.0/24` or `.72.0/24` |
| `last_seen_at`, `last_scan_status` | |
| `working_credential_profile` | which vault profile last succeeded (cache) |

### `hardware_snapshot`
Point-in-time; keep a short history to see change.
`id`, `machine_id`, `cpu`, `cpu_cores`, `ram_gb`, `disks` (jsonb: model/size/type/health),
`gpu`, `bios_version`, `captured_at`.

### `health_snapshot`
`id`, `machine_id`, `free_disk_gb` (jsonb per volume), `ram_used_pct`, `uptime_hours`,
`smart_status`, `battery_health_pct`, `captured_at`.

### `software_item`
`id`, `machine_id`, `name`, `version`, `publisher`, `install_date`, `captured_at`.
(For license/software audit. Unique-ish per machine+name+version.)

### `file_check_result`
Results of file-presence rules.
`id`, `machine_id`, `rule_id`, `path`, `found` (bool), `size`, `sha256` (optional),
`modified_at`, `captured_at`.

### `compliance_snapshot`
`id`, `machine_id`, `bitlocker_on`, `av_product`, `av_up_to_date`, `firewall_on`,
`local_admins` (jsonb), `pending_reboot`, `last_patch_at`, `captured_at`.

### `printer_snapshot` (SNMP)
`id`, `asset_id` (nullable), `hostname`, `ip`, `model`, `serial`, `page_count`,
`toner_levels` (jsonb), `status`, `captured_at`.

### `discovered_device` — the review inbox
Unmatched scans land here instead of silently creating assets.
`id`, `first_seen_at`, `last_seen_at`, `ip`, `subnet`, `hostname`, `os`, `serial`,
`hardware_uuid`, `suggested_match_asset_id` (nullable), `raw` (jsonb), `resolved`
(bool), `resolved_action` (`linked`/`created`/`ignored`).

---

## 4. Reconciliation (scan → asset)

When a scan batch arrives, match each machine to an existing asset using keys in order of
strength; first hit wins:

1. `hardware_uuid` (SMBIOS UUID) — strongest.
2. `serial`.
3. `primary_mac`.
4. `hostname` (weakest; hostnames get reused).

- **Match found** → update/create `machine` linked to that `asset`; append snapshots;
  write an `activity_event` of type `scanned`; optionally auto-fill blank asset fields
  (model/serial/specs) but never overwrite human-edited fields without flagging.
- **No match** → upsert a `discovered_device`; surface in the inbox with a suggested
  match (fuzzy on hostname/serial). A human links it to an asset or creates one.

This keeps the managed inventory authoritative while still auto-populating from the wire.

---

## 5. Warranty & lifecycle logic

- `warranty_until` drives the amber column and an **"expiring soon"** state
  (configurable window, default 90 days) shown as a heat indicator.
- Lifecycle transitions are recorded as `activity_event`s and can be automated:
  e.g. a machine unreachable for N scans → suggest `maintenance`; a `retired` asset is
  read-only except for disposal fields.

---

## 6. Search & indexing

The top search bar ("Search tags, serials, people…") queries a materialized/tsvector
index spanning: `asset_tag`, `serial`, `model.name`, `person.display_name`,
`location.path_cache`, and `spec_summary`. Category and lifecycle filters are simple
indexed predicates. Target: sub-100ms for a fleet of a few thousand rows.

---

## 7. Seed data (to match the mock)

Categories, lifecycle statuses, a starter manufacturer/model list, and the SF/NY/LDN/AUS
locations shown in the mock. Statuses colored: In Use (blue/slate), Ready (green),
Maintenance (amber), Retired (grey) — see [`design-system.md`](../design/design-system.md).
