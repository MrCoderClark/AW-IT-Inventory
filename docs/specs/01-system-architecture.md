# 01 — System Architecture

**Status:** Draft v1 · **Last updated:** 2026-08-21

How the pieces fit, how data flows, and how it deploys on-prem.

---

## 1. Design principles

- **Separation of identity.** Auth is its own service with its own database. No other
  service reads the auth tables directly — they talk to it over its API and verify JWTs
  via JWKS. This is what makes `aw-auth` portable to future apps.
- **On-prem, cloud-portable.** Everything is plain Docker + standard Postgres + env
  config. No cloud-proprietary services. It *can* lift to a cloud VM later unchanged.
- **Read the fleet, don't push to it.** The collector is agentless and read-only on the
  endpoints. Lower blast radius, nothing to install on 100 machines.
- **BFF, not a sprawl of microservices.** The Next.js app owns inventory data directly
  (it is the backend-for-frontend). We add a service only when isolation demands it
  (auth) or the language demands it (Python scanning).

---

## 2. Services & responsibilities

### 2.1 `web` — Next.js (App Router)
- Serves the UI (React Server Components + client islands) and the inventory API
  (route handlers under `/api/*`).
- Owns `inventorydb` via an ORM (Drizzle recommended — SQL-first, typed, light).
- Verifies access tokens locally using `aw-auth`'s JWKS; refreshes via `aw-auth`.
- Exposes the **ingest API** (`/api/ingest/*`) consumed by the collector, authenticated
  with a service-account bearer token minted by `aw-auth`.

### 2.2 `aw-auth` — Django + DRF
- The identity provider. Accounts, credentials, sessions, tokens, RBAC, MFA, service
  accounts, audit. Own database `authdb`. Django admin doubles as the ops console.
- Signs access tokens (RS256) and publishes public keys at `/.well-known/jwks.json`.
- Full spec: [`02-auth-service-spec.md`](02-auth-service-spec.md).

### 2.3 `collector` — Python worker
- Discovers hosts on `192.168.70.0/24` and `192.168.72.0/24`, classifies them, resolves
  credentials, scans over WinRM/WMI/SMB (Windows) and SNMP (printers), and posts results
  to the ingest API. Scheduled internally (APScheduler / Celery beat).
- Full spec: [`04-collector-agent-spec.md`](04-collector-agent-spec.md).

### 2.4 Infrastructure
- **Postgres** — two logical databases: `authdb` (owned by aw-auth) and `inventorydb`
  (owned by web). Kept separate so auth stays independently portable. Can be one
  Postgres instance with two databases, or two instances for stronger isolation.
- **Redis** — session/rate-limit store and Celery broker for `aw-auth` (email, lockout
  counters) and optionally the collector's job queue.
- **Caddy** — TLS termination + reverse proxy (automatic internal certs or your CA).
- **(optional) MinIO** — S3-compatible object storage for asset photos / printable labels.

---

## 3. Network & trust boundaries

```
┌───────────────────────────── on-prem Docker host ─────────────────────────────┐
│                                                                                │
│   Caddy (443)                                                                  │
│     ├── inventory.local   ─▶ web (Next.js :3000)                               │
│     └── auth.local        ─▶ aw-auth (gunicorn :8000)                          │
│                                                                                │
│   web ─▶ inventorydb        aw-auth ─▶ authdb        both ─▶ redis             │
│   web ─(JWKS, token)▶ aw-auth                                                   │
│                                                                                │
│   collector ─(service-account bearer)▶ web /api/ingest                         │
│   collector ─(client-credentials)▶ aw-auth  (to obtain its token)              │
└────────────────────────────────────────────────────────────────────────────────┘
        collector ──▶ 192.168.70.0/24 (WinRM/WMI/SMB + SNMP printers)
        collector ──▶ 192.168.72.0/24 (WinRM/WMI/SMB, workgroup)
```

**Boundaries:**
- Browsers only ever reach Caddy. Internal services are not exposed directly.
- The collector is the *only* component that touches endpoint credentials, and the only
  one initiating connections into the endpoint subnets.
- `authdb` is reachable only by `aw-auth`; `inventorydb` only by `web`.

---

## 4. Authentication flow (users)

