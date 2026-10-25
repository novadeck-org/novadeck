import {
  attentionText,
  doneText,
  endingText,
  needText,
  pausedText,
  pausedUntil,
  terminalEnding,
  terminalNeedMark,
  terminalPhase,
  unheardText,
} from "./terminal-ending"
import { describe, expect, it } from "./test"
import { terminalFixture } from "./testing"
import type { TerminalMetadata } from "./types"

const terminal = terminalFixture(1, "~/project")

describe("terminal ending", () => {
  it("names the exit code of a shell that exited, as a warning", () => {
    const ending = terminalEnding({ ...terminal, state: "exited", exitCode: 130, signal: null })
    expect(ending?.tone).toBe("warning")
    expect(ending && endingText(ending)).toBe("Exited · code 130")
  })

  it("says only that the shell exited when the code is unknown", () => {
    const ending = terminalEnding({ ...terminal, state: "exited", exitCode: null, signal: null })
    expect(ending && endingText(ending)).toBe("Exited")
  })

  it("names the signal that killed a shell, as danger", () => {
    const ending = terminalEnding({
      ...terminal,
      state: "exited",
      exitCode: null,
      signal: "SIGKILL",
    })
    expect(ending).toEqual({ tone: "danger", status: "Killed", reason: "SIGKILL" })
  })

  it("gives the reason a shell failed to start, as danger", () => {
    const ending = terminalEnding({ ...terminal, state: "failed", message: "Folder not found" })
    expect(ending?.tone).toBe("danger")
    expect(ending && endingText(ending)).toBe("Failed to start · Folder not found")
  })

  it("has none while the shell is starting, running, idle or finished", () => {
    const states = ["starting", "running", "idle", "finished"] as const
    expect(states.map((state) => terminalEnding({ ...terminal, state }))).toEqual([
      null,
      null,
      null,
      null,
    ])
  })

  it("reads each state as a phase for tabs and windows", () => {
    expect(terminalPhase({ ...terminal, state: "starting" })).toBe("starting")
    expect(terminalPhase({ ...terminal, state: "idle" })).toBe("idle")
    expect(terminalPhase({ ...terminal, state: "running" })).toBe("running")
    expect(terminalPhase({ ...terminal, state: "finished" })).toBe("idle")
    expect(terminalPhase({ ...terminal, state: "exited", exitCode: 1, signal: null })).toBe("ended")
    expect(terminalPhase({ ...terminal, state: "failed", message: "" })).toBe("ended")
  })

  it("reads an agent by what its hooks say: working or idle, a dialog being no phase", () => {
    const agent = (working: boolean, kind?: "permission" | "question") =>
      terminalPhase({
        ...terminal,
        state: "running",
        agent: { working, ...(kind ? { attention: { kind, count: 1 } } : {}) },
      })
    expect(agent(true)).toBe("running")
    expect(agent(false)).toBe("idle")
    // It waits on a dialog: the need mark shows that, the glyph what it does.
    expect(agent(false, "permission")).toBe("idle")
    // Its harness keeps the turn open while the dialog waits, but nothing works until they answer.
    expect(agent(true, "question")).toBe("idle")
    expect(agent(true, "permission")).toBe("idle")
  })

  it("is done only from a done input, never from a turn that ended", () => {
    const resting: TerminalMetadata = {
      ...terminal,
      state: "running",
      agent: { working: false, lastTurn: { at: 1, outcome: "completed" } },
    }
    expect(terminalPhase(resting)).toBe("idle")
    expect(terminalPhase(resting, true)).toBe("done")
    expect(terminalPhase({ ...resting, agent: { working: true } }, true)).toBe("running")
  })

  it("pauses an agent that stopped on a usage limit, until it works again", () => {
    const at = new Date(2026, 9, 25, 15, 40).getTime()
    const limited = (working: boolean): TerminalMetadata => ({
      ...terminal,
      state: "running",
      agent: {
        working,
        lastTurn: { at: 1, outcome: "failed", limit: { minutes: 300, resetsAt: at } },
      },
    })
    expect(terminalPhase(limited(false))).toBe("paused")
    // Paused outranks done: what it does now is stopped.
    expect(terminalPhase(limited(false), true)).toBe("paused")
    expect(terminalPhase(limited(true))).toBe("running")
    expect(pausedUntil(limited(false))).toBe(at)
    expect(pausedUntil(limited(true))).toBeUndefined()
    expect(pausedText(limited(false))).toBe("Paused at its usage limit · resets 15:40")
    expect(pausedText(limited(true))).toBeUndefined()
    // Limited with no window known has no time to show.
    expect(
      terminalPhase({
        ...terminal,
        state: "running",
        agent: { working: false, lastTurn: { at: 1, outcome: "failed", limited: true } },
      }),
    ).toBe("idle")
  })

  it("reads an agent Novadeck hears nothing from as unheard, any other program as running", () => {
    const running = (process: string) => ({ ...terminal, state: "running" as const, process })
    for (const agent of ["claude", "codex", "agy"])
      expect(terminalPhase(running(agent)), agent).toBe("unheard")
    expect(terminalPhase(running("vim"))).toBe("running")
    expect(terminalPhase({ ...running("claude"), agent: { working: false } })).toBe("idle")
    expect(unheardText(running("codex"))).toBe(
      "Not reporting · Novadeck can't hear from this agent",
    )
    expect(unheardText(running("vim"))).toBeUndefined()
    // Once it has exited, it has ended, whatever it was.
    expect(
      terminalPhase({ ...terminal, process: "claude", state: "exited", exitCode: 1, signal: null }),
    ).toBe("ended")
  })

  it("says what an agent waits on the person for", () => {
    const waiting = (kind: "permission" | "question", count: number) =>
      attentionText({
        ...terminal,
        state: "running",
        agent: { working: true, attention: { kind, count } },
      })
    expect(waiting("permission", 1)).toBe("Needs permission")
    expect(waiting("question", 2)).toBe("Asks a question · 2 waiting")
    expect(attentionText({ ...terminal, state: "running" })).toBeUndefined()
  })
})

