import { describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import {
  attentionText,
  endingText,
  terminalAsk,
  terminalAsks,
  terminalEnding,
  terminalPhase,
  unheardText,
} from "./terminal-ending"
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

  it("reads an agent by what its hooks say: working, idle, or waiting on the person", () => {
    const agent = (working: boolean, kind?: "permission" | "question") =>
      terminalPhase({
        ...terminal,
        state: "running",
        agent: { working, ...(kind ? { attention: { kind, count: 1 } } : {}) },
      })
    expect(agent(true)).toBe("running")
    expect(agent(false)).toBe("idle")
    expect(agent(true, "permission")).toBe("attention")
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

describe("terminal ask", () => {
  const running = (
    kind?: "question" | "permission" | "plan",
    working = true,
  ): TerminalMetadata => ({
    ...terminal,
    state: "running",
    process: "claude",
    agent: { working, ...(kind ? { attention: { kind, count: 1 } } : {}) },
  })

  it("lists what is asked most pressing first", () => {
    expect(terminalAsks).toEqual(["question", "permission", "plan", "failed", "done"])
  })

  it.each([
    ["a question", running("question"), undefined, "question"],
    ["a permission", running("permission"), undefined, "permission"],
    ["a plan", running("plan"), undefined, "plan"],
    ["a request over an unread reply", running("plan"), "done", "plan"],
    ["an unread finish", running(undefined, false), "done", "done"],
    ["an unread failure", running(undefined, false), "failed", "failed"],
    ["a finish unread at an idle prompt", { ...terminal, state: "idle" }, "done", "done"],
    ["a reply read", running(undefined, false), undefined, undefined],
    ["an agent at work", running(), undefined, undefined],
    ["an unread finish while it works again", running(), "done", undefined],
    [
      "an ended terminal",
      { ...terminal, state: "exited", exitCode: 1, signal: null },
      "done",
      undefined,
    ],
  ] as const)("reads %s", (_, metadata, end, ask) => {
    expect(terminalAsk(metadata as TerminalMetadata, end)).toBe(ask)
  })
})
