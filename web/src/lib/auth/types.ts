export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  is_staff: boolean;
  mfa_enabled: boolean;
  date_joined: string;
  roles: string[];
  permissions: string[];
}

export interface TokenPair {
  access: string;
  refresh: string;
}

export interface RefreshResult {
  access: string;
  refresh?: string; // present when ROTATE_REFRESH_TOKENS is on
}

/** A user as seen by the admin console (aw-auth `AdminUserSerializer`). */
export interface AdminUser {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  is_staff: boolean;
  is_superuser: boolean;
  mfa_enabled: boolean;
  date_joined: string;
  last_login: string | null;
  roles: string[];
}

/** A role and its permission codes (aw-auth `RoleSerializer`). */
export interface Role {
  name: string;
  description: string;
  is_system: boolean;
  permissions: string[];
}

/** One active session (outstanding refresh token) for the signed-in user. */
export interface Session {
  jti: string;
  created_at: string;
  expires_at: string;
}

/**
 * Result of an aw-auth call made on the user's behalf. `error` carries the
 * first human-readable message aw-auth returned (its DRF 400 detail), so the UI
 * can surface aw-auth's own password/validation messages verbatim.
 */
export type AuthApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };
