// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ComputerDetail } from "./computer-detail";
import {
  AI_DRAFT_STORAGE_KEY,
  type AssistJobView,
} from "./ai-assist-panel";
import { toast } from "sonner";
import type {
  Asset,
  AssignmentEvent,
  InstalledSoftwareItem,
  MachineSummary,
} from "@/lib/data";

/**
 * Smoke/regression tests for the tabbed computer detail (spec 17.04, AC-4.2/4.3):
 * the five tabs render and each tab surfaces its existing content (live scan health,
 * tracked software, assignment history) under the new layout. Boundary modules (the
 * server actions, router, toast) are mocked so the component loads under jsdom.
 */
const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  push: vi.fn(),
  back: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, back: nav.back, refresh: nav.refresh }),
  useSearchParams: () => nav.search,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  }),
}));
vi.mock("@/app/(app)/assets/actions", () => ({
  createAsset: vi.fn(),
  updateAsset: vi.fn(),
  deleteAsset: vi.fn(),
}));
vi.mock("@/app/(app)/scan-actions", () => ({ requestScan: vi.fn() }));
vi.mock("@/app/(app)/printer-install-actions", () => ({
  installPrinterAction: vi.fn(),
  cancelInstallJobAction: vi.fn(),
}));
vi.mock("@/app/(app)/people-actions", () => ({
  assignAssetAction: vi.fn(),
  returnAssetAction: vi.fn(),
}));
vi.mock("@/app/(app)/media-actions", () => ({ setAssetImage: vi.fn() }));
vi.mock("@/app/(app)/remote-actions", () => ({
  startRemoteSessionAction: vi.fn(),
  endRemoteSessionAction: vi.fn(),
}));
vi.mock("@/app/(app)/software-deploy-actions", () => ({
  deploySoftwareAction: vi.fn(),
  cancelDeploymentAction: vi.fn(),
}));
vi.mock("@/app/(app)/patch-install-actions", () => ({
  requestPatchInstall: vi.fn(),
  requestCancelPatchInstall: vi.fn(),
  requestMissingUpdateCheck: vi.fn(),
}));
vi.mock("@/app/(app)/script-actions", () => ({
  runScriptAction: vi.fn(),
  cancelScriptRunAction: vi.fn(),
  saveScriptAction: vi.fn(),
  archiveScriptAction: vi.fn(),
  addStarterScriptsAction: vi.fn(),
}));

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "OPUS-COMP-7491",
    name: "Sarah's Laptop",
    type: "Computer",
    serial: "C02DW480MD6R",
    model: "Dell Latitude 5520",
    assignee: { name: "Sarah Jenkins", initials: "SJ" },
    location: "SF / HQ",
    locationId: null,
    status: "deployed",
    lastSync: "2026-09-01",
    vendor: "Dell",
    purchaseDate: "2024-02-13",
    warrantyUntil: "2027-02-13",
    costCenter: "ENG-SF",
    spec: "32GB / 1TB",
    ...overrides,
  };
}

const machine: MachineSummary = {
  lastSeen: "2026-09-01",
  osName: "Windows 11 Pro",
  osVersion: "10.0.22631",
  cpu: "Intel i7-1185G7",
  ramGb: 32,
  freeDiskGb: 420,
  uptimeHours: 72,
  loggedOnUser: "AWINYC\\ibrown",
  networkAdapters: [
    { name: "Ethernet", mac: "50-9A-4C-4B-F3-DE", status: "Up", ips: ["192.168.70.160"] },
  ],
  loggedOnUsers: ["esmith"],
  status: "ok",
};

const software: InstalledSoftwareItem[] = [
  {
    name: "Google Chrome",
    version: "128.0",
    publisher: "Google LLC",
    architecture: "x64",
    installLocation: "C:\\Program Files\\Google\\Chrome\\Application\\",
    iconUrl: null,
  },
];

const history: AssignmentEvent[] = [
  {
    id: "a1",
    assetId: "OPUS-COMP-7491",
    assetName: "Sarah's Laptop",
    assetType: "Computer",
    personId: "p1",
    personName: "Sarah Jenkins",
    assignedAt: "2026-02-13T10:00:00Z",
    assignedBy: "admin@opus.local",
    unassignedAt: null,
    unassignedBy: null,
    open: true,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  nav.search = new URLSearchParams();
  vi.unstubAllGlobals();
});

