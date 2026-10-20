export type NotificationAudience = "admins" | "user";

export function notificationVisibleTo(
  viewer: { email: string; isAdmin: boolean },
  n: { audience: NotificationAudience; recipientEmail: string | null },
): boolean {
  if (n.audience === "admins") return viewer.isAdmin;
  return (
    n.audience === "user" &&
    !!n.recipientEmail &&
    n.recipientEmail.toLowerCase() === viewer.email.toLowerCase()
  );
}
