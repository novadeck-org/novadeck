import type { AgentName } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import { apply, started } from "../../harnesses/activity.js"
import { Asks, memoryAsks, type TurnOwner } from "../../messaging/asks.js"
import { describe, expect, it } from "../../test.js"
import type { Record } from "../record.js"
import { Bindings, type BindingsHost } from "./facts.js"

/**
 * Bindings with what the ends of a session use of their host: whose prompt shows as ready
 * there (`shown`), and the announcements and detail changes, counted.
 */
const bindings = (shown?: AgentName) => {
  const announce = vi.fn<(record: Record) => void>()
  const detailed = vi.fn<(record: Record) => void>()
  const host = {
    messaging: () => ({ shownAgent: () => shown, inboxOwner: () => undefined }),
    turns: () => ({ asks: undefined, redactor: undefined }),
    typing: () => ({ dialogsChanged: () => {} }),
    murmurChanged: () => {},
    rebound: () => {},
    announce,
    detailed,
  } as unknown as BindingsHost
  return { bindings: new Bindings(host), announce, detailed }
}

/** A terminal with a Claude Code session bound in its shell, shown as the summary says. */
const record = (summary: Partial<Record["summary"]> = {}) =>
  ({
    summary: { id: "t1", agent: null, ready: null, activity: null, telemetry: null, ...summary },
    agents: {},
    bound: {
      binding: { agent: "claude", sessionId: "s1", instance: "41" },
      activity: started(0),
      telemetry: null,
    },
    // Its own sources followed: its transcript, a subagent's, a reader of the transcript.
    watching: new AbortController(),
    actorWatches: new Map([["a1", { controller: new AbortController(), since: 0 }]]),
    transcript: "/t.jsonl",
    sourceReaders: new Set([new AbortController()]),
    readyEntered: false,
    root: { agent: "claude", sessionId: "s1" },
    suspended: "41",
    seenEntry: { transcript: "/t.jsonl", id: 3 },
  }) as unknown as Record

describe("the ends of a session", () => {
  it("announces the summary its binding's end changed, though it showed no agent", () => {
    // Bound, but not yet shown, as while a Stop's ask waits: the prompt that shows there
    // is ready once the session ends.
    const { bindings: ends, announce } = bindings("claude")
    const bound = record({ agentRan: false })
    expect(ends.endBinding(bound)).toBe(true)
    expect(bound.summary).toMatchObject({ agent: null, ready: "claude" })
    expect(announce).toHaveBeenCalledTimes(1)
  })

  it("announces nothing where a disconnection left the summary as it was", () => {
    const { bindings: ends, announce } = bindings()
    ends.forgotten(record({ agentRan: false }))
    expect(announce).not.toHaveBeenCalled()
  })

  it("tells the detail readers that a disconnection ended the agent", () => {
    const { bindings: ends, detailed } = bindings()
    const bound = record({ agent: "claude", agentRan: true })
    ends.forgotten(bound)
    expect(detailed).toHaveBeenCalledWith(bound)
  })

  it("lets go of the session's own sources, whichever way it ends", () => {
    const { bindings: ends } = bindings()
    for (const end of [
      (bound: Record) => ends.endBinding(bound),
      (bound: Record) => ends.forgotten(bound),
      (bound: Record) => ends.exited(bound),
    ]) {
      const bound = record({ agent: "claude", agentRan: true })
      const sources = [
        bound.watching!,
        ...[...bound.actorWatches.values()].map(({ controller }) => controller),
        ...bound.sourceReaders,
      ]
      end(bound)
      expect(sources.map(({ signal }) => signal.aborted)).toEqual([true, true, true])
      expect(bound).toMatchObject({ watching: null, transcript: null })
      expect([bound.actorWatches.size, bound.sourceReaders.size]).toEqual([0, 0])
    }
  })

  it("keeps what the shell holds while it is still there, as an agent a Ctrl+Z left suspended", () => {
    const { bindings: ends } = bindings()
    for (const end of [
      (bound: Record) => ends.endBinding(bound),
      (bound: Record) => ends.forgotten(bound),
    ]) {
      const bound = record({ agent: "claude", agentRan: true })
      end(bound)
      expect(bound).toMatchObject({ bound: null, suspended: "41", seenEntry: { id: 3 } })
    }
  })

  it("ends what the shell held as it exits, as a restart starts from", () => {
    const { bindings: ends } = bindings()
    const bound = record({ agent: "claude", agentRan: true })
    ends.exited(bound)
    const { bound: session, suspended, root, seenEntry } = ends.restarted()
    expect(bound).toMatchObject({ bound: session, suspended, root })
    expect(bound.seenEntry).toBe(seenEntry)
  })
})

