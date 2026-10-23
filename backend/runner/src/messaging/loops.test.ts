import type { ActivityEvent, HarnessEvent, ToolKind } from "@novadeck/harness-core/events"

import { describe, expect, it } from "../test.js"
import { keepEntries, keepMs, Loops } from "./loops.js"

const T = "t"

type Body<T> = T extends unknown ? Omit<T, keyof ActivityEvent & string> : never

/** An activity event of the test session, from its body alone. */
const act = (body: Body<ActivityEvent>, startedAt = 0): HarnessEvent =>
  ({ agent: "claude", sessionId: "s", instance: null, startedAt, ...body }) as HarnessEvent

const session: HarnessEvent = {
  type: "session-observed",
  agent: "claude",
  sessionId: "s",
  evidence: "hook",
  startedAt: 0,
  instance: null,
} as unknown as HarnessEvent

const call = (
  kind: ToolKind,
  extra: { actor?: string; background?: true } = {},
  startedAt = 0,
): HarnessEvent =>
  act(
    {
      type: "tool-called",
      actor: extra.actor ?? null,
      toolName: "Tool",
      kind,
      ...(extra.background ? { background: true as const } : {}),
    },
    startedAt,
  )
const turnStarted = (cause: "prompt" | "harness" = "harness"): HarnessEvent =>
  act({
    type: "turn-started",
    cause,
  })
const turnEnded = (background?: { agents: number; tasks: number; more?: true }): HarnessEvent =>
  act({
    type: "turn-ended",
    outcome: "completed",
    ...(background ? { background } : {}),
  })
const subStarted = (actor: string): HarnessEvent =>
  act({
    type: "subagent-started",
    actor,
    actorType: null,
  })
const requested = (requestId: string, actor: string | null = null): HarnessEvent =>
  act({
    type: "attention-requested",
    requestId,
    actor,
    toolName: "Bash",
    kind: "permission",
    subject: null,
    choices: [],
  })
const resolved = (requestId: string): HarnessEvent =>
  act({
    type: "attention-resolved",
    requestId,
    actor: null,
    toolName: "Bash",
    loose: false,
    outcome: "allowed",
  })

/** A tracker watching from 0 whose session has reported one early bookkeeping call. */
const known = (): Loops => {
  const loops = new Loops(() => 0)
  loops.observe(T, [session, call("bookkeeping")], 0)
  return loops
}

describe("loops: work calls", () => {
  it("count when a work call, root or subagent, reached the runner in the window", () => {
    const loops = known()
    loops.observe(T, [call("work")], 100)
    loops.observe(T, [call("work", { actor: "sub" })], 300)
    expect(loops.worked(T, 50, 150)).toBe(true)
    expect(loops.worked(T, 200, 400)).toBe(true)
    expect(loops.worked(T, 150, 250)).toBe(false)
  })

  it("exclude the window's start and include its end", () => {
    const loops = known()
    loops.observe(T, [call("work")], 100)
    expect(loops.worked(T, 100, 200)).toBe(false)
    expect(loops.worked(T, 0, 100)).toBe(true)
  })

  it("do not count novadeck, bookkeeping or waiting calls", () => {
    const loops = known()
    loops.observe(T, [call("novadeck")], 100)
    loops.observe(T, [call("bookkeeping")], 200)
    loops.observe(T, [call("waiting")], 300)
    expect(loops.worked(T, 50, 400)).toBe(false)
  })
})

describe("loops: sends", () => {
  it("count as a call just after them, so a turn that only sent has not run through", () => {
    const loops = known()
    loops.observe(T, [turnStarted()], 10)
    loops.sent(T, 100)
    // Without the send the turn would pass for one running through (100, 200].
    expect(loops.worked(T, 100, 200)).toBe(false)
    expect(loops.worked(T, 50, 100)).toBe(true)
    expect(loops.worked(T, 99, 100)).toBe(true)
  })

  it("do not make a session known: only a reported call does", () => {
    const loops = new Loops(() => 0)
    loops.observe(T, [session], 0)
    loops.sent(T, 5)
    expect(loops.worked(T, 5, 10)).toBe("unknown")
    loops.observe(T, [call("bookkeeping")], 6)
    expect(loops.worked(T, 5, 10)).toBe(false)
  })
})