describe("terminal need mark", () => {
  const running = (kind?: "question" | "permission" | "plan"): TerminalMetadata => ({
    ...terminal,
    state: "running",
    process: "claude",
    agent: { working: false, ...(kind ? { attention: { kind, count: 1 } } : {}) },
  })

  it.each([
    ["a question", running("question"), undefined, "ask"],
    ["a permission", running("permission"), undefined, "unblock"],
    ["a plan", running("plan"), undefined, "unblock"],
    ["an item's ask", running(), "ask", "ask"],
    ["an item's unblock", running(), "unblock", "unblock"],
    ["a question over an unblock item", running("question"), "unblock", "unblock"],
    ["a permission over an ask item", running("permission"), "ask", "unblock"],
    ["a question over an ask item", running("question"), "ask", "ask"],
    ["nothing", running(), undefined, undefined],
    ["a dialog of an ended terminal", { ...running("plan"), state: "idle" }, undefined, undefined],
  ] as const)("reads %s", (_, metadata, inbox, need) => {
    expect(terminalNeedMark(metadata as TerminalMetadata, inbox)).toBe(need)
  })

  it("says the need in words, with the item's subject where there is one", () => {
    expect(needText(running(), "ask", "Where should feedback go?")).toBe(
      "Asks: Where should feedback go?",
    )
    expect(needText(running(), "unblock", "wrangler login")).toBe("Needs you: wrangler login")
    expect(needText(running("permission"), "unblock")).toBe("Needs permission")
    expect(needText(running(), "ask")).toBe("Asks a question")
    expect(needText(running(), "unblock")).toBe("Needs you")
    expect(needText(running(), undefined)).toBeUndefined()
  })

  it("words a done tab as a report, a failed one as an error", () => {
    expect(doneText()).toBe("Done · report unread")
    expect(doneText(true)).toBe("Stopped with an error · reply unread")
  })
})
