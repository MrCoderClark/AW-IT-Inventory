// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TicketWorkspace } from "./ticket-workspace";
import type { TicketCommentItem, TicketListItem } from "@/lib/data";

/**
 * Smoke coverage for the full ticket page workspace (spec 33 helpdesk UI).
 * Conversation shows user notes; Activity shows system lines. Actions stay
 * gated on the same server actions as the retired side pane.
 */

const { refreshMock, updateMock, commentMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  updateMock: vi.fn(),
  commentMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/app/(app)/ticket-actions", () => ({
  updateTicketAction: updateMock,
  addTicketCommentAction: commentMock,
}));

type TicketDetail = TicketListItem & { comments: TicketCommentItem[] };

function makeTicket(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id: "b4000000-0000-4000-8000-000000000001",
    number: 12,
    subject: "Printer offline",
    description: "Front desk printer is down.",
    status: "open",
    priority: "high",
    category: "Hardware",
    assigneeEmail: "tech@example.com",
    assetId: "asset-1",
    assetTag: "OPUS-PRN-1",
    assetName: "Front Desk HP",
    locationLabel: "HQ / Lobby",
    sourceNotificationId: "notif-abcdef12",
    createdBy: "admin@example.com",
    createdAt: "2026-10-01T15:00:00.000Z",
    updatedAt: "2026-10-02T15:00:00.000Z",
    comments: [
      {
        id: "c-user",
        authorEmail: "admin@example.com",
        body: "Checking the tray.",
        kind: "user",
        createdAt: "2026-10-02T16:00:00.000Z",
      },
      {
        id: "c-system",
        authorEmail: "system",
        body: "Ticket created",
        kind: "system",
        createdAt: "2026-10-01T15:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TicketWorkspace — conversation vs activity", () => {
  it("shows the back link, subject, and only user notes on Conversation", () => {
    render(<TicketWorkspace ticket={makeTicket()} />);

    expect(
      screen.getByRole("link", { name: "← Back to Tickets" }),
    ).toHaveAttribute("href", "/tickets");
    expect(
      screen.getByRole("heading", { level: 1, name: "Printer offline" }),
    ).toBeInTheDocument();
    expect(screen.getByText("#TKT-12")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Conversation", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Checking the tray.");
    expect(screen.getByRole("tabpanel")).not.toHaveTextContent("Ticket created");
    expect(screen.queryByRole("tab", { name: "Related tickets" })).toBeNull();
  });

  it("moves system lines onto the Activity tab", async () => {
    const user = userEvent.setup();
    render(<TicketWorkspace ticket={makeTicket()} />);

    await user.click(screen.getByRole("tab", { name: "Activity" }));

    expect(screen.getByRole("tabpanel")).toHaveTextContent("Ticket created");
    expect(screen.getByRole("tabpanel")).not.toHaveTextContent(
      "Checking the tray.",
    );
  });
});

describe("TicketWorkspace — details, assets, and actions", () => {
  it("shows From alert and a link to the related asset", async () => {
    const user = userEvent.setup();
    render(<TicketWorkspace ticket={makeTicket()} />);

    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("From alert");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Hardware");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("admin@example.com");

    await user.click(screen.getByRole("tab", { name: "Assets" }));
    const assetLinks = screen.getAllByRole("link", { name: /OPUS-PRN-1/ });
    expect(assetLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of assetLinks) {
      expect(link).toHaveAttribute("href", "/assets/OPUS-PRN-1");
    }
    expect(screen.getByText("HQ / Lobby")).toBeInTheDocument();
  });

  it("focuses the note composer from Add note and sends the comment", async () => {
    commentMock.mockResolvedValue({ ok: true, message: "Comment added." });
    const user = userEvent.setup();
    const ticket = makeTicket();
    render(<TicketWorkspace ticket={ticket} />);

    await user.click(screen.getByRole("button", { name: "Add note" }));
    const note = screen.getByRole("textbox", { name: "Note" });
    expect(note).toHaveFocus();

    await user.type(note, "On it");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(commentMock).toHaveBeenCalledWith(ticket.id, "On it");
    expect(refreshMock).toHaveBeenCalled();
  });

  it("keeps Update disabled until status, priority, or assignee is dirty", async () => {
    updateMock.mockResolvedValue({ ok: true, message: "Updated that ticket." });
    const user = userEvent.setup();
    const ticket = makeTicket();
    render(<TicketWorkspace ticket={ticket} />);

    const update = screen.getByRole("button", { name: "Update" });
    expect(update).toBeDisabled();

    const assignee = screen.getByRole("textbox", { name: "Assignee email" });
    await user.clear(assignee);
    await user.type(assignee, "other@example.com");
    expect(update).toBeEnabled();

    await user.click(update);
    expect(updateMock).toHaveBeenCalledWith(ticket.id, {
      status: "open",
      priority: "high",
      assigneeEmail: "other@example.com",
    });
    expect(refreshMock).toHaveBeenCalled();
  });
});
