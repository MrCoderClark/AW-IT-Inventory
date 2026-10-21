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
  sendMock,
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
  sendMock: vi.fn(),
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
vi.mock("@/lib/notify", () => ({
  sendTicketEmail: (...args: unknown[]) => sendMock(...args),
}));

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

function ticketRow(over: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID,
    number: 7,
    subject: "Printer jam",
    status: "open",
    assigneeEmail: null as string | null,
    requesterEmail: null as string | null,
    ...over,
  };
}

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
    expect(revalidateMock).toHaveBeenCalledWith(`/tickets/${TICKET_ID}`);
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

  it("updates and revalidates the list and the ticket page", async () => {
    updateMock.mockResolvedValue(true);
    const res = await updateTicketAction(TICKET_ID, { status: "closed" });
    expect(updateMock).toHaveBeenCalledWith(TICKET_ID, { status: "closed" });
    expect(revalidateMock).toHaveBeenCalledWith("/tickets");
    expect(revalidateMock).toHaveBeenCalledWith(`/tickets/${TICKET_ID}`);
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
    expect(revalidateMock).toHaveBeenCalledWith("/tickets");
    expect(revalidateMock).toHaveBeenCalledWith(`/tickets/${TICKET_ID}`);
    expect(res.ok).toBe(true);
  });

  it("asks for an AI draft on manual create from notification", async () => {
    createFromNotifMock.mockResolvedValue({ id: TICKET_ID, number: 1 });
    await createTicketFromNotificationAction(NOTIF_ID);
    expect(createFromNotifMock).toHaveBeenCalledWith(NOTIF_ID, "admin@example.com", {
      useAi: true,
    });
  });

  it("creates from notification or reports missing notification", async () => {
    createFromNotifMock.mockResolvedValue(null);
    expect((await createTicketFromNotificationAction(NOTIF_ID)).ok).toBe(false);

    createFromNotifMock.mockResolvedValue({ id: TICKET_ID, number: 1 });
    const res = await createTicketFromNotificationAction(NOTIF_ID);
    expect(res.ok).toBe(true);
    expect(revalidateMock).toHaveBeenCalledWith("/tickets");
    expect(revalidateMock).toHaveBeenCalledWith(`/tickets/${TICKET_ID}`);
    expect(revalidateMock).toHaveBeenCalledWith("/notifications");
  });

  it("revalidates the existing ticket page when one already exists", async () => {
    createFromNotifMock.mockResolvedValue({ existingId: TICKET_ID });
    const res = await createTicketFromNotificationAction(NOTIF_ID);
    expect(res.ok).toBe(true);
    expect(revalidateMock).toHaveBeenCalledWith(`/tickets/${TICKET_ID}`);
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

describe("ticket actions — outbound email", () => {
  beforeEach(() => {
    grant(true);
    sendMock.mockResolvedValue(true);
    delete process.env.WEB_PUBLIC_URL;
  });

  it("loads the ticket before updating and emails the new assignee", async () => {
    const order: string[] = [];
    getTicketMock.mockImplementation(async () => {
      order.push("get");
      return ticketRow();
    });
    updateMock.mockImplementation(async () => {
      order.push("update");
      return true;
    });

    const res = await updateTicketAction(TICKET_ID, {
      assigneeEmail: "tech@co.com",
    });

    expect(res.ok).toBe(true);
    expect(order).toEqual(["get", "update"]);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "assigned",
        recipients: ["tech@co.com"],
        actorEmail: "admin@example.com",
        detail: "Assigned to tech@co.com",
        ticket: expect.objectContaining({
          id: TICKET_ID,
          number: 7,
          subject: "Printer jam",
          status: "open",
          assigneeEmail: "tech@co.com",
        }),
      }),
    );
  });

  it("emails assigned and status when both change", async () => {
    getTicketMock.mockResolvedValue(ticketRow());
    updateMock.mockResolvedValue(true);

    const res = await updateTicketAction(TICKET_ID, {
      assigneeEmail: "tech@co.com",
      status: "in_progress",
      subject: "Ignored for notify",
    });

    expect(res.ok).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ event: "assigned", recipients: ["tech@co.com"] }),
    );
    expect(sendMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: "status",
        recipients: ["tech@co.com"],
        detail: "open → in_progress",
      }),
    );
  });

  it("does not email when the actor assigns the ticket to themselves", async () => {
    getTicketMock.mockResolvedValue(ticketRow());
    updateMock.mockResolvedValue(true);

    const res = await updateTicketAction(TICKET_ID, {
      assigneeEmail: "admin@example.com",
    });

    expect(res.ok).toBe(true);
    expect(updateMock).toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email when the update fails", async () => {
    getTicketMock.mockResolvedValue(ticketRow({ assigneeEmail: "tech@co.com" }));
    updateMock.mockResolvedValue(false);

    const res = await updateTicketAction(TICKET_ID, { status: "closed" });

    expect(res.ok).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email a subject-only update", async () => {
    getTicketMock.mockResolvedValue(ticketRow({ assigneeEmail: "tech@co.com" }));
    updateMock.mockResolvedValue(true);

    const res = await updateTicketAction(TICKET_ID, { subject: "New subject" });

    expect(res.ok).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still returns ok when the assignee email send throws", async () => {
    getTicketMock.mockResolvedValue(ticketRow());
    updateMock.mockResolvedValue(true);
    sendMock.mockRejectedValue(new Error("smtp down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await updateTicketAction(TICKET_ID, {
      assigneeEmail: "tech@co.com",
    });

    expect(res.ok).toBe(true);
    spy.mockRestore();
  });

  it("emails the assignee after a user comment", async () => {
    const order: string[] = [];
    addCommentMock.mockImplementation(async () => {
      order.push("comment");
      return "comment-1";
    });
    getTicketMock.mockImplementation(async () => {
      order.push("get");
      return ticketRow({ assigneeEmail: "tech@co.com" });
    });

    const res = await addTicketCommentAction(TICKET_ID, "Checking logs.");

    expect(res.ok).toBe(true);
    expect(order).toEqual(["comment", "get"]);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "comment",
        recipients: ["tech@co.com"],
        detail: "Checking logs.",
        actorEmail: "admin@example.com",
      }),
    );
  });

  it("does not email when the commenter is the assignee", async () => {
    addCommentMock.mockResolvedValue("comment-1");
    getTicketMock.mockResolvedValue(
      ticketRow({ assigneeEmail: "admin@example.com" }),
    );

    const res = await addTicketCommentAction(TICKET_ID, "On it.");

    expect(res.ok).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not email when the comment cannot be saved", async () => {
    addCommentMock.mockResolvedValue(null);

    const res = await addTicketCommentAction(TICKET_ID, "Checking logs.");

    expect(res.ok).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
    expect(getTicketMock).not.toHaveBeenCalled();
  });
});