1. Browser hits `web`; middleware finds no valid session → redirect to login.
2. `web` collects credentials and calls `aw-auth` `POST /auth/login`.
3. `aw-auth` verifies, (optionally challenges MFA), returns **access JWT** + **refresh
   token**. `web` stores them in **httpOnly, Secure, SameSite** cookies.
4. On each request, `web` middleware verifies the access JWT locally against JWKS (no
   round-trip). Claims carry `sub`, `org`, `roles`, `perms`.
5. On expiry, `web` calls `POST /auth/token/refresh` (rotation); on refresh-reuse
   detection `aw-auth` revokes the token family and forces re-login.
6. RBAC: UI hides what the user can't do; **the server re-checks `perms` on every
   mutating route** — hidden ≠ secured.

## 5. Machine-to-machine flow (collector)

1. Admin creates a **service account** in `aw-auth` with scope `ingest:write`; gets a
   client id + secret (shown once).
2. Collector exchanges them at `POST /auth/token/client` (client-credentials grant) for a
   short-lived access token.
3. Collector posts scan batches to `web` `/api/ingest/*` with that bearer token; `web`
   verifies scope `ingest:write` before accepting.
4. Keys are rotatable/revocable from the UI; every ingest is audited.

---

## 6. Data flow: a scan becomes a record

```
discover (ping/ARP)  ─▶  classify (OS/printer, subnet)  ─▶  resolve credential (vault)
     ─▶  collect (WinRM/WMI/SMB/SNMP)  ─▶  normalize  ─▶  POST /api/ingest/scan
     ─▶  reconcile (match serial→uuid→mac→hostname)
             ├─ match  ─▶ update asset + append snapshot + audit event
             └─ no match ─▶ "Discovered devices" inbox (human links or creates asset)
```

Reconciliation never silently creates a *managed* asset — unmatched machines land in a
review inbox. This keeps the source of truth trustworthy. Detail in [`03`](03-inventory-data-model.md)
and [`04`](04-collector-agent-spec.md).

---

## 7. Deployment (Docker Compose, on-prem)

Single `docker-compose.yml` on one VM to start; each service independently scalable later.

```yaml
# illustrative — not the final file
services:
  caddy:      { image: caddy, ports: ["443:443"], depends_on: [web, auth] }
  web:        { build: ./web,      env_file: .env.web,   depends_on: [postgres, auth] }
  auth:       { build: ./aw-auth,  env_file: .env.auth,  depends_on: [postgres, redis] }
  collector:  { build: ./collector,env_file: .env.collector, depends_on: [web] }
  postgres:   { image: postgres:16, volumes: [pgdata:/var/lib/postgresql/data] }
  redis:      { image: redis:7 }
volumes: { pgdata: {} }
```

- **Config:** all via env / mounted secrets. Nothing sensitive in the repo.
- **TLS:** Caddy issues internal certs or serves your enterprise CA cert.
- **Backups:** nightly `pg_dump` of both DBs to a retained location; documented restore.
- **Observability:** structured JSON logs per service; `/healthz` on each; collector
  emits a run report per scan (hosts reached, failures, changes).
- **Upgrades:** rebuild + `compose up -d`; Django migrations gated in an entrypoint;
  web migrations run on deploy.

---

## 8. Environments

| Env | Purpose | Notes |
|---|---|---|
| dev | laptops | Docker Compose; seeded demo data; collector points at a lab subnet or mock. |
| staging | a spare VM | Mirrors prod; real subnets in read-only/dry-run collector mode first. |
| prod | the on-prem VM | Real creds in vault; scheduled scans; backups on. |

---

## 9. Technology choices (rationale in brief)

| Concern | Choice | Why |
|---|---|---|
| Frontend + inventory API | Next.js App Router, TS | One codebase for UI + BFF; RSC for dense data screens. |
| Styling / components | Tailwind v4 + shadcn/ui | Own the component source; fast, consistent, themeable. |
| Inventory ORM | Drizzle | SQL-first, typed, light; easy to reason about for a data-heavy app. |
| Auth service | Django + DRF | Most mature identity primitives; admin console; unifies with Python. |
| Scanning | Python (pywinrm, impacket, pysnmp) | Best ecosystem for WMI/WinRM/SNMP; matches the auth language. |
| DB | PostgreSQL | Relational fit for RBAC + inventory; JSONB for flexible specs. |
| Cache/queue | Redis | Rate-limit, sessions, Celery broker. |
| Proxy/TLS | Caddy | Simplest correct TLS on-prem. |
