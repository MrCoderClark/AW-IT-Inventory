# CLAUDE.md — OPUS IT Inventory

Project context for AI agents working in this repo. Read this first.

## What this is

**OPUS** — an on-premise, enterprise IT asset management system for computers,
monitors, printers, phones and related IT items (built to manage 100+ machines).
Three deployables + Postgres, all self-hosted.

- Specs: `docs/specs/` · Design system: `docs/Design/` · Progress: `PROGRESS.md`

## Architecture

| Service | Dir | Stack | Responsibility |
|---|---|---|---|
| **web** | `web/` | Next.js 16 (App Router) + Tailwind v4 + shadcn/ui + Drizzle | The OPUS UI **and** its API (route handlers). Owns `aw_it_inventory` DB. Exposes `/api/ingest/scan`. |
| **aw-auth** | `aw-auth/` | Django 6 + DRF + SimpleJWT (uv) | Standalone, portable identity provider: RBAC, RS256/JWKS, MFA-ready, service accounts. Owns `aw_auth` DB. |
| **collector** | `collector/` | Python 3.12 (uv) | Agentless scanner: discovers subnets, WinRM (Windows) + SNMP (printers), posts to the ingest API. |

**Data flow:** `collector scan --ingest` → aw-auth client-credentials token → web
`/api/ingest/scan` (verifies service token via JWKS + `ingest:write` scope) →
reconcile by serial → `machines` table → drawer shows live health for matched assets.

**Auth model:** aw-auth signs **RS256** access + rotating refresh tokens; publishes
JWKS at `/.well-known/jwks.json`. Clients verify **locally** via JWKS (`jose` in web).
Users → cookies (httpOnly, server-to-server only). Machines → service accounts
(client-credentials grant, `typ=service`, `scopes`).

## Databases (on-prem Postgres @ 192.168.70.10)

- `aw_auth` — Django-managed (aw-auth). Connection in `aw-auth/.env` `DATABASE_URL`.
- `aw_it_inventory` — Drizzle-managed (web). Connection in `web/.env` `DATABASE_URL`.

> ⚠️ **Keep them separate.** `drizzle-kit push` DROPS any table not in its schema —
> pointing web at the auth/shared DB will try to delete the Django tables.

## Fleet (for the collector)

All Windows. Domain devices (incl. printers) on `192.168.70.0/24`; workgroup on
`192.168.72.0/24`. Local-admin credential profiles (secrets in `collector/.env`):
Win10 `infotech`, Win11 workgroup `Intech`, Win11 AD `Infotech`. Resolved per subnet
with ordered fallback (`collector/config.yaml`).

## Run it

```bash
# web (in web/)
npm run dev                     # dev server (Turbopack)
npm run db:push                 # apply Drizzle schema
npm run db:seed                 # seed sample fleet
npm run db:studio               # inspect DB

# aw-auth (in aw-auth/)  — uv-managed
uv run python manage.py runserver          # dev
uv run python manage.py migrate
uv run python manage.py seed_rbac
uv run python manage.py create_service_account collector --scopes ingest:write asset:read
# prod-like: uv run granian --interface wsgi config.wsgi:application --host 127.0.0.1 --port 8000 --workers 2 --blocking-threads 8

# collector (in collector/) — uv-managed
uv run python main.py scan --target 192.168.72.10/32          # dry-run
uv run python main.py scan --target 192.168.72.0/24 --ingest  # scan + ingest
```

## Working conventions

- **Branch per phase.** Create the feature branch **before** writing any code; never
  accumulate work on `main`. Merge via GitHub PR. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **The user runs all terminal commands** (npm, uv, git, servers). Agents: provide
  exact copy-pasteable commands; don't execute them unless explicitly asked.
- **Shell is PowerShell.** Use `Invoke-RestMethod` for API testing (not `curl.exe` —
  quoting breaks). Multi-line commands often mis-paste; prefer single-line.

## Gotchas learned (don't relearn these)

- **Next.js 16**, not 15: middleware is now **`proxy.ts`** (`export function proxy`);
  `params`/`searchParams`/`cookies()` are **async** (await them); Turbopack is default.
  Read version-matched docs in `web/node_modules/next/dist/docs/` before Next changes.
- **shadcn preset = Nova → Base UI** (not Radix): triggers use **`render={<Comp/>}`**,
  not `asChild`; `Menu.GroupLabel` must be inside a `DropdownMenuGroup`.
- **TanStack Table is pinned to v8** (v9 is an unstable API rewrite). Don't upgrade.
- **`@tanstack/react-table` etc. import maps** — keep `getCoreRowModel` (v8), not v9's `create*`.
- **granian on Windows**: Ctrl+C doesn't reliably stop multi-worker; use `--workers 1`
  locally or kill by port. Use `runserver` for everyday dev.
- **Stale dev server = 404s** after `git pull`/route changes: kill all `node`, restart
  one `next dev`, use the exact printed port (relative `fetch` hits that origin).
- **Env files**: `web/.env`, `aw-auth/.env`, `collector/.env` (all gitignored). Only
  `*.example` are committed. Neon/SQLAlchemy `postgresql+asyncpg://` scheme is normalized
  in aw-auth settings; web/collector expect a plain `postgres://` URL.

## Where things live

```
web/            Next.js app (UI + API). src/db (Drizzle), src/lib/auth (auth client), src/components
aw-auth/        Django identity service. accounts/ (User, ServiceAccount, JWKS), rbac/ (roles/perms), config/
collector/      Python scanner. discovery/creds/collect_windows/collect_snmp/ingest, config.yaml
docs/           specs/ + Design/
```