describe("loops: subagents", () => {
  it("count while running at the window's start or started in it, to the end", () => {
    const loops = known()
    loops.observe(T, [subStarted("a")], 100)
    loops.observe(T, [act({ type: "subagent-stopped", actor: "a" })], 200)
    expect(loops.worked(T, 50, 100)).toBe(true)
    expect(loops.worked(T, 150, 160)).toBe(true)
    expect(loops.worked(T, 199, 300)).toBe(true)
    expect(loops.worked(T, 200, 300)).toBe(false)
    expect(loops.worked(T, 0, 99)).toBe(false)
  })

  it("count while still running", () => {
    const loops = known()
    loops.observe(T, [subStarted("a")], 100)
    expect(loops.worked(T, 5_000, 6_000)).toBe(true)
  })

  it("do not count after an abort", () => {
    const loops = known()
    loops.observe(T, [subStarted("a")], 100)
    loops.observe(T, [act({ type: "subagent-turn-aborted", actor: "a" })], 150)
    expect(loops.worked(T, 120, 140)).toBe(true)
    expect(loops.worked(T, 150, 300)).toBe(false)
  })

  it("keep other subagents counting when one stops", () => {
    const loops = known()
    loops.observe(T, [subStarted("a"), subStarted("b")], 100)
    loops.observe(T, [act({ type: "subagent-stopped", actor: "a" })], 150)
    expect(loops.worked(T, 200, 300)).toBe(true)
  })
})

describe("loops: background tasks", () => {
  it("count from a work call until a turn end that leaves none", () => {
    const loops = known()
    loops.observe(T, [call("work", { background: true })], 100)
    loops.observe(T, [turnEnded({ agents: 0, tasks: 1 })], 150)
    expect(loops.worked(T, 160, 170)).toBe(true)
    loops.observe(T, [turnStarted(), turnEnded({ agents: 0, tasks: 0 })], 200)
    expect(loops.worked(T, 160, 200)).toBe(true)
    expect(loops.worked(T, 200, 300)).toBe(false)
  })

  it("end at a turn end that says nothing of them", () => {
    const loops = known()
    loops.observe(T, [call("work", { background: true })], 100)
    loops.observe(T, [turnEnded()], 150)
    expect(loops.worked(T, 150, 300)).toBe(false)
  })

  it("keep as many as the turn end says, the newest, and all when it says more", () => {
    const loops = known()
    loops.observe(T, [call("work", { background: true })], 100)
    loops.observe(T, [call("work", { background: true })], 110)
    loops.observe(T, [turnEnded({ agents: 0, tasks: 1 })], 150)
    expect(loops.worked(T, 200, 300)).toBe(true)
    loops.observe(T, [turnEnded({ agents: 0, tasks: 0, more: true })], 400)
    expect(loops.worked(T, 500, 600)).toBe(true)
    loops.observe(T, [turnEnded({ agents: 0, tasks: 0 })], 700)
    expect(loops.worked(T, 800, 900)).toBe(false)
  })

  it("do not count one a waiting call started", () => {
    const loops = known()
    loops.observe(T, [call("waiting", { background: true })], 100)
    expect(loops.worked(T, 100, 300)).toBe(false)
  })
})

describe("loops: requests waiting on the person", () => {
  it("count at any moment they were pending", () => {
    const loops = known()
    loops.observe(T, [requested("r")], 100)
    loops.observe(T, [resolved("r")], 200)
    expect(loops.worked(T, 50, 100)).toBe(true)
    expect(loops.worked(T, 150, 160)).toBe(true)
    expect(loops.worked(T, 199, 250)).toBe(true)
    expect(loops.worked(T, 200, 250)).toBe(false)
  })

  it("count while unresolved", () => {
    const loops = known()
    loops.observe(T, [requested("r")], 100)
    expect(loops.worked(T, 1_000, 2_000)).toBe(true)
  })

  it("stop counting for a subagent whose turn aborted", () => {
    const loops = known()
    loops.observe(T, [requested("r", "sub")], 100)
    loops.observe(T, [act({ type: "subagent-turn-aborted", actor: "sub" })], 150)
    expect(loops.worked(T, 160, 300)).toBe(false)
  })
})