describe("the turn kept for a restart of Novadeck", () => {
  it("ends with a shell that exited mid-turn, so a restart is never told it was running", () => {
    const { bindings: ends } = bindings()
    const bound = record({ agent: "claude", agentRan: true })
    bound.agents = { claude: { sessionId: "s1", turn: "running" } } as unknown as Record["agents"]
    ends.exited(bound)
    expect(bound.agents.claude?.turn).toBeUndefined()
    expect(bound.changed).toBe(true)
  })
})

describe("a turn that ends within its grace as its session does", () => {
  const owner: TurnOwner = {
    projectId: "00000000-0000-4000-8000-000000000003",
    workspaceSessionId: "00000000-0000-4000-8000-000000000004",
    terminalId: "t1",
    handle: "moth",
    agent: "claude",
    sessionId: "s1",
  }
  const fact = (fields: object) =>
    ({ agent: "claude", sessionId: "s1", instance: "41", startedAt: 5, ...fields }) as never

  /** Bindings over a real Asks, and a terminal whose agent just finished a turn at `at`. */
  const finished = (outcome: "completed" | "interrupted" = "completed") => {
    const asks = new Asks(
      {
        owner: () => owner,
        reply: () => {},
        replyState: () => undefined,
        forgetReplies: () => {},
        changed: () => {},
        exists: () => true,
      },
      memoryAsks(),
      Date.now,
      { sweepMs: 0 },
    )
    const host = {
      messaging: () => ({ shownAgent: () => undefined, inboxOwner: () => owner }),
      typing: () => ({ dialogsChanged: () => {} }),
      murmurChanged: () => {},
      rebound: () => {},
      announce: () => {},
      detailed: () => {},
      turns: () => ({ asks, redactor: undefined }),
    } as unknown as BindingsHost
    const ends = new Bindings(host)
    const bound = record({ agent: "claude", agentRan: true })
    const binding = bound.bound!.binding
    const turning = apply(
      started(0, true, false),
      binding,
      fact({ type: "turn-started", startedAt: 1 }),
    )!
    bound.bound = {
      binding,
      activity: apply(
        turning,
        binding,
        fact({ type: "turn-ended", outcome, startedAt: 100, reply: "Done." }),
      )!,
      telemetry: null,
    }
    ends.publishAgent(bound, false)
    const turns = () => asks.list().filter((letter) => letter.content.kind === "turn")
    return { ends, bound, turns, asks }
  }

  it("is stored when the binding ends, is replaced by another session, or the shell exits", () => {
    const cases: [string, (run: ReturnType<typeof finished>) => void][] = [
      ["endBinding", ({ ends, bound }) => void ends.endBinding(bound)],
      [
        "a rebind",
        ({ ends, bound }) => {
          // The new session's fresh activity is installed before it is followed.
          bound.bound = { ...bound.bound!, activity: started(0) }
          ends.follow(bound, { type: "session-observed" } as never)
        },
      ],
      ["a shell exit", ({ ends, bound }) => ends.exited(bound)],
    ]
    for (const [why, end] of cases) {
      const run = finished()
      expect(run.turns(), why).toEqual([])
      end(run)
      expect(run.turns(), why).toMatchObject([{ at: 100, content: { outcome: "completed" } }])
    }
  })

  it("stores nothing for an end that was never one", () => {
    const run = finished("interrupted")
    run.ends.endBinding(run.bound)
    expect(run.turns()).toEqual([])
  })
})

