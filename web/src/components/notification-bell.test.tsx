// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { NotificationBell } from "./notification-bell";

/**
 * Bell (spec 19 / spec 34): shown for every signed-in user, pulses while unread,
 * and toasts each SSE notification (error when failed or warning/critical).
 */

const { toastError, toastSuccess, permsRef } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  permsRef: { current: [] as string[] },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess },
}));
vi.mock("@/components/user-provider", () => ({
  useUser: () => ({
    id: "u2",
    email: "tech@x.com",
    permissions: permsRef.current,
  }),
  useHasPermission: (perm: string) => permsRef.current.includes(perm),
}));
vi.mock("@/app/(app)/notification-actions", () => ({
  markAllNotificationsReadAction: vi.fn(),
  markNotificationReadAction: vi.fn(),
}));

type Handler = (event: { data: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Handler[]>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: Handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(data) });
    }
  }
  close() {}
}

function note(over: Record<string, unknown>) {
  return {
    id: "n1",
    type: "ai-assist",
    severity: "info",
    title: "Draft ready",
    body: "b",
    href: "/assets/T",
    assetId: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    read: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  permsRef.current = ["asset:read"];
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [], unread: 0 }),
    })),
  );
});

describe("NotificationBell", () => {
  it("renders for a signed-in user who is not an admin", async () => {
    render(<NotificationBell />);
    expect(
      await screen.findByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
  });

  it("pulses the bell while there are unread notifications", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ items: [], unread: 2 }),
      })),
    );
    render(<NotificationBell />);
    const button = await screen.findByRole("button", {
      name: "Notifications, 2 unread",
    });
    expect(button.className).toContain("animate-pulse");
  });

  it("toasts error for failures and warning/critical, success otherwise", async () => {
    render(<NotificationBell />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.emit("notification", note({ id: "a", type: "ai-assist-failed", severity: "info", title: "Assist failed" }));
    es.emit("notification", note({ id: "b", type: "printer-down", severity: "critical", title: "Printer down" }));
    es.emit("notification", note({ id: "w", type: "warranty-expiring", severity: "warning", title: "Warranty soon" }));
    es.emit("notification", note({ id: "c", type: "printer-recovery", severity: "info", title: "Printer recovered" }));
    expect(toastError).toHaveBeenCalledWith("Assist failed");
    expect(toastError).toHaveBeenCalledWith("Printer down");
    expect(toastError).toHaveBeenCalledWith("Warranty soon");
    expect(toastSuccess).toHaveBeenCalledWith("Printer recovered");
  });
});