describe("loops: a turn through the window", () => {
  it("counts when it started before and nothing stopped or called in it", () => {
    const loops = known()
    loops.observe(T, [turnStarted()], 10)
    expect(loops.worked(T, 50, 500)).toBe(true)
    expect(loops.worked(T, 10, 500)).toBe(true)
    expect(loops.worked(T, 9, 500)).toBe(false)
  })

  it("does not count with a call of any kind reported in the window", () => {
    const loops = known()
    loops.observe(T, [turnStarted()], 10)
    loops.observe(T, [call("waiting")], 100)
    loops.observe(T, [call("novadeck")], 300)
    expect(loops.worked(T, 50, 150)).toBe(false)
    expect(loops.worked(T, 100, 200)).toBe(true)
    expect(loops.worked(T, 150, 250)).toBe(true)
    expect(loops.worked(T, 250, 300)).toBe(false)
  })

  it("does not count with a Stop in the window, or a turn that ended before it", () => {
    const loops = known()
    loops.observe(T, [turnStarted()], 10)
    loops.observe(T, [turnEnded()], 100)
    expect(loops.worked(T, 50, 150)).toBe(false)
    expect(loops.worked(T, 100, 200)).toBe(false)
    expect(loops.worked(T, 120, 200)).toBe(false)
  })

  it("counts a Stop Novadeck continued as a Stop, then runs on", () => {
    const loops = known()
    loops.observe(T, [turnStarted()], 10)
    loops.observe(T, [act({ type: "turn-continued" })], 100)
    expect(loops.worked(T, 50, 150)).toBe(false)
    expect(loops.worked(T, 100, 200)).toBe(true)
  })

  it("does not count a turn that started in the window", () => {
    const loops = known()
    loops.observe(T, [turnStarted()], 100)
    expect(loops.worked(T, 50, 150)).toBe(false)
  })
})

describe("loops: the person's prompt", () => {
  it("counts a turn started by one in the window only", () => {
    const loops = known()
    loops.observe(T, [turnStarted("prompt"), turnEnded()], 100)
    loops.observe(T, [turnStarted("harness"), turnEnded()], 300)
    expect(loops.worked(T, 50, 100)).toBe(true)
    expect(loops.worked(T, 100, 400)).toBe(false)
  })
})

describe("loops: unknown", () => {
  it("is returned for a terminal nothing is known of, or with no session observed", () => {
    const loops = new Loops(() => 0)
    expect(loops.worked(T, 0, 10)).toBe("unknown")
    loops.observe(T, [call("work")], 5)
    expect(loops.worked(T, 5, 10)).toBe("unknown")
  })

  it("is returned until the session reports a call", () => {
    const loops = new Loops(() => 0)
    loops.observe(T, [session], 0)
    loops.observe(T, [turnStarted("prompt")], 5)
    expect(loops.worked(T, 4, 10)).toBe("unknown")
    loops.observe(T, [call("bookkeeping")], 6)
    expect(loops.worked(T, 4, 10)).toBe(true)
  })

  it("is returned for a window starting before watching began", () => {
    const loops = new Loops(() => 0)
    loops.observe(T, [session, call("bookkeeping")], 1_000)
    expect(loops.worked(T, 999, 1_100)).toBe("unknown")
    expect(loops.worked(T, 1_000, 1_100)).toBe(false)
  })
})

describe("loops: reset, forget and pruning", () => {
  it("reset forgets what was done and is unknown until a call is reported", () => {
    let clock = 0
    const loops = new Loops(() => clock)
    loops.observe(T, [session, call("work")], 100)
    clock = 500
    loops.reset(T)
    expect(loops.worked(T, 600, 700)).toBe("unknown")
    loops.observe(T, [session], 600)
    expect(loops.worked(T, 600, 700)).toBe("unknown")
    loops.observe(T, [call("waiting")], 650)
    expect(loops.worked(T, 600, 700)).toBe(false)
    // The old work call and anything before the reset says nothing now.
    expect(loops.worked(T, 50, 150)).toBe("unknown")
    expect(loops.worked(T, 500, 700)).toBe(false)
  })

  it("reset clears subagents, requests and tasks", () => {
    const clock = 500
    const loops = new Loops(() => clock)
    loops.observe(
      T,
      [session, subStarted("a"), requested("r"), call("work", { background: true })],
      100,
    )
    loops.reset(T)
    loops.observe(T, [session, call("bookkeeping")], 600)
    expect(loops.worked(T, 600, 700)).toBe(false)
  })

  it("forget drops the terminal", () => {
    const loops = known()
    loops.forget(T)
    expect(loops.worked(T, 0, 10)).toBe("unknown")
    loops.observe(T, [session, call("bookkeeping")], 50)
    expect(loops.worked(T, 0, 60)).toBe("unknown")
  })

  it("prunes history older than the keep time and says unknown for windows reaching it", () => {
    const loops = known()
    loops.observe(T, [call("work")], 100)
    loops.observe(T, [call("bookkeeping")], keepMs + 200)
    expect(loops.worked(T, 50, 150)).toBe("unknown")
    expect(loops.worked(T, 100, 150)).toBe(false)
    expect(loops.worked(T, keepMs + 100, keepMs + 300)).toBe(false)
  })

  it("keeps a turn running across pruning", () => {
    const loops = known()
    loops.observe(T, [turnStarted()], 10)
    loops.observe(T, [call("bookkeeping")], keepMs + 500)
    expect(loops.worked(T, keepMs + 500, keepMs + 900)).toBe(true)
  })

  it("keeps open spans past the keep time", () => {
    const loops = known()
    loops.observe(T, [subStarted("a")], 10)
    loops.observe(T, [call("bookkeeping")], keepMs + 500)
    expect(loops.worked(T, keepMs + 500, keepMs + 900)).toBe(true)
  })

  it("caps entries per terminal", () => {
    const loops = known()
    for (let i = 1; i <= keepEntries + 10; i++) loops.observe(T, [call("work")], i)
    const past = keepEntries + 10
    expect(loops.worked(T, past - 1, past)).toBe(true)
    expect(loops.worked(T, 0, 5)).toBe("unknown")
  })
})

