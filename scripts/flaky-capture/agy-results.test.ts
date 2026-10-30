import { describe, expect, it } from "vitest"

import { agyOutcome, type AgyReport } from "./agy-results.ts"

const report = (status: string, failureMessages: string[] = [], message = ""): AgyReport => ({
  testResults: [{ message, assertionResults: [{ status, failureMessages }] }],
})

describe("Antigravity capture outcome", () => {
  it("is the probe's own once it has written its summary", () => {
    expect(agyOutcome({ outcome: "delivered" }, report("passed"))).toEqual({
      outcome: "delivered",
    })
    expect(
      agyOutcome(
        { outcome: "submitted-followup-never-reached-model" },
        report("failed", ["Error: Timed out waiting for its transcript to hold Did then.\n at…"]),
      ),
    ).toEqual({
      outcome: "submitted-followup-never-reached-model",
      error: "Error: Timed out waiting for its transcript to hold Did then.",
    })
  })

  it("names the error that stopped the probe before its scenario began", () => {
    expect(
      agyOutcome(
        undefined,
        report("failed", ["AssertionError: expected '1.4.3' to be '1.2.14'\n\nExpected: …"]),
      ),
    ).toEqual({
      outcome: "failed-before-scenario",
      error: "AssertionError: expected '1.4.3' to be '1.2.14'",
    })
  })

  it("names a hook or collection error Vitest reports for the file", () => {
    expect(agyOutcome(undefined, report("skipped", [], "Hook timed out in 600000ms.\n…"))).toEqual({
      outcome: "failed-before-scenario",
      error: "Hook timed out in 600000ms.",
    })
  })

  it("tells a skipped probe from a failed one", () => {
    expect(agyOutcome(undefined, report("skipped"))).toEqual({ outcome: "skipped" })
    expect(agyOutcome(undefined, { testResults: [] })).toEqual({ outcome: "skipped" })
  })

  it("says when Vitest never reported at all", () => {
    expect(agyOutcome(undefined, undefined)).toEqual({ outcome: "no-test-report" })
  })
})
