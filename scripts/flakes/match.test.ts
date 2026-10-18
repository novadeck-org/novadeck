import { readFileSync } from "node:fs"

import { context, describe, expect, it } from "../test"
import { failuresOf, judgeJob, judgeRun, parseRegister, verdictSummary } from "./match"

const register = parseRegister(JSON.parse(readFileSync("scripts/flakes/register.json", "utf8")))
// A failed job's log as CI caught it, by the flake it shows.
const fixture = (id: string): string => readFileSync(`scripts/flakes/fixtures/${id}.txt`, "utf8")
// The job each fixture's log is from.
const fixtures: Record<string, string> = {
  "ui-companions-plan-reopen-place": "Test (macOS)",
  "ui-companions-plan-restore-layout": "Test (macOS)",
  "ui-agents-pinned-drag-top": "Test (macOS)",
  "ui-preferences-murmur-cancel": "Test (Linux)",
  "ui-preferences-voice-cancel": "Test (macOS)",
  "ui-murmur-offer-expect-element": "Test (Windows)",
  "e2e-codex-quirks-stopped-thread": "Codex (Windows quirks)",
  "e2e-antigravity-macos-lead-tool-call": "Antigravity (macOS)",
  "e2e-claude-windows-interrupted-draft": "Claude Code (Windows)",
  "e2e-claude-windows-interrupt-draft": "Claude Code (Windows)",
  "e2e-claude-macos-continuation-stop": "Claude Code (macOS)",
  "release-quality-wait-window": "macOS",
}

