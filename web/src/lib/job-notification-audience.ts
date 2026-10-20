import type { NotificationAudience } from "@/lib/notification-visibility";

export type JobNotificationAudience = {
  audience: NotificationAudience;
  recipientEmail: string | null;
};

/** Spec 34 v2b: human email → requester-only; schedule/system → admin broadcast. */
export function resolveJobNotificationAudience(
  requestedBy: string,
): JobNotificationAudience {
  const trimmed = requestedBy.trim();
  if (trimmed.includes("@")) {
    return { audience: "user", recipientEmail: trimmed };
  }
  return { audience: "admins", recipientEmail: null };
}
