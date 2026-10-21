import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeMock, packMock, configuredMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
  packMock: vi.fn(),
  configuredMock: vi.fn(() => true),
}));

vi.mock("@/lib/ai/config", () => ({
  loadAiConfig: () => ({
    provider: "openai_compatible",
    baseUrl: "https://example.test",
    apiKey: "k",
    model: "m",
    timeoutMs: 5000,
  }),
  isAiConfigured: () => configuredMock(),
}));

vi.mock("@/lib/ai/providers", () => ({
  getAiProvider: () => ({
    id: "openai_compatible",
    model: "m",
    complete: completeMock,
  }),
  AiNotConfiguredError: class extends Error {},
}));

vi.mock("./ai-context", () => ({
  buildNotificationContextPack: (...a: unknown[]) => packMock(...a),
}));

vi.mock("./index", () => ({ db: {} }));

import { draftTicketFieldsFromNotification } from "./ai-ticket-draft";

const PACK = {
  notification: {
    type: "metric-threshold",
    severity: "critical",
    title: "Disk",
    body: "95%",
  },
  asset: { tag: "PC-1", name: "PC-1", type: "Computer", locationPath: null },
};

const TICKET_JSON_HINT = `{
  "observed": string[],
  "hypotheses": string[],
  "recommendations": string[],
  "ticketDraft": {
    "subject": string,
    "description": string,
    "category"?: string,
    "priority"?: "low"|"medium"|"high"
  }
}
Rules: Write a clear IT ticket from the notification context. subject ≤ 120 chars.
category must be one of the fixed ticket categories when possible. Do not invent asset facts.`;

describe("draftTicketFieldsFromNotification", () => {
  beforeEach(() => {
    completeMock.mockReset();
    packMock.mockReset();
    configuredMock.mockReset();
    configuredMock.mockReturnValue(true);
  });

  it("returns null when AI is off", async () => {
    configuredMock.mockReturnValue(false);
    await expect(
      draftTicketFieldsFromNotification("n1", "a@b.com"),
    ).resolves.toBeNull();
    expect(packMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("returns null when pack missing", async () => {
    packMock.mockResolvedValue(null);
    expect(await draftTicketFieldsFromNotification("n1", "a@b.com")).toBeNull();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("returns validated draft on success", async () => {
    packMock.mockResolvedValue(PACK);
    completeMock.mockResolvedValue(
      JSON.stringify({
        observed: [],
        hypotheses: [],
        recommendations: [],
        ticketDraft: {
          subject: "Disk critical on PC-1",
          description: "Clean up or expand volume.",
          category: "Alert",
          priority: "high",
        },
      }),
    );
    await expect(
      draftTicketFieldsFromNotification("n1", "a@b.com"),
    ).resolves.toEqual({
      subject: "Disk critical on PC-1",
      description: "Clean up or expand volume.",
      category: "Alert",
      priority: "high",
    });
    expect(completeMock).toHaveBeenCalledWith({
      system: `You are an IT helpdesk assistant for H2Tecs. Draft one ticket from an alert notification. Never claim to have fixed anything.`,
      user: `Action: draft_ticket\n\nContext pack (JSON):\n${JSON.stringify(PACK)}`,
      jsonSchemaHint: TICKET_JSON_HINT,
    });
  });

  it("drops invalid category", async () => {
    packMock.mockResolvedValue({
      notification: {
        type: "metric-threshold",
        severity: "warning",
        title: "t",
        body: "b",
      },
      asset: null,
    });
    completeMock.mockResolvedValue(
      JSON.stringify({
        observed: [],
        hypotheses: [],
        recommendations: [],
        ticketDraft: {
          subject: "Sub",
          description: "Desc",
          category: "NotARealCategory",
          priority: "nope",
        },
      }),
    );
    await expect(
      draftTicketFieldsFromNotification("n1", "a@b.com"),
    ).resolves.toEqual({
      subject: "Sub",
      description: "Desc",
    });
  });

  it("caps subject at 200 characters", async () => {
    packMock.mockResolvedValue(PACK);
    completeMock.mockResolvedValue(
      JSON.stringify({
        observed: [],
        hypotheses: [],
        recommendations: [],
        ticketDraft: {
          subject: "S".repeat(250),
          description: "Desc",
          category: "Alert",
          priority: "low",
        },
      }),
    );
    const draft = await draftTicketFieldsFromNotification("n1", "a@b.com");
    expect(draft?.subject).toHaveLength(200);
    expect(draft?.subject).toBe("S".repeat(200));
  });

  it("returns null when the model output has no ticket draft", async () => {
    packMock.mockResolvedValue(PACK);
    completeMock.mockResolvedValue("not json");
    await expect(
      draftTicketFieldsFromNotification("n1", "a@b.com"),
    ).resolves.toBeNull();
  });

  it("returns null when the provider throws", async () => {
    packMock.mockResolvedValue(PACK);
    completeMock.mockRejectedValue(new Error("timeout"));
    await expect(
      draftTicketFieldsFromNotification("n1", "a@b.com"),
    ).resolves.toBeNull();
  });
});
