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

## Config

Copy `.env.example` to `.env` and adjust. Key vars: `SECRET_KEY`, `DEBUG`,
`ALLOWED_HOSTS`, `DATABASE_URL`, `CORS_ALLOWED_ORIGINS`, `ACCESS_TOKEN_MINUTES`,
`REFRESH_TOKEN_DAYS`.
