import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for ticket Server Actions (spec 33). DB helpers, auth session, and Next
 * cache are mocked; the user:admin gate and input validation run for real.
 */

const {
  createMock,
  updateMock,
  addCommentMock,
  createFromNotifMock,
  setAutoCreateMock,
  getTicketMock,
  getCurrentUserMock,
  hasPermissionMock,
  revalidateMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn(),
  addCommentMock: vi.fn(),
  createFromNotifMock: vi.fn(),
  setAutoCreateMock: vi.fn(),
  getTicketMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  revalidateMock: vi.fn(),
}));

vi.mock("@/db/tickets", () => ({
  createTicket: createMock,
  updateTicket: updateMock,
  addTicketComment: addCommentMock,
  createTicketFromNotification: createFromNotifMock,
  setTicketAutoCreateType: setAutoCreateMock,
  getTicket: getTicketMock,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: getCurrentUserMock,
  hasPermission: hasPermissionMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import {
  addTicketCommentAction,
  createTicketAction,
  createTicketFromNotificationAction,
  getTicketAction,
  setTicketAutoCreateTypeAction,
  updateTicketAction,
} from "./ticket-actions";

const TICKET_ID = "b4000000-0000-4000-8000-000000000001";
const NOTIF_ID = "c5000000-0000-4000-8000-000000000001";

function grant(allowed: boolean) {
  getCurrentUserMock.mockResolvedValue(allowed ? { email: "admin@example.com" } : null);
  hasPermissionMock.mockReturnValue(allowed);
}

beforeEach(() => vi.clearAllMocks());

describe("ticket actions — permission gate", () => {
  it("refuses a caller without user:admin and writes nothing", async () => {
    grant(false);
    const res = await createTicketAction({ subject: "Test" });
    expect(res.ok).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});

describe("createTicketAction", () => {
  beforeEach(() => grant(true));

  it("rejects empty subject without writing", async () => {
    const res = await createTicketAction({ subject: "  " });
    expect(res.ok).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates a ticket, revalidates, and returns ok", async () => {
    createMock.mockResolvedValue({ id: TICKET_ID, number: 3 });
    const res = await createTicketAction({ subject: "Printer offline" });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Printer offline",
        createdBy: "admin@example.com",
      }),
    );
    expect(revalidateMock).toHaveBeenCalledWith("/tickets");
    expect(res.ok).toBe(true);
  });
});

describe("getTicketAction", () => {
  beforeEach(() => grant(true));

  it("returns ticket with comments for admins", async () => {
    getTicketMock.mockResolvedValue({
      id: TICKET_ID,
      number: 1,
      comments: [],
    });
    const res = await getTicketAction(TICKET_ID);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.ticket.id).toBe(TICKET_ID);
  });

  it("reports missing ticket", async () => {
    getTicketMock.mockResolvedValue(null);
    const res = await getTicketAction(TICKET_ID);
    expect(res.ok).toBe(false);
  });
});

describe("updateTicketAction", () => {
  beforeEach(() => grant(true));

  it("reports a missing ticket", async () => {
    updateMock.mockResolvedValue(false);
    const res = await updateTicketAction(TICKET_ID, { status: "closed" });
    expect(res.ok).toBe(false);
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("updates and revalidates", async () => {
    updateMock.mockResolvedValue(true);
    const res = await updateTicketAction(TICKET_ID, { status: "closed" });
    expect(updateMock).toHaveBeenCalledWith(TICKET_ID, { status: "closed" });
    expect(res.ok).toBe(true);
  });
});

describe("addTicketCommentAction / createTicketFromNotificationAction", () => {
  beforeEach(() => grant(true));

  it("adds a comment when the ticket exists", async () => {
    addCommentMock.mockResolvedValue("comment-1");
    const res = await addTicketCommentAction(TICKET_ID, "Checking logs.");
    expect(addCommentMock).toHaveBeenCalledWith(TICKET_ID, {
      authorEmail: "admin@example.com",
      body: "Checking logs.",
    });
    expect(res.ok).toBe(true);
  });

  it("creates from notification or reports missing notification", async () => {
    createFromNotifMock.mockResolvedValue(null);
    expect((await createTicketFromNotificationAction(NOTIF_ID)).ok).toBe(false);

    createFromNotifMock.mockResolvedValue({ id: TICKET_ID, number: 1 });
    const res = await createTicketFromNotificationAction(NOTIF_ID);
    expect(res.ok).toBe(true);
    expect(revalidateMock).toHaveBeenCalledWith("/notifications");
  });
});

describe("setTicketAutoCreateTypeAction", () => {
  beforeEach(() => grant(true));

  it("rejects unknown type", async () => {
    const res = await setTicketAutoCreateTypeAction("not-a-type", true);
    expect(res.ok).toBe(false);
    expect(setAutoCreateMock).not.toHaveBeenCalled();
  });

  it("persists enabled flag and revalidates admin + tickets", async () => {
    const res = await setTicketAutoCreateTypeAction("printer-down", true);
    expect(setAutoCreateMock).toHaveBeenCalledWith("printer-down", true);
    expect(revalidateMock).toHaveBeenCalledWith("/admin");
    expect(revalidateMock).toHaveBeenCalledWith("/tickets");
    expect(res.ok).toBe(true);
  });
});
