export const AUDIT_ACTIONS = [
  "software_deploy",
  "app_upgrade",
  "os_patch_install",
  "missing_update_check",
  "reboot",
  "reboot_schedule",
  "script_run",
  "remote_session",
  "assignment_change",
  "asset_update",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditStatus = "pending" | "succeeded" | "failed" | "canceled";

export type AuditSource = "admin_console" | "scheduled" | "collector";

export function formatInstallSummary(name: string, version: string | null): string {
  if (version) {
    return `Installed ${name} ${version}`;
  }
  return `Installed ${name}`;
}

export function formatAppUpgradeSummary(
  name: string,
  from: string | null,
  to: string | null,
): string {
  if (from && to) {
    return `Updated ${name} ${from} → ${to}`;
  }
  if (to) {
    return `Updated ${name} → ${to}`;
  }
  return `Updated ${name}`;
}