describe("the known-flake register", () => {
  context("when a job failed as a registered flake did", () => {
    // Each log matches its own flake and no other.
    it.each(Object.entries(fixtures))("knows %s by its log alone", (id, job) => {
      expect(judgeJob(register, job, fixture(id))).toEqual({ job, flakes: [id], unknown: [] })
    })
  })

  context("when a test fails that no flake names", () => {
    it("leaves it to be triaged", () => {
      const log = fixture("ui-agents-pinned-drag-top").replace(
        "still reorders the list when dragged to its top",
        "keeps its pins in order",
      )
      expect(judgeJob(register, "Test (macOS)", log).unknown).toEqual([
        expect.stringContaining("keeps its pins in order"),
      ])
    })

    it("leaves a registered test failing another way to be triaged", () => {
      const log = fixture("ui-agents-pinned-drag-top").replaceAll(
        "expected undefined to be 'docs-site'",
        "expected 'blog' to be 'docs-site'",
      )
      expect(judgeJob(register, "Test (macOS)", log).flakes).toEqual([])
    })

    it("leaves a registered test failing in another job to be triaged", () => {
      expect(
        judgeJob(register, "Codex (macOS)", fixture("e2e-codex-quirks-stopped-thread")).flakes,
      ).toEqual([])
    })
  })

  context("when a job failed with no failed test", () => {
    it("matches a job flake by its own error, not its echoed script", () => {
      const log = fixture("release-quality-wait-window")
        .split("\n")
        .filter((line) => !line.includes("##[error]"))
        .join("\n")
      expect(judgeJob(register, "macOS", log)).toEqual({
        job: "macOS",
        flakes: [],
        unknown: ["no failed test in its log"],
      })
    })
  })

  context("when a run is judged", () => {
    const known = { job: "Test (macOS)", log: fixture("ui-agents-pinned-drag-top") }

    it("reruns a run whose every failure is a known flake, once", () => {
      expect(judgeRun(register, [known, { job: "Test", log: "" }], 1).rerun).toBe(true)
      expect(judgeRun(register, [known], 2)).toMatchObject({
        rerun: false,
        reason: expect.stringContaining("failed it again"),
      })
    })

    it("reruns nothing beside a failure no flake explains", () => {
      const verdict = judgeRun(register, [known, { job: "Test (Linux)", log: "Error: boom" }], 1)
      expect(verdict.rerun).toBe(false)
      expect(verdictSummary(verdict, { workflow: "Quality", run: "https://run" })).toContain(
        "| Test (Linux) | – | no failed test in its log |",
      )
    })

    it("treats a flake registered as fixed coming back as news", () => {
      const back = {
        job: "Codex (Windows)",
        log: [
          " FAIL  src/e2e/controls.e2e.ts > Codex, its folder untrusted > never rings an agent at its folder-trust question, and rings it once trusted",
          "Error: Timed out after 60000 ms waiting for fox to be Ready.",
        ].join("\n"),
      }
      expect(judgeRun(register, [back], 1)).toMatchObject({
        rerun: false,
        reason: expect.stringContaining("e2e-codex-windows-folder-trust"),
      })
    })
  })

  context("when a log is read", () => {
    it("takes each failed test once, under GitHub's timestamps and colours", () => {
      const log = [
        "2026-10-17T11:33:27.9127150Z \u001b[31m FAIL \u001b[39m behaviour (chromium)  src/specs/a.spec.tsx > A > b",
        "2026-10-17T11:33:28.0000000Z AssertionError: expected 1 to be 2",
        "2026-10-17T11:40:00.0000000Z  FAIL  behaviour (chromium)  src/specs/a.spec.tsx > A > b",
      ].join("\n")
      expect(failuresOf(log).map((failure) => failure.test)).toEqual([
        "src/specs/a.spec.tsx > A > b",
      ])
    })
  })

  context("when a known flake fails beside what this can't read", () => {
    const known = fixture("ui-agents-pinned-drag-top")

    it.each([
      [" FAIL  unit  src/model/store.test.ts > a store > wakes its listeners", "store.test.ts"],
      [" FAIL  src/specs/zen.spec.tsx [ src/specs/zen.spec.tsx ]", "zen.spec.tsx"],
      [" FAIL  extract/routes.ts > reads them", "can't read"],
      ["⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯", "outside any test"],
    ])("leaves the job to be triaged: %s", (line, named) => {
      const verdict = judgeJob(register, "Test (macOS)", `${known}\n${line}\n`)
      expect(verdict.flakes).toEqual(["ui-agents-pinned-drag-top"])
      expect(verdict.unknown).toEqual([expect.stringContaining(named)])
    })
  })

  context("when two tests fail one after the other", () => {
    it("reads each failure's own lines, not the next one's", () => {
      const log = [
        " FAIL  behaviour (chromium)  src/specs/companions.spec.tsx > Undocking an item into a window of its own > when dragged onto the Grid's free space > opens a window there",
        "TypeError: Cannot read properties of null",
        "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯",
        known(),
      ].join("\n")
      expect(judgeJob(register, "Test (macOS)", log)).toMatchObject({
        flakes: ["ui-agents-pinned-drag-top"],
        unknown: [expect.stringContaining("opens a window there")],
      })
    })

    it("knows a test as a flake only if each of its errors is the flake's", () => {
      const first = [
        " FAIL  src/e2e/messaging.e2e.ts > Codex > drops a stopped thread's waiting message, and refuses the sender another",
        "TypeError: Cannot read properties of null",
      ].join("\n")
      const log = `${first}\n${fixture("e2e-codex-quirks-stopped-thread")}`
      expect(judgeJob(register, "Codex (Windows quirks)", log)).toMatchObject({
        flakes: [],
        unknown: [expect.stringContaining("drops a stopped thread's waiting message")],
      })
    })

    it("gives each of the tests Vitest groups under one error that error", () => {
      const log = [
        " FAIL  behaviour (chromium)  src/specs/a.spec.tsx > first",
        " FAIL  behaviour (chromium)  src/specs/a.spec.tsx > second",
        "TypeError: Cannot read properties of null",
        "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯",
      ].join("\n")
      expect(
        failuresOf(log).map(({ test, reports }) => [
          test,
          reports.length,
          /TypeError/.test(reports[0] ?? ""),
        ]),
      ).toEqual([
        ["src/specs/a.spec.tsx > first", 1, true],
        ["src/specs/a.spec.tsx > second", 1, true],
      ])
    })

    const known = (): string => fixture("ui-agents-pinned-drag-top")
  })

  context("when the register is read", () => {
    it("refuses a flake that couldn't match as meant", () => {
      const flake = register.flakes[0]!
      expect(() => parseRegister({ ...register, flakes: [{ ...flake, signature: "(" }] })).toThrow(
        "doesn't compile",
      )
      expect(() => parseRegister({ ...register, flakes: [flake, flake] })).toThrow("twice")
      expect(() => parseRegister({ ...register, flakes: [{ ...flake, status: "maybe" }] })).toThrow(
        "status",
      )
    })
  })
})
