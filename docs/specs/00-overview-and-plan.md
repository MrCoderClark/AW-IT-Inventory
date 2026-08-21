# aw-inventory — Overview & Delivery Plan

**Status:** Draft v1 · **Owner:** IT · **Last updated:** 2026-08-21

An on-premise, enterprise-grade IT asset management system for computers, monitors,
printers, phones and related IT items — built to maintain 100+ machines and to grow
into the team's system of record for hardware.

---

## 1. Goals

1. **Single source of truth** for every IT asset: what it is, where it is, who has it,
   its lifecycle state, warranty, and full history.
2. **Automated discovery & scanning** — Python reaches out to the fleet, collects
   hardware/health/software/file/compliance data, and keeps records current with no
   manual re-typing.
3. **Production-grade, self-owned auth** — a standalone identity provider (`aw-auth`)
   reusable across this and future apps, with RBAC, MFA, sessions and machine identity.
4. **Distinctive, dense, enterprise UI** — a "technical registry / operator console"
   aesthetic that reads as a serious internal tool, not a templated marketing site.
5. **Self-hosted / on-prem** — asset data and admin credentials never leave the network.

### Non-goals (for now)
- Cloud/SaaS multi-customer hosting (design stays cloud-portable, but we deploy on-prem).
- Full ITSM ticketing / helpdesk (we track maintenance state, not a service desk).
- MDM / remote control of endpoints (we read, we don't push policy — yet).

---

## 2. System at a glance

Three deployables plus infrastructure, all on one on-prem Docker host:

| Service | Tech | Responsibility |
|---|---|---|
| **web** | Next.js (App Router) + Tailwind v4 + shadcn/ui | The inventory UI **and** its API (route handlers + ORM). Exposes the ingest API. |
| **aw-auth** | Django + DRF + Postgres | Standalone identity provider: accounts, RBAC, MFA, tokens, service accounts. Portable to future apps. |
| **collector** | Python worker | Agentless discovery + scanning of the fleet over WinRM/WMI/SMB/SNMP; posts results to the ingest API. |
| infra | Postgres ×2 DBs, Redis, Caddy (TLS) | Data, cache/queue/rate-limit, reverse proxy. |

```
                         192.168.70.0/24 (AD)        192.168.72.0/24 (workgroup)
                         PCs · printers(SNMP)         PCs
                              ▲                          ▲
                              │ WinRM/WMI/SMB/SNMP        │
                        ┌─────┴──────────────────────────┴─────┐
   Browser ──TLS──▶ Caddy ─▶ web (Next.js) ◀── ingest ── collector (Python)
                              │  │                         │  service-account
                              │  └── inventorydb (Postgres) │  API key
                              │                             ▼
                              └── verifies JWT (JWKS) ─▶ aw-auth (Django) ─ authdb
```

Full detail in [`01-system-architecture.md`](01-system-architecture.md).

---

## 3. Component specs (this folder)

| Doc | What it covers |
|---|---|
| [`01-system-architecture.md`](01-system-architecture.md) | Services, topology, data flow, deployment, security posture |
| [`02-auth-service-spec.md`](02-auth-service-spec.md) | `aw-auth`: data model, endpoints, tokens, RBAC, MFA, service accounts, portability |
| [`03-inventory-data-model.md`](03-inventory-data-model.md) | Assets, categories, lifecycle, people, locations, warranty, audit, scan linkage |
| [`04-collector-agent-spec.md`](04-collector-agent-spec.md) | Discovery, credential vault, scan modules, scheduling, ingest contract |
| [`05-frontend-spec.md`](05-frontend-spec.md) | Next.js app structure, routes, components, auth integration, data layer |
| [`../design/design-system.md`](../design/design-system.md) | Visual language, tokens, typography, component patterns |

---

## 4. Delivery roadmap

Phased so value ships early and risk is front-loaded onto the hard parts (auth, discovery).

### Phase 0 — Foundations (infra + auth core)
- Repo + Docker Compose skeleton (web, auth, postgres, redis, caddy).
- `aw-auth` MVP: register/login/logout, JWT access + rotating refresh, JWKS, password
  reset, argon2, audit log, admin console. RBAC roles + permissions seeded.
- Next.js shell wired to `aw-auth` (login, session, protected routes).
- **Exit:** a user can log in to an empty app; auth is real.

### Phase 1 — Inventory core (manual + import)
- Inventory data model + migrations. Categories & lifecycle seeded to match the fleet.
- Registry screen (three-pane), asset detail panel, create/edit, CSV import.
- Warranty tracking + "expiring soon" surfacing. Audit/activity timeline.
- **Exit:** the whole fleet can be entered/imported and managed by hand.

### Phase 2 — Discovery & scanning (the Python engine)
- Collector: subnet discovery (70/72), OS/printer classification.
- Credential vault + resolution rules + ordered fallback + per-host cache.
- Windows collectors (hardware, health, software, local admins, BitLocker/AV).
- SNMP printer collector. File-check rules engine.
- Ingest API + reconciliation (match scan → asset by serial/hostname/MAC).
- "Discovered devices" inbox for unmatched machines.
- **Exit:** records self-update on a schedule; new devices appear automatically.

### Phase 3 — MFA, service accounts hardening, reports
- TOTP MFA + recovery codes; session/device management UI.
- Service-account lifecycle UI (rotate/revoke collector keys).
- Reports: warranty expiry, aging, software/license, compliance exceptions, file-check hits.
- **Exit:** production-ready security + reporting.

### Phase 4 — OIDC provider + SDKs (portability payoff)
- `aw-auth` OIDC/OAuth2 authorization-code surface; client-app registry.
- Next.js SDK (middleware + hooks) and Python client SDK, published internally.
- **Exit:** a future app integrates auth in an afternoon.

### Later / optional
- Optional installed agent for roaming laptops. WebAuthn/passkeys. Label printing.
- AD/Entra directory sync for people. Object storage (MinIO) for asset photos.

---

## 5. Key risks & how the design addresses them

| Risk | Mitigation |
|---|---|
| Central store of local-admin creds is a juicy target | Encrypted vault, least-privilege, full audit, never in plaintext config, isolated network path. See [`04`](04-collector-agent-spec.md). |
| Workgroup remote WMI/WinRM is finicky (UAC token filtering) | Documented host prep (`LocalAccountTokenFilterPolicy`, WinRM TrustedHosts); SMB/WMI fallback; per-host "what worked" cache. |
| Auth is easy to get subtly wrong | Build on hardened primitives (Django auth, Argon2, SimpleJWT), not hand-rolled crypto; refresh-token rotation + reuse detection; audit everything. |
| Scan reconciliation creates duplicates | Deterministic match keys (serial → UUID → MAC → hostname), unmatched go to a review inbox, never silent auto-create of managed assets. |
| UI drifts into generic "AI-generated" look | A committed design system with a specific POV (see [`design-system.md`](../design/design-system.md)) and an explicit anti-pattern list. |

---

## 6. Definition of "production-ready"

- TLS everywhere; secrets in env/vault; no plaintext creds anywhere in the repo.
- Automated backups of both Postgres DBs; documented restore.
- Health checks + structured logging on every service; scan runs produce reports.
- RBAC enforced server-side (not just hidden UI); audit log for every mutating action.
- Documented runbook: deploy, upgrade, rotate keys, add a credential profile, restore.