describe("loops: settling as the activity does", () => {
  it("closes the root's requests at a turn start, end, idle or Escape", () => {
    for (const settle of [
      act({ type: "turn-started", cause: "harness" }),
      turnEnded(),
      act({ type: "turn-idle", background: { agents: 0, tasks: 0 } }),
      act({ type: "turn-escaped" }),
    ]) {
      const loops = known()
      loops.observe(T, [requested("r")], 100)
      loops.observe(T, [settle], 200)
      expect(loops.worked(T, 100, 200)).toBe(true)
      // Nothing running through, so a denial leaves no request open.
      loops.observe(T, [turnEnded()], 220)
      expect(loops.worked(T, 250, 400)).toBe(false)
    }
  })

  it("keeps a running subagent's request past a turn's end", () => {
    const loops = known()
    loops.observe(T, [subStarted("a"), requested("r", "a"), turnEnded()], 100)
    expect(loops.worked(T, 300, 400)).toBe(true)
  })

  it("closes a subagent's requests when it stops, and those of one not running at a turn end", () => {
    const loops = known()
    loops.observe(T, [subStarted("a"), requested("r", "a")], 100)
    loops.observe(T, [act({ type: "subagent-stopped", actor: "a" })], 200)
    expect(loops.worked(T, 200, 300)).toBe(false)
  })

  it("takes a subagent that asks unseen as running, until it stops", () => {
    const loops = known()
    loops.observe(T, [requested("r", "a")], 100)
    loops.observe(T, [resolved("r")], 110)
    expect(loops.worked(T, 200, 300)).toBe(true)
    loops.observe(T, [act({ type: "subagent-stopped", actor: "a" })], 400)
    expect(loops.worked(T, 400, 500)).toBe(false)
  })

  it("drops the subagents an interrupted turn started, and keeps earlier ones", () => {
    const loops = known()
    loops.observe(T, [subStarted("old")], 5)
    loops.observe(T, [turnStarted(), subStarted("new")], 100)
    loops.observe(T, [act({ type: "turn-ended", outcome: "interrupted" })], 200)
    expect(loops.worked(T, 150, 200)).toBe(true)
    expect(loops.worked(T, 200, 300)).toBe(true)
    loops.observe(T, [act({ type: "subagent-stopped", actor: "old" })], 250)
    expect(loops.worked(T, 250, 300)).toBe(false)
  })

  it("lets a completed turn's end leave its subagents running", () => {
    const loops = known()
    loops.observe(T, [turnStarted(), subStarted("a"), turnEnded()], 100)
    expect(loops.worked(T, 200, 300)).toBe(true)
  })

  it("ends a turn at an Escape or an idle status line", () => {
    for (const stop of [
      act({ type: "turn-escaped" }),
      act({ type: "turn-idle", background: { agents: 0, tasks: 0 } }),
    ]) {
      const loops = known()
      loops.observe(T, [turnStarted()], 10)
      loops.observe(T, [stop], 100)
      expect(loops.worked(T, 50, 150)).toBe(false)
      expect(loops.worked(T, 100, 200)).toBe(false)
    }
  })
})

