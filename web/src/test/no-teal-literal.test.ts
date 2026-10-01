import { describe, expect, it } from "vitest"

// Import the shared scanner used by the `check:no-teal` script so the CI suite
// (npm test) enforces the single-blue-accent rule (spec 17.01, AC-1.1).
import { findTealLiterals } from "../../scripts/check-no-teal.mjs"

describe("design system: no teal literals (AC-1.1)", () => {
  // Walks the whole src tree doing real filesystem reads, so it can run past
  // Vitest's 5s default when the full suite saturates the workers. Give it a
  // generous timeout; the scan itself finishes in well under a second.
  it("no source file hardcodes a retired teal color", async () => {
    const hits = await findTealLiterals()
    const report = hits
      .map((h) => `${h.file}:${h.line} [${h.label}] ${h.text}`)
      .join("\n")
    expect(hits, `Teal literals found — use the blue accent tokens:\n${report}`).toEqual([])
  }, 30000)
})
