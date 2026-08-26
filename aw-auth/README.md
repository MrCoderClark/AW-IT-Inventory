# aw-auth

Standalone identity service for OPUS (and future apps). Django 6 + DRF + SimpleJWT.
Full design: [`../docs/specs/02-auth-service-spec.md`](../docs/specs/02-auth-service-spec.md).

## Phase 0 (this build)

Runnable auth core:

- Email-based custom **User** with **Argon2id** hashing
- **RBAC**: `Permission` (codes like `asset:read`) + `Role`; effective permissions
  embedded as `roles`/`perms` claims in the access token
- Endpoints under `/v1/auth/`: `register`, `login`, `token/refresh`, `logout`, `me`
- Django **admin** for managing users, roles and permissions
- **OpenAPI** at `/v1/schema` and Swagger UI at `/v1/docs`
- Dev uses **SQLite** (no infra); set `DATABASE_URL` for Postgres

> Later steps on this service: refresh-token reuse detection, TOTP MFA,
> service accounts / client-credentials (for the collector), full OIDC.

## RS256 + JWKS (token verification for any app)

Generate an RSA keypair once; the service then signs with **RS256** and publishes
its public key so clients verify tokens locally (no `/me` round-trip):

```bash
uv run python manage.py generate_keys   # writes keys/private.pem + keys/public.pem (gitignored)
# restart the server so RS256 activates
```

- **JWKS:** `GET /.well-known/jwks.json` — the public key as a JWK (with a `kid`)
- **Discovery:** `GET /.well-known/openid-configuration`
- Access tokens are signed RS256 and carry that `kid` in the header, so both
  `jose` (JS) and `PyJWKClient` (Python) can select the key and verify.
- Without keys the service stays on HS256 (dev) and JWKS returns `{"keys": []}`.

## Run it (uv)

```bash
# from aw-auth/
uv run python manage.py migrate
uv run python manage.py seed_rbac          # seed roles + permissions
uv run python manage.py createsuperuser    # your admin login
uv run python manage.py runserver
```

- API base: http://127.0.0.1:8000/v1/auth/
- Admin:    http://127.0.0.1:8000/admin/
- Docs:     http://127.0.0.1:8000/v1/docs

`runserver` is for **development only**.

## Run in production (granian)

[granian](https://github.com/emmett-framework/granian) is a fast, modern,
cross-platform WSGI/ASGI server. Static files (incl. the admin) are served by
WhiteNoise, so no separate static server is needed.

```bash
# 1) set DEBUG=False and a real SECRET_KEY + ALLOWED_HOSTS in .env
# 2) collect static assets (WhiteNoise serves these when DEBUG=False)
uv run python manage.py collectstatic --noinput

# 3) serve (WSGI)
uv run granian --interface wsgi config.wsgi:application \
  --host 0.0.0.0 --port 8000 --workers 2 --blocking-threads 8
```

- `ALLOWED_HOSTS` must include the host you reach it on (e.g. `127.0.0.1`, the
  server's IP/hostname).
- `--workers` ~ CPU cores; `--blocking-threads` caps the per-worker pool (WSGI
  is blocking). Without these, granian warns about a very large default thread
  pool. Add `--reload` for a prod-like local run with restarts.
- This is the command the Dockerfile will use in the on-prem deployment.

## Quick smoke test

```bash
# register
curl -X POST http://127.0.0.1:8000/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"tech@opus.local","full_name":"Tech","password":"Sup3rStr0ng!"}'

# login -> access + refresh
curl -X POST http://127.0.0.1:8000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"tech@opus.local","password":"Sup3rStr0ng!"}'

# me (use the access token)
curl http://127.0.0.1:8000/v1/auth/me -H "Authorization: Bearer <ACCESS>"
```

## Service accounts (machine identity)

Machine clients (e.g. the collector) authenticate with the **client-credentials
grant** and receive a short-lived RS256 access token carrying **scopes** instead
of user roles.

```bash
# create one (prints client_id + secret once)
uv run python manage.py create_service_account collector --scopes ingest:write asset:read

# exchange credentials for a token
curl -X POST http://127.0.0.1:8000/v1/auth/token/client \
  -H "Content-Type: application/json" \
  -d '{"client_id":"svc_…","client_secret":"…"}'
# -> { "access": "<jwt>", "token_type": "Bearer", "expires_in": 900 }
```

The token has `typ=service` and a `scopes` claim; resource servers (the web
ingest API) verify it via JWKS and check for the required scope. Manage/disable
accounts in the Django admin.

## Config

Copy `.env.example` to `.env` and adjust. Key vars: `SECRET_KEY`, `DEBUG`,
`ALLOWED_HOSTS`, `DATABASE_URL`, `CORS_ALLOWED_ORIGINS`, `ACCESS_TOKEN_MINUTES`,
`REFRESH_TOKEN_DAYS`.
