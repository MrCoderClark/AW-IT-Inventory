import {
  Activity,
  Bell,
  Boxes,
  Printer,
  Radar,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";

import type { NotificationSeverity, NotificationType } from "@/lib/data";

/** Presentation maps shared by the bell panel and the /notifications page
   (spec 19), so both render each type/severity the same way. Pure data — safe to
   import from any client component. */

export const NOTIFICATION_ICON: Record<NotificationType, LucideIcon> = {
  "printer-down": Printer,
  "printer-recovery": Printer,
  "printer-install": Printer,
  "printer-install-failed": Printer,
  "software-deploy": Boxes,
  "software-deploy-failed": Boxes,
  "patch-install": RefreshCw,
  "patch-install-failed": RefreshCw,
  "script-run": TerminalSquare,
  "script-run-failed": TerminalSquare,
  "compliance-at-risk": ShieldAlert,
  "compliance-recovered": ShieldCheck,
  "metric-threshold": Activity,
  "metric-recovered": Activity,
  "scan-failed": ScanLine,
  "device-discovered": Radar,
  "warranty-expiring": ShieldAlert,
};

export const NOTIFICATION_FALLBACK_ICON = Bell;

export const NOTIFICATION_TYPE_LABEL: Record<NotificationType, string> = {
  "printer-down": "Printer down",
  "printer-recovery": "Printer recovery",
  "printer-install": "Printer install",
  "printer-install-failed": "Printer install failed",
  "software-deploy": "Software deployed",
  "software-deploy-failed": "Software deploy failed",
  "patch-install": "Patch install",
  "patch-install-failed": "Patch install failed",
  "script-run": "Script ran",
  "script-run-failed": "Script failed",
  "compliance-at-risk": "Compliance at risk",
  "compliance-recovered": "Compliance recovered",
  "metric-threshold": "Metric threshold",
  "metric-recovered": "Metric recovered",
  "scan-failed": "Scan failed",
  "device-discovered": "Device discovered",
  "warranty-expiring": "Warranty",
};

export const NOTIFICATION_SEVERITY_VAR: Record<NotificationSeverity, string> = {
  critical: "var(--destructive)",
  warning: "var(--status-maintenance)",
  info: "var(--primary)",
};

/** A short relative time ("just now", "5m ago", …) falling back to a date. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
