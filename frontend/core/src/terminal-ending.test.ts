import {
  attentionText,
  doneText,
  endingText,
  needText,
  joinNote,
  pausedText,
  pausedUntil,
  terminalEnding,
  terminalGlance,
  terminalNeedMark,
  terminalNote,
  terminalPhase,
  unheardText,
  waitingAgents,
} from "./terminal-ending"
import { describe, expect, it } from "./test"
import { terminalFixture } from "./testing"
import type { AgentStatus, TerminalMetadata } from "./types"

const terminal = terminalFixture(1, "~/project")

describe("terminal ending", () => {
  it("names the exit code of a shell that exited, as a warning", () => {
    const ending = terminalEnding({
      ...terminal,
      state: "exited",
      exitCode: 130,
      signal: null,
    })
    expect(ending?.tone).toBe("warning")
    expect(ending && endingText(ending)).toBe("Exited · code 130")
  })

  it("says only that the shell exited when the code is unknown", () => {
    const ending = terminalEnding({
      ...terminal,
      state: "exited",
      exitCode: null,
      signal: null,
    })
    expect(ending && endingText(ending)).toBe("Exited")
  })

  it("names the signal that killed a shell, as danger", () => {
    const ending = terminalEnding({
      ...terminal,
      state: "exited",
      exitCode: null,
      signal: "SIGKILL",
    })
    expect(ending).toEqual({
      tone: "danger",
      status: "Killed",
      reason: "SIGKILL",
    })
  })

  it("gives the reason a shell failed to start, as danger", () => {
    const ending = terminalEnding({
      ...terminal,
      state: "failed",
      message: "Folder not found",
    })
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
    expect(
      terminalPhase({
        ...terminal,
        state: "exited",
        exitCode: 1,
        signal: null,
      }),
    ).toBe("ended")
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
        lastTurn: {
          at: 1,
          outcome: "failed",
          limit: { minutes: 300, resetsAt: at },
        },
      },
    })
    expect(terminalPhase(limited(false))).toBe("paused")
    // Paused outranks done: what it does now is stopped.
    expect(terminalPhase(limited(false), true)).toBe("paused")
    expect(terminalPhase(limited(true))).toBe("running")
    expect(pausedUntil(limited(false))).toBe(at)
    expect(pausedUntil(limited(true))).toBeUndefined()
    expect(pausedText(limited(false), at - 1)).toBe("Paused at its usage limit · resets 15:40")
    expect(pausedText(limited(true), at - 1)).toBeUndefined()
    // Once the time has passed it says the limit has reset, not a past time.
    expect(pausedText(limited(false), at)).toBe(
      "Paused at its usage limit · it has reset and waits to be continued",
    )
    expect(pausedText(limited(false), at + 1)).not.toContain("resets 15:40")
    // Limited with no window known has no time to show.
    expect(
      terminalPhase({
        ...terminal,
        state: "running",
        agent: {
          working: false,
          lastTurn: { at: 1, outcome: "failed", limited: true },
        },
      }),
    ).toBe("idle")
  })

  it("reads an agent Novadeck hears nothing from as unheard, any other program as running", () => {
    const running = (process: string) => ({
      ...terminal,
      state: "running" as const,
      process,
    })
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
      terminalPhase({
        ...terminal,
        process: "claude",
        state: "exited",
        exitCode: 1,
        signal: null,
      }),
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
    agent: {
      working: false,
      ...(kind ? { attention: { kind, count: 1 } } : {}),
    },
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

  it("says the need in words, the kind first and the item's subject after it", () => {
    expect(needText(running(), "ask", "Where should feedback go?")).toBe(
      "Asks: Where should feedback go?",
    )
    // An Inbox unblock that is no dialog (a held message, a sign-in, a limit).
    expect(needText(running(), "unblock", "wrangler login")).toBe("Needs you: wrangler login")
    expect(needText(running("permission"), "unblock")).toBe("Needs permission")
    expect(needText(running(), "ask")).toBe("Asks a question")
    expect(needText(running(), "unblock")).toBe("Needs you")
    expect(needText(running(), undefined)).toBeUndefined()
  })

  it("keeps the kind of the dialog when its Inbox row arrives with a subject", () => {
    // The dialog alone, as it shows for its first moments.
    expect(needText(running("permission"), undefined)).toBe("Needs permission")
    // The same dialog once its item exists, still a permission, now with its subject.
    expect(needText(running("permission"), "unblock", "pnpm test …", "permission")).toBe(
      "Needs permission: pnpm test …",
    )
    expect(needText(running("plan"), undefined)).toBe("Plan ready for review")
    expect(needText(running("plan"), "unblock", "Checkout flow", "plan")).toBe(
      "Plan ready for review: Checkout flow",
    )
    expect(needText(running("question"), undefined)).toBe("Asks a question")
    expect(needText(running("question"), "ask", "Which?", "question")).toBe("Asks: Which?")
    // The row without the dialog showing (it ended or was answered in the TUI) keeps its kind.
    expect(needText(running(), "unblock", "pnpm test …", "permission")).toBe(
      "Needs permission: pnpm test …",
    )
    expect(needText(running(), "unblock", undefined, "plan")).toBe("Plan ready for review")
    expect(needText(running(), "ask", undefined, "question")).toBe("Asks a question")
  })

  it("takes the words from whichever source decided the mark", () => {
    // A live dialog that wins over an Inbox ask says what the dialog says.
    expect(needText(running("plan"), "ask", "Which?")).toBe("Plan ready for review")
    expect(needText(running("permission"), "ask", "Which?")).toBe("Needs permission")
    // An Inbox unblock wins over a live question, with its own subject and no borrowed kind.
    expect(needText(running("question"), "unblock", "wrangler login")).toBe(
      "Needs you: wrangler login",
    )
    // An item that is no dialog doesn't borrow the live dialog's kind either.
    expect(needText(running("permission"), "unblock", "wrangler login")).toBe(
      "Needs you: wrangler login",
    )
    expect(needText(running("question"), "ask")).toBe("Asks a question")
    // An Inbox unblock without words, over a live question, doesn't borrow the question's.
    expect(needText(running("question"), "unblock")).toBe("Needs you")
  })

  it("words a done tab as a report, a failed one as an error", () => {
    expect(doneText()).toBe("Done · report unread")
    expect(doneText(true)).toBe("Stopped with an error · reply unread")
  })
})

