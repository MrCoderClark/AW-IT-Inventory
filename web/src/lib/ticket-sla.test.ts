import { describe, expect, it } from "vitest";

import {
  formatSlaRemaining,
  TICKET_SLA_BUDGET_MS,
  ticketSlaState,
} from "@/lib/ticket-sla";

const CREATED = "2026-10-21T12:00:00.000Z";

describe("ticket SLA", () => {
  it("exposes fixed budgets", () => {
    expect(TICKET_SLA_BUDGET_MS.high).toBe(4 * 60 * 60 * 1000);
    expect(TICKET_SLA_BUDGET_MS.medium).toBe(8 * 60 * 60 * 1000);
    expect(TICKET_SLA_BUDGET_MS.low).toBe(24 * 60 * 60 * 1000);
  });

  it("formats remaining time", () => {
    expect(formatSlaRemaining(3 * 60 * 60 * 1000)).toBe("3h left");
    expect(formatSlaRemaining(45 * 60 * 1000)).toBe("45m left");
    expect(formatSlaRemaining(30 * 1000)).toBe("1m left");
  });

  it("returns none for terminal statuses", () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "high", status: "resolved" },
        now,
      ),
    ).toMatchObject({ kind: "none", label: "—", dueAt: null });
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "high", status: "closed" },
        now,
      ).kind,
    ).toBe("none");
  });

  it("returns paused for waiting_on_user even if past due", () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    const s = ticketSlaState(
      { createdAt: CREATED, priority: "high", status: "waiting_on_user" },
      now,
    );
    expect(s).toMatchObject({ kind: "paused", label: "Paused" });
    expect(s.dueAt?.toISOString()).toBe("2026-10-21T16:00:00.000Z");
  });

  it("returns ok with remaining label before due", () => {
    const now = new Date("2026-10-21T13:00:00.000Z"); // 3h left on high/4h
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "high", status: "open" },
        now,
      ),
    ).toMatchObject({ kind: "ok", label: "3h left" });
  });

  it("returns breached when past due and active", () => {
    const now = new Date("2026-10-21T17:00:00.000Z"); // 1h past high/4h
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "high", status: "in_progress" },
        now,
      ),
    ).toMatchObject({ kind: "breached", label: "Overdue" });
  });

  it("retargets when priority changes", () => {
    const now = new Date("2026-10-21T17:00:00.000Z"); // 1h past high/4h due
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "high", status: "open" },
        now,
      ).kind,
    ).toBe("breached"); // high due at +4h = 16:00
    expect(
      ticketSlaState(
        { createdAt: CREATED, priority: "medium", status: "open" },
        now,
      ),
    ).toMatchObject({ kind: "ok", label: "3h left" }); // med due +8h = 20:00
  });
});