function assistJob(overrides: Partial<AssistJobView> = {}): AssistJobView {
  return {
    id: "job-1",
    status: "succeeded",
    action: "summarize_health",
    result: {
      observed: ["Disk 90%"],
      hypotheses: [],
      recommendations: [],
    },
    error: null,
    createdAt: "2026-10-20T16:00:00.000Z",
    finishedAt: "2026-10-20T16:00:05.000Z",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function renderAi(props: Partial<ComponentProps<typeof ComputerDetail>> = {}) {
  return render(
    <ComputerDetail
      asset={makeAsset()}
      machine={machine}
      software={software}
      assignmentHistory={history}
      canWrite
      canScan
      aiEnabled
      {...props}
    />,
  );
}

function renderDetail() {
  return render(
    <ComputerDetail
      asset={makeAsset()}
      machine={machine}
      software={software}
      assignmentHistory={history}
      canWrite
      canScan
    />,
  );
}

describe("ComputerDetail — tabs + content (AC-4.2, AC-4.3)", () => {
  it("renders all tabs", () => {
    renderDetail();
    for (const name of [
      "Overview",
      "Live scan",
      "Software",
      "Compliance",
      "Printers",
      "Assignment",
      "Activity",
    ]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
  });

  it("Overview leads with Asset Information and the model", () => {
    renderDetail();
    expect(screen.getByText("Asset Information")).toBeInTheDocument();
    expect(screen.getAllByText("Dell Latitude 5520").length).toBeGreaterThan(0);
  });

  it("hides AI Assist when aiEnabled is false (spec 34 AC-2)", async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole("tab", { name: "Monitoring" }));
    expect(screen.queryByRole("tab", { name: "AI Assist" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Summarize health/i })).not.toBeInTheDocument();
  });

  it("puts AI Assist under Monitoring when aiEnabled is true", async () => {
    const user = userEvent.setup();
    render(
      <ComputerDetail
        asset={makeAsset()}
        machine={machine}
        software={software}
        assignmentHistory={history}
        canWrite
        canScan
        aiEnabled
      />,
    );
    expect(screen.queryByRole("button", { name: /Summarize health/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Monitoring" }));
    await user.click(screen.getByRole("tab", { name: "AI Assist" }));
    expect(screen.getByRole("button", { name: "Summarize health" })).toBeInTheDocument();
  });

  it("queues assist on 202 and shows the polled result", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse(202, { jobId: "job-queued" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "job-queued",
          status: "succeeded",
          action: "summarize_health",
          result: {
            observed: ["CPU hot"],
            hypotheses: [],
            recommendations: ["Check the fan"],
          },
          error: null,
          createdAt: "2026-10-20T16:00:00.000Z",
          finishedAt: "2026-10-20T16:00:02.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    renderAi();
    await user.click(screen.getByRole("tab", { name: "Monitoring" }));
    await user.click(screen.getByRole("tab", { name: "AI Assist" }));
    await user.click(screen.getByRole("button", { name: "Summarize health" }));

    expect(await screen.findByText("CPU hot")).toBeInTheDocument();
    expect(screen.getByText("Check the fan")).toBeInTheDocument();
    expect(toast.message).toHaveBeenCalledWith("AI Assist queued");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/ai/assist");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/ai/assist/job-queued");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows a failed job error in the panel without a second toast", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-bad" }))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            id: "job-bad",
            status: "failed",
            action: "explain_failures",
            result: null,
            error: "model timeout",
            createdAt: "2026-10-20T16:00:00.000Z",
            finishedAt: "2026-10-20T16:00:02.000Z",
          }),
        ),
    );

    renderAi();
    await user.click(screen.getByRole("tab", { name: "Monitoring" }));
    await user.click(screen.getByRole("tab", { name: "AI Assist" }));
    await user.click(screen.getByRole("button", { name: "Explain failures" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("model timeout");
    expect(toast.message).toHaveBeenCalledWith("AI Assist queued");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("loads a recent job result when that job is clicked", async () => {
    const user = userEvent.setup();
    renderAi({
      recentAssistJobs: [
        assistJob({
          result: {
            observed: ["Patch lag"],
            hypotheses: ["WSUS delay"],
            recommendations: [],
          },
        }),
      ],
    });
    await user.click(screen.getByRole("tab", { name: "Monitoring" }));
    await user.click(screen.getByRole("tab", { name: "AI Assist" }));
    expect(screen.queryByText("Patch lag")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Recent: Summarize health, Succeeded/i }),
    );
    expect(screen.getByText("Patch lag")).toBeInTheDocument();
    expect(screen.getByText("WSUS delay")).toBeInTheDocument();
  });

  it("opens Monitoring → AI Assist and selects the deep-linked job", () => {
    nav.search = new URLSearchParams("tab=monitoring&assistJob=job-9");
    renderAi({
      recentAssistJobs: [
        assistJob({
          id: "job-9",
          result: {
            observed: ["From the notification"],
            hypotheses: [],
            recommendations: [],
          },
        }),
      ],
    });
    expect(screen.getByRole("tab", { name: "Monitoring", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI Assist", selected: true })).toBeInTheDocument();
    expect(screen.getByText("From the notification")).toBeInTheDocument();
  });

  it("fetches a deep-linked job that is not in the recent list", async () => {
    nav.search = new URLSearchParams("tab=monitoring&assistJob=job-old");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "job-old",
          status: "succeeded",
          action: "summarize_health",
          result: {
            observed: ["Loaded by id"],
            hypotheses: [],
            recommendations: [],
          },
          error: null,
          createdAt: "2026-09-01T12:00:00.000Z",
          finishedAt: "2026-09-01T12:00:02.000Z",
        }),
      ),
    );
    renderAi();
    expect(await screen.findByText("Loaded by id")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI Assist", selected: true })).toBeInTheDocument();
  });

  it("keeps the script-draft handoff in sessionStorage", async () => {
    const user = userEvent.setup();
    renderAi({
      canDeploy: true,
      recentAssistJobs: [
        assistJob({
          id: "job-draft",
          action: "draft_script",
          result: {
            observed: [],
            hypotheses: [],
            recommendations: [],
            scriptDraft: {
              name: "Fix disk",
              body: "Get-PSDrive",
              notes: "safe",
            },
          },
        }),
      ],
    });
    await user.click(screen.getByRole("tab", { name: "Monitoring" }));
    await user.click(screen.getByRole("tab", { name: "AI Assist" }));
    await user.click(
      screen.getByRole("button", { name: /Recent: Draft fix script, Succeeded/i }),
    );
    await user.click(screen.getByRole("button", { name: "Open in script editor" }));
    expect(sessionStorage.getItem(AI_DRAFT_STORAGE_KEY)).toContain("Get-PSDrive");
    expect(nav.push).toHaveBeenCalledWith("/scripts?aiDraft=1");
  });

  it("Overview shows the logged-in user from the live scan", () => {
    renderDetail();
    expect(screen.getByText("Logged in User")).toBeInTheDocument();
    expect(screen.getByText("AWINYC\\ibrown")).toBeInTheDocument();
  });

  it("Live scan tab shows collected health", async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole("tab", { name: "Live scan" }));
    expect(screen.getByText("Intel i7-1185G7")).toBeInTheDocument();
    expect(screen.getByText("32 GB")).toBeInTheDocument();
  });

  it("Live scan tab shows network adapters and active sessions", async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole("tab", { name: "Live scan" }));
    expect(screen.getByText("Network & sessions")).toBeInTheDocument();
    expect(screen.getByText("Ethernet")).toBeInTheDocument();
    expect(screen.getByText(/50-9A-4C-4B-F3-DE/)).toBeInTheDocument();
    expect(screen.getByText("esmith")).toBeInTheDocument();
  });

  it("Software tab lists tracked software", async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole("tab", { name: "Software" }));
    expect(screen.getByText("Google Chrome")).toBeInTheDocument();
    // spec 22: architecture badge + install location are shown.
    expect(screen.getByText("x64")).toBeInTheDocument();
    expect(
      screen.getByText("C:\\Program Files\\Google\\Chrome\\Application\\"),
    ).toBeInTheDocument();
  });

  it("Assignment tab shows the current holder in history", async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole("tab", { name: "Assignment" }));
    expect(screen.getByText("Assignment History")).toBeInTheDocument();
    expect(screen.getByText("Currently held")).toBeInTheDocument();
  });
});
