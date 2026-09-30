import { describe, expect, it } from "vitest"

// Import the shared scanner used by the `check:no-teal` script so the CI suite
// (npm test) enforces the single-blue-accent rule (spec 17.01, AC-1.1).
import { findTealLiterals } from "../../scripts/check-no-teal.mjs"

describe("design system: no teal literals (AC-1.1)", () => {
  it("no source file hardcodes a retired teal color", async () => {
    const hits = await findTealLiterals()
    const report = hits
      .map((h) => `${h.file}:${h.line} [${h.label}] ${h.text}`)
      .join("\n")
    expect(hits, `Teal literals found — use the blue accent tokens:\n${report}`).toEqual([])
  })
})
