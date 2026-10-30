import { describe, expect, it } from "vitest"

import { agyOutcome, type AgyReport } from "./agy-results.ts"

const report = (status: string, failureMessages: string[] = [], message = ""): AgyReport => {
  const failed = status === "failed" || Boolean(message)
  return {
    success: !failed,
    testResults: [
      {
        status: failed ? "failed" : "passed",
        message,
        assertionResults: [{ status, failureMessages }],
      },
    ],
  }
}

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

  it("names a collection error Vitest reports for the file", () => {
    expect(agyOutcome(undefined, report("skipped", [], "Cannot find module '…'\n…"))).toEqual({
      outcome: "failed-before-scenario",
      error: "Cannot find module '…'",
    })
  })

  it("takes a failed install hook, which leaves its test skipped in a failed file, as a failure", () => {
    // Vitest keeps a describe's hook error out of its JSON report; the log has it.
    const hook: AgyReport = {
      success: false,
      testResults: [
        {
          status: "failed",
          message: "",
          assertionResults: [{ status: "skipped", failureMessages: [] }],
        },
      ],
    }
    expect(agyOutcome(undefined, hook)).toEqual({ outcome: "failed-before-scenario" })
  })

  it("tells a skipped probe from a failed one", () => {
    expect(agyOutcome(undefined, report("skipped"))).toEqual({ outcome: "skipped" })
    expect(agyOutcome(undefined, { success: true, testResults: [] })).toEqual({
      outcome: "skipped",
    })
  })

  it("says when Vitest never reported at all", () => {
    expect(agyOutcome(undefined, undefined)).toEqual({ outcome: "no-test-report" })
  })
})