describe("the lead of an agent found gone", () => {
  const pollMs = 1_000
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  const on = (name: NodeJS.Platform): void => {
    Object.defineProperty(process, "platform", { value: name })
  }
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, "platform", platform)
  })

  /** Bindings whose host counts the leads it tells messaging ended, and a led terminal. */
  const led = (stopping = () => false) => {
    const ended = vi.fn<(terminalId: string) => void>()
    const save = vi.fn<(record: Record) => void>()
    const host = {
      messaging: () => ({
        endLead: ended,
        shownAgent: () => undefined,
        inboxOwner: () => undefined,
      }),
      turns: () => ({ asks: undefined, redactor: undefined }),
      typing: () => ({ dialogsChanged: () => {} }),
      murmurChanged: () => {},
      rebound: () => {},
      detailed: () => {},
      save,
      announce: () => {},
      // Its agent's process is gone.
      alive: () => false,
      stopping,
      pollMs,
    } as unknown as BindingsHost
    const worker = record({ ledBy: "moth" })
    Object.assign(worker, {
      closed: false,
      terminal: { pty: { pid: 1 }, exit: null, exiting: false },
    })
    return { ends: new Bindings(host), worker, ended, save }
  }

  it("ends at once where the platform shuts its shells down with their agents", () => {
    on("linux")
    const { ends, worker, ended, save } = led()
    ends.endLeadGone(worker)
    expect(worker.summary.ledBy).toBeNull()
    expect(ended).toHaveBeenCalledWith("t1")
    expect(save).toHaveBeenCalledWith(worker)
  })

  it("ends once the shell has outlived its agent for a sample's time, on Windows", () => {
    on("win32")
    const { ends, worker, ended, save } = led()
    ends.endLeadGone(worker)
    vi.advanceTimersByTime(pollMs - 1)
    expect(worker.summary.ledBy).toBe("moth")
    vi.advanceTimersByTime(1)
    expect(worker.summary.ledBy).toBeNull()
    expect(ended).toHaveBeenCalledWith("t1")
    // Kept with the terminal's next save, as the session the sampler lets go of then is.
    expect(save).not.toHaveBeenCalled()
    expect(worker.changed).toBe(true)
  })

  it("ends so too when the agent's process is found gone, on Windows", () => {
    on("win32")
    const { ends, worker } = led()
    ends.endExited(worker)
    expect(worker.summary.ledBy).toBe("moth")
    vi.advanceTimersByTime(pollMs)
    expect(worker.summary.ledBy).toBeNull()
  })

  it("stays when the runner stops right after its agent, as Windows shuts down", () => {
    on("win32")
    let stopping = false
    const { ends, worker, ended } = led(() => stopping)
    ends.endLeadGone(worker)
    stopping = true
    vi.advanceTimersByTime(pollMs)
    expect(worker.summary.ledBy).toBe("moth")
    expect(ended).not.toHaveBeenCalled()
  })

  it("stays when the shell ends, is replaced or is closed meanwhile, on Windows", () => {
    on("win32")
    const runs = [led(), led(), led()]
    for (const { ends, worker } of runs) ends.endLeadGone(worker)
    const [ending, replaced, closed] = runs.map(({ worker }) => worker)
    ending!.terminal = { ...ending!.terminal, exiting: true } as Record["terminal"]
    replaced!.terminal = { ...replaced!.terminal, pty: { pid: 2 } } as Record["terminal"]
    closed!.closed = true
    vi.advanceTimersByTime(pollMs)
    for (const { worker, ended } of runs) {
      expect(worker.summary.ledBy).toBe("moth")
      expect(ended).not.toHaveBeenCalled()
    }
  })
})
