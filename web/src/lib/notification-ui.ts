import {
  Bell,
  Printer,
  Radar,
  ScanLine,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

import type { NotificationSeverity, NotificationType } from "@/lib/data";

/** Presentation maps shared by the bell panel and the /notifications page
   (spec 19), so both render each type/severity the same way. Pure data — safe to
   import from any client component. */

export const NOTIFICATION_ICON: Record<NotificationType, LucideIcon> = {
  "printer-down": Printer,
  "printer-recovery": Printer,
  "scan-failed": ScanLine,
  "device-discovered": Radar,
  "warranty-expiring": ShieldAlert,
};

export const NOTIFICATION_FALLBACK_ICON = Bell;

export const NOTIFICATION_TYPE_LABEL: Record<NotificationType, string> = {
  "printer-down": "Printer down",
  "printer-recovery": "Printer recovery",
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
