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
