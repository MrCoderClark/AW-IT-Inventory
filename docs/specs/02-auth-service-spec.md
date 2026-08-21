# 02 — `aw-auth` Standalone Auth Service Spec

**Status:** Draft v1 · **Last updated:** 2026-08-21 · **Stack:** Django 5 + DRF + PostgreSQL

A self-owned, production-grade identity provider, built as a standalone service so it can
be reused by this app and every future app. "Own it" means own the code, data and
deployment — while standing on hardened primitives (Django auth, Argon2, RS256 JWT,
refresh rotation) rather than hand-rolling crypto.

---

## 1. Scope & feature set

| Area | Features |
|---|---|
| **Accounts** | Registration, email verification, profile, deactivate/reactivate, soft delete |
| **Credentials** | Argon2id hashing, password policy, breach check (HIBP k-anonymity), forced rotation |
| **Login** | Password login, account lockout, rate limiting, device/IP capture |
| **MFA** | TOTP (authenticator apps) + recovery codes; WebAuthn/passkeys (later phase) |
| **Sessions** | Server-tracked sessions, device list, remote revoke, "log out everywhere" |
| **Tokens** | RS256 access JWT (short TTL) + rotating opaque refresh tokens with reuse detection; JWKS |
| **RBAC** | Roles → granular permissions; org-scoped; default role set; server-side enforcement |
| **Multi-tenant** | Organizations; a user can belong to many orgs with different roles |
| **Machine identity** | Service accounts / API keys with scopes; client-credentials grant (for the collector) |
| **Password recovery** | Forgot/reset via signed, single-use, expiring tokens |
| **Audit** | Append-only audit log of every security-relevant action |
| **Admin** | Django admin console for users/roles/permissions/service accounts |
| **Portability** | OpenAPI schema, JWKS, OIDC discovery (phase 4), client SDKs |

---

## 2. Data model

PostgreSQL, UUID primary keys, `created_at`/`updated_at` on every table.

### Identity
- **user** — `id`, `email` (unique, citext), `email_verified`, `password_hash`,
  `is_active`, `is_staff`, `mfa_enabled`, `last_login_at`, `failed_login_count`,
  `locked_until`, `password_changed_at`.
- **organization** — `id`, `name`, `slug` (unique). Tenancy boundary.
- **membership** — `user_id`, `org_id`, `is_default`, joined_at. (M:N user↔org)

### Authorization (RBAC)
- **permission** — `id`, `code` (e.g. `asset:read`, `asset:write`, `user:admin`,
  `ingest:write`), `description`. Codes are `resource:action`, namespaced per app.
- **role** — `id`, `org_id` (nullable = global/system role), `name`, `description`,
  `is_system`.
- **role_permission** — `role_id`, `permission_id`.
- **user_role** — `user_id`, `role_id`, `org_id` (scope). A user's effective permissions
  = union of permissions across their roles in the active org.

### Sessions & tokens
- **session** — `id`, `user_id`, `org_id`, `user_agent`, `ip`, `created_at`,
  `last_seen_at`, `revoked_at`, `revoke_reason`.
- **refresh_token** — `id`, `user_id`, `session_id`, `token_hash` (sha256 of the secret),
  `family_id`, `rotated_from_id`, `expires_at`, `used_at`, `revoked_at`. Rotation +
  **reuse detection**: presenting an already-used token revokes the whole `family_id`.
- **client_app** — `id`, `client_id`, `name`, `type` (`confidential`/`public`),
  `redirect_uris[]`, `client_secret_hash`, `allowed_scopes[]`. For OIDC (phase 4) and to
  register which apps may use this IdP.

### MFA
- **totp_device** — `user_id`, `secret_encrypted`, `confirmed`, `last_used_step`.
- **recovery_code** — `user_id`, `code_hash`, `used_at`.

### Machine identity
- **service_account** — `id`, `org_id`, `name`, `client_id`, `secret_hash`, `scopes[]`,
  `expires_at`, `last_used_at`, `disabled_at`, `created_by`. The collector authenticates
  as one of these.

### Recovery & verification
- **email_token** — `user_id`, `purpose` (`verify`/`reset`), `token_hash`, `expires_at`,
  `used_at`.

### Audit
- **audit_event** — `id`, `actor_type` (`user`/`service`/`system`), `actor_id`, `action`,
  `target_type`, `target_id`, `ip`, `user_agent`, `metadata` (jsonb), `created_at`.
  Append-only; never updated or deleted through the app.

---

## 3. Token design

- **Access token** — JWT, **RS256** (asymmetric, so clients verify without a shared
  secret). TTL 10–15 min. Claims:
  ```json
  {
    "iss": "https://auth.local",
    "sub": "<user-uuid>",
    "org": "<org-uuid>",
    "sid": "<session-uuid>",
    "roles": ["technician"],
    "perms": ["asset:read", "asset:write"],
    "typ": "access",
    "iat": 0, "exp": 0, "jti": "<uuid>"
  }
  ```
  Service-account tokens carry `"typ":"service"` and `scopes` instead of `roles`.
- **Refresh token** — opaque random 256-bit string; only its hash is stored. Rotated on
  every use; `family_id` links a rotation chain; reuse of a spent token = compromise
  signal → revoke family, audit, force re-login. TTL days–weeks (configurable), sliding.
- **Signing keys** — RSA keypair; **JWKS** published at `/.well-known/jwks.json` with a
  `kid`. Support **key rotation**: publish new + old public keys during overlap.
- **Where tokens live in `web`** — httpOnly, Secure, SameSite=Lax cookies. Never in
  localStorage.

---

## 4. API surface (REST/JSON, versioned `/v1`)

### Public auth
| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/auth/register` | Create account (if self-serve enabled) |
| POST | `/v1/auth/verify-email` | Confirm email token |
| POST | `/v1/auth/login` | Password login → tokens or MFA challenge |
| POST | `/v1/auth/mfa/verify` | Complete MFA challenge → tokens |
| POST | `/v1/auth/token/refresh` | Rotate refresh → new access + refresh |
| POST | `/v1/auth/logout` | Revoke current session |
| POST | `/v1/auth/password/forgot` | Send reset email |
| POST | `/v1/auth/password/reset` | Reset with token |
| POST | `/v1/auth/password/change` | Change while authenticated |
| GET  | `/v1/auth/me` | Current identity, org, roles, perms |

### MFA & sessions (authenticated)
| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/mfa/totp/setup` | Return provisioning URI / QR secret |
| POST | `/v1/mfa/totp/confirm` | Confirm + enable, return recovery codes |
| POST | `/v1/mfa/totp/disable` | Disable (requires re-auth) |
| POST | `/v1/mfa/recovery/regenerate` | New recovery codes |
| GET  | `/v1/sessions` | List active sessions/devices |
| DELETE | `/v1/sessions/{id}` | Revoke a session |
| POST | `/v1/sessions/revoke-all` | Log out everywhere |

### Machine identity
| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/auth/token/client` | Client-credentials grant → service access token |
| POST | `/v1/service-accounts` | Create (returns secret once) — `user:admin` |
| GET  | `/v1/service-accounts` | List |
| POST | `/v1/service-accounts/{id}/rotate` | Rotate secret |
| POST | `/v1/service-accounts/{id}/disable` | Disable |

### Admin (RBAC-gated: `user:admin`)
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/v1/admin/users` | List / invite users |
| PATCH/DELETE | `/v1/admin/users/{id}` | Update / deactivate |
| GET/POST | `/v1/admin/roles` | List / create roles |
| POST | `/v1/admin/users/{id}/roles` | Assign/revoke roles |
| GET | `/v1/admin/permissions` | List permission catalog |
| GET | `/v1/admin/audit` | Query audit log |

### Discovery
| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/jwks.json` | Public signing keys |
| GET | `/.well-known/openid-configuration` | OIDC discovery (phase 4) |
| GET | `/v1/schema` | OpenAPI (drf-spectacular) |

---

## 5. Default roles & permission catalog

Seeded on first run; editable after.

| Role | Permissions (inventory app namespace) |
|---|---|
| **Owner** | `*` (all), including `user:admin`, `org:admin` |
| **Admin** | `user:admin`, `asset:*`, `scan:*`, `report:read` |
| **Technician** | `asset:read`, `asset:write`, `scan:read`, `assignment:write` |
| **Auditor** | `asset:read`, `scan:read`, `report:read`, `audit:read` |
| **Viewer** | `asset:read`, `report:read` |
| **service:collector** | `ingest:write`, `asset:read` (bound to service accounts, not humans) |

Permission codes are open-ended so future apps register their own namespaces
(`billing:read`, etc.) against the same IdP.

---

## 6. Security requirements

- **Hashing:** Argon2id (argon2-cffi) with tuned params; pepper via env.
- **Rate limiting & lockout:** django-axes + Redis counters; exponential backoff; lock
  after N failures, unlock after cooldown; per-IP and per-account.
- **Transport:** TLS only; HSTS at the proxy; secure cookie flags.
- **CSRF:** enforced on cookie-based browser flows; exempt bearer-token API paths.
- **CORS:** strict allowlist of client-app origins.
- **Secrets:** signing keys, pepper, email creds in env/mounted secrets or a vault —
  never in the repo.
- **PII minimization:** store email + minimal profile only.
- **Audit:** every login, failure, token issue/rotate/revoke, role change, MFA change,
  service-account action.
- **Password reset / verification:** single-use, expiring, signed tokens; constant-time
  compares; no user-enumeration in responses.

---

## 7. Library choices (Django)

| Need | Library |
|---|---|
| API framework | Django REST Framework |
| JWT + rotation | djangorestframework-simplejwt (customized) or Authlib |
| OIDC provider (phase 4) | Authlib / django-oauth-toolkit |
| TOTP MFA | django-otp + qrcode |
| Lockout/rate limit | django-axes |
| Hashing | argon2-cffi (Argon2PasswordHasher) |
| Async tasks (email) | Celery + Redis |
| OpenAPI | drf-spectacular |
| Settings | django-environ |

---

## 8. Portability contract

What a future app needs to integrate `aw-auth`:

1. **Verify tokens locally** — fetch JWKS, validate RS256 access JWTs, read `perms`.
2. **A thin SDK per platform:**
   - **Next.js SDK** — middleware (session cookie ↔ token verify + refresh), `getUser()`,
     `requirePermission()` guards, login/callback handlers.
   - **Python SDK** — token verification, client-credentials helper, decorators.
3. **Register the app** as a `client_app` (redirect URIs, allowed scopes).
4. **Reuse or extend** the permission catalog with the app's own namespace.

The auth service knows nothing about inventory. That ignorance is the feature — it keeps
`aw-auth` a clean, reusable identity layer.

---

## 9. Open questions / decisions to confirm later

- Self-serve registration **off** by default (admin-invite only) for an internal tool? (recommended: yes)
- Refresh TTL and access TTL exact values (default: 15 min / 14 days sliding).
- Whether to adopt OIDC now vs phase 4 (recommended: phase 4; JWT+JWKS is enough for the first apps).
- Directory sync (AD/Entra) for auto-provisioning users — later.