describe("loops: a status line's subagent count", () => {
  it("counts from a count above zero until a later zero", () => {
    const loops = known()
    loops.observe(T, [act({ type: "turn-working", running: 2 })], 100)
    loops.observe(T, [act({ type: "turn-working", running: 1 })], 150)
    expect(loops.worked(T, 200, 300)).toBe(true)
    loops.observe(T, [act({ type: "turn-working", running: 0 })], 400)
    expect(loops.worked(T, 350, 450)).toBe(true)
    expect(loops.worked(T, 400, 500)).toBe(false)
  })

  it("reads the agents a turn's end or idle leaves", () => {
    const loops = known()
    loops.observe(T, [turnEnded({ agents: 1, tasks: 0 })], 100)
    expect(loops.worked(T, 200, 300)).toBe(true)
    loops.observe(T, [act({ type: "turn-idle", background: { agents: 0, tasks: 0 } })], 400)
    expect(loops.worked(T, 400, 500)).toBe(false)
  })

  it("ignores a turn-working that counts none", () => {
    const loops = known()
    loops.observe(T, [act({ type: "turn-working" })], 100)
    expect(loops.worked(T, 100, 200)).toBe(false)
  })
})

describe("loops: the cap and open spans", () => {
  it("never drops a span still open", () => {
    const loops = known()
    loops.observe(T, [subStarted("keep")], 1)
    for (let i = 0; i < keepEntries + 10; i++) {
      loops.observe(
        T,
        [subStarted(`s${i}`), act({ type: "subagent-stopped", actor: `s${i}` })],
        2 + i,
      )
    }
    expect(loops.worked(T, 1_000_000, 1_000_001)).toBe(true)
  })
})

describe("loops: stale and spurious turn-over signals", () => {
  it("ignores an idle or Escape older than the turn's start", () => {
    for (const stale of [
      act({ type: "turn-idle", background: { agents: 0, tasks: 0 } }, 40),
      act({ type: "turn-escaped" }, 40),
    ]) {
      const loops = known()
      loops.observe(T, [act({ type: "turn-started", cause: "harness" }, 50)], 60)
      loops.observe(T, [stale], 70)
      expect(loops.worked(T, 80, 500)).toBe(true)
    }
  })

  it("takes a root call or a working status after an Escape or idle as the turn running on", () => {
    for (const sign of [call("work"), act({ type: "turn-working" })]) {
      const loops = known()
      loops.observe(T, [turnStarted()], 10)
      loops.observe(T, [act({ type: "turn-escaped" })], 100)
      expect(loops.worked(T, 120, 500)).toBe(false)
      loops.observe(T, [sign], 150)
      expect(loops.worked(T, 160, 900)).toBe(true)
    }
  })

  it("does not restart a turn for a subagent's call", () => {
    const loops = known()
    loops.observe(T, [turnStarted()], 10)
    loops.observe(T, [turnEnded()], 100)
    loops.observe(T, [call("bookkeeping", { actor: "sub" })], 150)
    expect(loops.worked(T, 160, 900)).toBe(false)
  })

  it("takes no subagent count from a turn end that says more", () => {
    const loops = known()
    loops.observe(T, [act({ type: "turn-working", running: 1 })], 100)
    loops.observe(T, [turnEnded({ agents: 0, tasks: 0, more: true })], 200)
    expect(loops.worked(T, 300, 400)).toBe(true)
  })
})

describe("loops: a lapsed continuation", () => {
  it("ends the turn and settles the root's requests", () => {
    const loops = known()
    loops.observe(T, [turnStarted(), requested("r")], 10)
    loops.observe(T, [act({ type: "turn-continued" })], 100)
    expect(loops.worked(T, 100, 200)).toBe(true)
    loops.observe(T, [act({ type: "turn-lapsed" })], 200)
    expect(loops.worked(T, 250, 400)).toBe(false)
  })
})

describe("loops: what may restart a stopped turn", () => {
  it("is not a working status after a real Stop", () => {
    const loops = known()
    loops.observe(T, [act({ type: "turn-started", cause: "harness" }, 1)], 1)
    loops.observe(T, [act({ type: "turn-ended", outcome: "completed" }, 3)], 3)
    loops.observe(T, [act({ type: "turn-working" }, 4)], 4)
    expect(loops.worked(T, 10, 900)).toBe(false)
  })

  it("is not a late call report older than the stop", () => {
    const loops = known()
    loops.observe(T, [act({ type: "turn-started", cause: "harness" }, 1)], 1)
    loops.observe(T, [act({ type: "turn-ended", outcome: "completed" }, 3)], 3)
    loops.observe(T, [call("bookkeeping", {}, 2)], 5)
    expect(loops.worked(T, 10, 900)).toBe(false)
  })

  it("is a call newer than the stop, even after a real Stop", () => {
    const loops = known()
    loops.observe(T, [act({ type: "turn-started", cause: "harness" }, 1)], 1)
    loops.observe(T, [act({ type: "turn-ended", outcome: "completed" }, 3)], 3)
    loops.observe(T, [call("bookkeeping", {}, 4)], 5)
    expect(loops.worked(T, 10, 900)).toBe(true)
  })
})
