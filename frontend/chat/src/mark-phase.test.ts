import type { TerminalPhase } from "@novadeck/core/terminals/ending"

import { markPhase } from "./mark-phase"
import { describe, expect, it } from "./test"

const of = (phase: TerminalPhase, need = false, failed = false) =>
  markPhase({ phase, need, failed })

describe("the current prompt's mark, by the window's phase", () => {
  it.each([
    "running",
    "starting",
    "sleeping",
    "waking",
    "paused",
    "unheard",
    "ended",
    "done",
  ] as const)("takes the %s phase as it stands", (phase) => {
    expect(of(phase)).toBe(phase)
  })

  it("stays the still accent while the agent is idle or waits on something that wakes it", () => {
    expect(of("idle")).toBeUndefined()
    expect(of("waiting")).toBeUndefined()
  })

  it("turns to need where the agent has stopped and needs the person", () => {
    for (const phase of [
      "idle",
      "done",
      "waiting",
      "paused",
      "sleeping",
      "waking",
      "unheard",
    ] as const)
      expect(of(phase, true)).toBe("need")
  })

  it("keeps the running line over a side request, as the window does", () => {
    expect(of("running", true)).toBe("running")
    expect(of("starting", true)).toBe("starting")
    expect(of("ended", true)).toBe("ended")
  })

  it("is failed for a done report that stopped on an error, and need still wins over it", () => {
    expect(of("done", false, true)).toBe("failed")
    expect(of("done", true, true)).toBe("need")
  })

  it("ignores a failure that isn't a done report", () => {
    expect(of("idle", false, true)).toBeUndefined()
    expect(of("running", false, true)).toBe("running")
  })
})
