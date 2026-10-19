# 27. VoIP phone discovery — Yealink desk phones from the scan

## Summary

Today **Phone** assets are manual-entry only — the collector scans Windows hosts
(WinRM) and printers (SNMP), but nothing discovers desk phones. The fleet's
Yealink **T5x** phones (e.g. T54W) sit on their own subnet, are managed by
**Intermedia Unite** (hosted PBX, so each phone has a *unique* admin password),
and expose only HTTPS (443) + SIP — **SNMP is disabled/unsupported**.

Recon (`scratchpad/probe_yealink*.py`) found a clean, **credential-free** identity
path: every Yealink serves a device TLS cert whose **CN is the phone's MAC** and
whose **issuer is "Yealink Equipment Issuing CA"**, and the HTTPS login page
`<title>` is the **model** ("Yealink T54W Phone"). So discovery can identify a
phone — MAC, model, IP — from a bare TLS handshake, no login. Richer data
(**Display Name, extension, firmware**) lives behind the authenticated web UI and
is a second phase.

Example: `192.168.75.62` → cert CN `805e0c034323` = MAC `80:5E:0C:03:43:23`
(`80:5E:0C` is Yealink's OUI), title `Yealink T54W Phone`, account Label `117`,
Display Name `Joseph Clark`.

## Requirements

- **AC-1**: A configurable subnet (e.g. `192.168.75.0/24`) is swept; a host with
  **TCP 443 open** is TLS-probed. A cert issued by **Yealink** classifies it as a
  **phone** — port 443 alone never classifies (too ambiguous).
- **AC-2**: From the cert + login page, with **no credentials**, the collector reads
  **MAC** (cert CN), **model** (HTTPS `<title>`), and **IP** (the probe target).
- **AC-3**: Phones reconcile by **MAC** (phones have no scan-readable serial), a new
  reconciliation key alongside the existing serial match. A re-scan updates in place.
- **AC-4**: A discovered phone with no matching asset lands in the **discovered
  inbox** (spec 06) as a Phone, like any other new device; an operator adds it.
- **AC-5** (phase 2): When a per-phone credential is configured, the collect also
  reads **Display Name, extension (account Label), register status, firmware** from
  the authenticated web UI and stores them on the phone asset.
- **AC-6** (phase 2): A phone's **Display Name** may auto-suggest a link to the
  matching **Person** (spec 16) by name — surfaced, not auto-applied.
- **AC-7**: Credentials are **never** in YAML. Per-phone secrets live in a gitignored
  file keyed by **MAC**, path named in `config.yaml` (mirrors the `.env` convention).
  A phone with no credential still discovers (AC-2) — enrichment just shows "not
  configured", the same graceful degradation as the WinRM path.
- **AC-8**: Outbound-only, like the rest of the collector. Read-only — the scan never
  writes to a phone.

## Decision

**Two phases, split on whether credentials are needed.**

**Phase 1 — credential-free discovery (proven, low-risk).** A new `collect_phone`
path: TCP 443 probe → TLS cert read (`ssl.get_server_certificate`) → verify Yealink
issuer → MAC from CN, model from the HTTPS title. New `device_type = "phone"` in
discovery. Ingest upserts a Phone asset reconciled by MAC. No secrets, survives
firmware updates (the cert is stable).

**Phase 2 — authenticated enrichment — ✅ DONE (on-phone web read).** When a phone
has a credential (see below), the collector logs into its web API and reads the live
**Display Name, extension (SIP Label), register status, firmware, machine-id (serial)
and vendor** — straight from the phone, which is the source of truth (Intermedia was
rejected: it goes stale when users are terminated/reassigned). `collect_phone_auth.py`
handles **both Yealink firmware generations**:
- **T5x (e.g. T54W):** `GET /api/info?p=Login` publishes `rsaN`/`rsaE` → RSA
  **PKCS#1 v1.5** encrypt the password, send as `pwd=__WUI_ENC__:<hex>` to
  `POST /api/auth/login?p=Login` → `JSESSIONID` cookie → read the account/status pages.
- **T4x:** HTML `g_rsa_n`/`g_rsa_e` + an **AES-128-CBC hybrid** (`<rand>;<JSESSIONID>;
  <password>`, RSA-wrapped key/iv) → `servlet?m=mod_data&p=account-register` etc.

All read-only. A phone with **no** credential still gets phase-1 identity (MAC/model);
enrichment just stays blank. *(Intermedia Unite API — considered and rejected.)*

## Signals collected (how + what we store)

| Phase | Source | Fields |
|---|---|---|
| 1 | TLS cert on 443 (`ssl.get_server_certificate`) | **MAC** (cert CN), Yealink issuer (classify) |
| 1 | HTTPS `GET /` `<title>` | **model** ("Yealink T54W") |
| 1 | discovery | **IP** |
| 2a | authenticated web UI (per-phone cred) | Display Name, extension (account Label), register status, firmware |
| 2b | Intermedia Unite API | Display Name / user, extension, model, firmware — keyed by MAC |

## Data model (web DB `aw_it_inventory_web`)

Phone assets already exist (`type = 'Phone'`, tag `H2TECS-PHN-…`). The Phone type is
**repurposed from mobile to desk/VoIP** (user decision): `phone_details` drops the old
mobile columns (imei / phone_number / carrier / storage_gb / os / plan) and gains
**mac** (partial-unique — the reconciliation key), **extension**, **ip_address**,
**firmware**, **register_status** (model is a shared asset field). The new-phone
modal, `/phones` columns (Extension / IP / MAC), and the icon (handset) follow.
**Destructive — needs `db:push`.**

## API / ingest

`/api/ingest/scan` accepts a **phone** host shape `{ mac, model, ip, …enrichment }`
and reconciles by MAC (new key). A matched phone updates its details; an unmatched
one becomes a discovered-device row (spec 06). Phones never touch the
computer/printer reconcile paths.

## Collector

- `config.yaml`: add the phone subnet to `networks`; add `443` as a phone probe
  port; a `phone_credentials_file` path (phase 2a); optional Intermedia creds (2b).
- `discovery.classify`: TCP 443 open → TLS cert → Yealink issuer ⇒ `"phone"`.
- `collect_phone.py` (new): phase-1 cert/model read; phase-2a authenticated fetch.
- `worker`: phones ride the normal scan + a scheduled phone sweep (reuse the
  scheduler like the printer/computer sweeps).

## Opt-in (spec 13 discovery toggle) — ✅ DONE

VoIP-phone auto-discovery is **off by default** — a `phone` entry was added to the
spec 13 discovery toggles (`/admin`) that **defaults OFF** (computers/printers stay
on). When off, the auto-sweep probes 443 but never collects phones; **manual scan
jobs bypass the toggle**, so a phone you add in the UI is scanned by targeting its IP.
Web: `discovery.ts` `DISCOVERY_TYPES` + a `DEFAULT_ENABLED` map (phone false),
`discovery_settings.deviceType` union, the `discovery-toggles.tsx` switch. Collector:
`ingest.py` `DISCOVERY_DEFAULTS` (phone off, fail-closed), `main.py` `--no-phones` +
`no_phones = not settings['phone']`, `scan_targets(no_phones)`, computer sweep sets it.

## Phases / build plan

1. **Phase 1 — credential-free discovery**: `collect_phone` (cert→MAC, title→model),
   discovery classify, ingest reconcile-by-MAC, discovered-inbox, tests. **AC-1–4, 8.**
   - **1a collector — ✅ DONE**: `collect_phone.py` (`parse_cert`/`model_from_title`/
     `read_phone`), `PhoneInfo` model + `HostResult.phone`, `discovery.classify` phone
     candidate (443, cert-confirmed), `main.py` phone branch, `ports.phone`/
     `phone_timeout` config. 62 collector tests pass. The web ingest already tolerates
     a `phone` host (writes a bare discovered row), so this is safe to ship alone.
   - **1c desk-phone UI repurpose — ✅ DONE** (web): `phone_details` desk fields
     (mac/extension/ipAddress/firmware/registerStatus, mac partial-unique); the
     new-phone modal (`asset-fields.ts`), `/phones` columns (`table-columns.ts`:
     extension/ip/mac + `extensionColumn`), Phone icon (handset), `queries.ts`
     selects/search, csv export, and `Asset.extension` all updated. **Needs `db:push`.**
     752 web tests pass, type+lint clean.
   - **1b web ingest — ✅ DONE**: `ingest.ts` reads `h.phone`, reconciles a phone by
     **MAC** (`phone_details.mac`, a new match key above hostname/ip), populates
     `phone_details` (mac/ip now; extension/firmware/register when phase 2 sends them)
     + the shared `model`, and carries phone identity on a new `machines.phone` jsonb
     for the discovered inbox (`kindMeta` gains a Phone entry → pre-selects type Phone).
     **Needs `db:push`** (machines.phone). 754 web tests pass; 2 ingest phone tests added.

**Credential-free path COMPLETE (1a+1b+1c):** a Yealink on a scanned subnet is
discovered (MAC/model), reconciled by MAC, and either enriches its Phone asset or lands
in the inbox as a Phone.
   - **Opt-in toggle — ✅ DONE**: phone auto-discovery is a spec-13 discovery toggle
     that **defaults OFF** (web `discovery.ts` + the `/admin` switch; collector
     `DISCOVERY_DEFAULTS` + `--no-phones`). Manual scan jobs bypass it.
   - **Manual "Scan now" — ✅ DONE**: `resolveAssetTargets`/`resolveAllTargets` include
     `phone_details.ipAddress`; a "Scan now" button on the phone detail page
     (`thin-detail.tsx`, `scan:write`) enqueues a spec-12 job targeting the phone IP.
     The ingest IP fallback also matches `phone_details.ipAddress`, so a manual phone
     (no MAC yet) links by IP on its first scan, then by MAC after.
2. **Phase 2a — on-phone authenticated enrichment — ✅ DONE**: per-IP credential CSV
   (`phone_creds.py`, gitignored), `collect_phone_auth.py` logs in (T5x RSA
   `__WUI_ENC__` / T4x AES hybrid) and reads Display Name, extension, register status,
   firmware, machine-id (→ asset serial) and vendor; `read_phone(credential=…)` wires
   it; the web ingest stores `phone_details.displayName`/extension/firmware/
   registerStatus and the asset serial/vendor. **AC-5–7.**
3. **Phase 2b — Intermedia Unite API** — **rejected** (stale on terminated/reassigned
   users; the phone's live config is authoritative).

**SPEC 27 COMPLETE** (discovery + desk-phone UI + opt-in toggle + manual scan +
authenticated enrichment, both firmware generations). 86 collector + 762 web tests
pass, type-clean. Deploy: web `npm run db:push` (phone_details desk fields +
`machines.phone`); on the collector, add the phone subnet when auto-discovery is
wanted (or scan phones manually), set the phone toggle on `/admin`, and create the
gitignored `collector/phone_credentials.csv` (`ip,username,password`) for enrichment.

## Consequences

- A new reconciliation key (MAC) in the ingest — must not collide with the existing
  serial match; phones are a separate branch.
- Phase-2a scraping is firmware-fragile; 2b (Intermedia) is the durable source for the
  person/extension data and should be preferred when reachable.
- Phones on a new subnet need the collector host to **route** to it.

## Follow-up

- Other VoIP vendors (Polycom/Cisco) — the cert/issuer classify pattern generalizes.
- Register-status health/alerting (an unregistered phone is "down"), reusing the
  printer-reachability alert machinery.

## Open questions (to resolve before building phase 2)

- The T54W firmware's exact **login + account-data requests** (capture via devtools).
- Whether **Intermedia Unite** exposes an API/export for the device/user inventory.
- Credential-file keying: **MAC** (from cert, preferred) vs IP (if DHCP-reserved).
