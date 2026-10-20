import { describe, expect, it } from "vitest";

import { parseAssistResult } from "./parse";

describe("parseAssistResult", () => {
  it("parses structured JSON", () => {
    const r = parseAssistResult(
      JSON.stringify({
        observed: ["disk 5 GB free"],
        hypotheses: ["temp files"],
        recommendations: ["run cleanup"],
        scriptDraft: { name: "Cleanup", body: "Write-Output hi", notes: "safe" },
      }),
    );
    expect(r.observed).toEqual(["disk 5 GB free"]);
    expect(r.hypotheses).toEqual(["temp files"]);
    expect(r.recommendations).toEqual(["run cleanup"]);
    expect(r.scriptDraft?.body).toBe("Write-Output hi");
  });

  it("strips markdown fences", () => {
    const r = parseAssistResult(
      '```json\n{"observed":["a"],"hypotheses":[],"recommendations":[]}\n```',
    );
    expect(r.observed).toEqual(["a"]);
  });

  it("returns soft failure on garbage", () => {
    const r = parseAssistResult("not json");
    expect(r.observed).toEqual([]);
    expect(r.recommendations[0]).toMatch(/unparseable/i);
  });

  it("ignores empty scriptDraft body", () => {
    const r = parseAssistResult(
      JSON.stringify({
        observed: [],
        hypotheses: [],
        recommendations: [],
        scriptDraft: { body: "  " },
      }),
    );
    expect(r.scriptDraft).toBeUndefined();
  });
});