describe("joinNote", () => {
  it("lowercases the parts after the first and drops the missing", () => {
    expect(joinNote(["Needs you", "Paused at its usage limit · resets 15:40"])).toBe(
      "Needs you, paused at its usage limit · resets 15:40",
    )
    expect(joinNote([undefined, "Done · report unread"])).toBe("Done · report unread")
    expect(joinNote(["Asks: Which?", undefined])).toBe("Asks: Which?")
  })
})

describe("waitingAgents", () => {
  const job = {
    id: "j",
    description: "Watch CI",
    command: "gh pr checks",
    since: 1,
    until: null,
  }
  const waiting = (attention?: AgentStatus["attention"]): TerminalMetadata => ({
    ...terminal,
    state: "running",
    process: "claude",
    agent: {
      working: false,
      waiting: { jobs: [job], wake: null },
      ...(attention && { attention }),
    },
  })

  it("counts an agent that waits on a job, but not one held on a dialog", () => {
    const held = waiting({ kind: "permission", count: 1 })
    expect(terminalPhase(held)).toBe("waiting")
    expect(waitingAgents([waiting(), held])).toEqual([waiting()])
  })
})

describe("a terminal's note", () => {
  const at = new Date(2026, 9, 26, 15, 40).getTime()
  const now = at - 60_000
  const agent = (fields: Partial<AgentStatus> = {}): TerminalMetadata => ({
    ...terminal,
    state: "running",
    process: "claude",
    agent: { working: false, ...fields },
  })
  const quiet = { need: undefined, done: false } as const

  it("is a bare idle terminal with nothing to say", () => {
    expect(terminalNote(agent(), quiet, undefined, now)).toEqual({
      phase: "idle",
      need: undefined,
      failed: false,
      brightened: false,
      text: undefined,
    })
  })

  it("says the need first, then what the terminal does", () => {
    const paused = agent({
      lastTurn: {
        at: 1,
        outcome: "failed",
        limit: { minutes: 300, resetsAt: at },
      },
    })
    expect(
      terminalNote(
        paused,
        { need: "unblock", done: false, subject: "wrangler login" },
        undefined,
        now,
      ),
    ).toMatchObject({
      phase: "paused",
      need: "unblock",
      text: "Needs you: wrangler login, paused at its usage limit · resets 15:40",
    })
  })

  it("words a done report and a stopped turn apart, and a reply unread beside neither", () => {
    expect(terminalNote(agent(), { need: undefined, done: true }, undefined, now)).toMatchObject({
      phase: "done",
      failed: false,
      text: "Done · report unread",
    })
    expect(terminalNote(agent(), quiet, "failed", now)).toMatchObject({
      phase: "done",
      failed: true,
      text: "Stopped with an error · reply unread",
    })
    expect(terminalNote(agent(), quiet, "unread", now)).toMatchObject({
      phase: "idle",
      brightened: true,
      text: "Reply unread",
    })
  })

  it("shows no reply unread on an agent that works, nor a need on an ended terminal", () => {
    expect(terminalNote(agent({ working: true }), quiet, "unread", now)).toMatchObject({
      phase: "running",
      brightened: false,
      text: undefined,
    })
    const ended = {
      ...terminal,
      state: "exited" as const,
      exitCode: 1,
      signal: null,
    }
    expect(terminalNote(ended, { need: "ask", done: false }, undefined, now)).toMatchObject({
      phase: "ended",
      need: undefined,
    })
  })

  it("says an agent Novadeck can't hear from before anything of its state", () => {
    const unheard = {
      ...terminal,
      state: "running" as const,
      process: "claude",
    }
    expect(terminalNote(unheard, quiet, "unread", now).text).toBe(
      "Not reporting · Novadeck can't hear from this agent",
    )
  })

  it("gives the glance of a terminal the same, without the words", () => {
    const marks = { need: "ask", done: true } as const
    const { text: _, ...glance } = terminalNote(agent(), marks, "failed", now)
    expect(terminalGlance(agent(), marks, "failed", now)).toEqual(glance)
  })
})
