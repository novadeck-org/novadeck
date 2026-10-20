import { readFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"
import type { Background, HarnessEvent } from "@novadeck/harness-core/events"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { screen } from "@novadeck/harness-core/testing/screens"
import type { AgentName } from "@novadeck/protocol"
import { createTypist } from "@novadeck/tui-input"

import { started as startedActivity, type Activity } from "../harnesses/activity.js"
import type { Binding } from "../harnesses/bindings.js"
import { harnesses } from "../harnesses/registry.js"
import { followRoot, type Root } from "../harnesses/roots.js"
import { Messaging } from "../messaging/messaging.js"
import { memoryMailbox } from "../messaging/records.js"
import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import { agentWorking, doorbellHost, profileOf, typingTarget, type RingRecord } from "./ringing.js"

const bound = (agent: AgentName, instance?: string) =>
  ({ agent, ...(instance && { instance }) }) as unknown as Binding

/** A running terminal as the manager keeps it, as far as the doorbell reads it. */
const record = (binding: Binding | null = null) => {
  const written: string[] = []
  const terminal = {
    type: (data: string) => void written.push(data),
    resizedAt: 42,
    pty: { pid: 1 },
  }
  const running: RingRecord = {
    terminal: terminal as unknown as RingRecord["terminal"],
    binding,
    activity: null,
  }
  return { running, written, terminal }
}

/** A manager's view of one terminal "t": live while `current` is set. */
const world = (initial: RingRecord | undefined) => {
  const state = { current: initial, shown: undefined as "claude" | "codex" | undefined }
  const exits: Binding[] = []
  const tasks: (() => void)[] = []
  const host = {
    live: (id: string) => (id === "t" ? state.current : undefined),
    screen: () => Promise.resolve(screen({ rows: ["> "] })),
    shownAgent: () => state.shown,
    alive: () => true,
    queued: (_: string, work: () => void) => void tasks.push(work),
    endExited: (found: RingRecord) => void exits.push(found.binding!),
    messaging: { shownAgent: () => state.shown } as unknown as Messaging,
    working: () => false,
    stopping: () => false,
  }
  return { state, exits, tasks, host }
}

describe("a terminal's typing target", () => {
  it("types into the terminal while it runs, and says false once it is gone", () => {
    const { running, written } = record()
    const { state, host } = world(running)
    const target = typingTarget("t", host)
    expect(target.type("a")).toBe(true)
    expect(written).toEqual(["a"])
    state.current = undefined
    expect(target.type("b")).toBe(false)
    expect(written).toEqual(["a"])
  })

  it("reads its resize time while it runs, and 0 once it is gone", () => {
    const { running } = record()
    const { state, host } = world(running)
    const target = typingTarget("t", host)
    expect(target.resizedAt).toBe(42)
    state.current = undefined
    expect(target.resizedAt).toBe(0)
  })

  it("reads its screen through the manager's guarded read", async () => {
    const { running } = record()
    const { host } = world(running)
    expect((await typingTarget("t", host).screen())?.rows).toEqual(["> "])
  })

  it("can't tell the foreground of a gone terminal, or of one with no agent", async () => {
    const { running } = record()
    const { state, host } = world(running)
    const target = typingTarget("t", host)
    expect(await target.holdsForeground()).toBeUndefined()
    state.current = undefined
    expect(await target.holdsForeground()).toBeUndefined()
  })

  it("says false, and calls nothing, when the bound agent left unseen", async () => {
    const binding = bound("claude", "999999999")
    const { running } = record(binding)
    const { host, exits } = world(running)
    const target = typingTarget("t", { ...host, alive: () => false })
    expect(await target.holdsForeground()).toBe(false)
    expect(exits).toEqual([])
  })
})

describe("the doorbell's host", () => {
  it("has a target only while the terminal runs", () => {
    const { running } = record()
    const { state, host } = world(running)
    const rings = doorbellHost(host)
    expect(rings.target("t")).toBeDefined()
    expect(rings.target("other")).toBeUndefined()
    state.current = undefined
    expect(rings.target("t")).toBeUndefined()
  })

  describe("on an agent found gone", () => {
    const gone = (binding: Binding | null, alive = false) => {
      const { running } = record(binding)
      const w = world(running)
      const rings = doorbellHost({ ...w.host, alive: () => alive })
      /** Asks, then runs what was queued. */
      const ask = () => {
        rings.agentGone?.("t")
        const queued = w.tasks.length
        for (const task of w.tasks.splice(0)) task()
        return queued
      }
      return { ...w, rings, running, ask }
    }

    it("only queues the end of a bound dead instance's binding, without running it", () => {
      const { rings, tasks, exits } = gone(bound("claude", "999999999"))
      rings.agentGone?.("t")
      expect(tasks).toHaveLength(1)
      expect(exits).toEqual([])
    })

    it("ends it when the queue gets to it", () => {
      const binding = bound("claude", "999999999")
      const w = gone(binding)
      expect(w.ask()).toBe(1)
      expect(w.exits).toEqual([binding])
    })

    it("queues nothing for a live instance, no instance, a prompt only shown, or a gone terminal", () => {
      const live = gone(bound("claude", "999999999"), true)
      const none = gone(bound("claude"))
      const shown = gone(null)
      shown.state.shown = "claude"
      const away = gone(bound("claude", "999999999"))
      away.state.current = undefined
      expect([live.ask(), none.ask(), shown.ask(), away.ask()]).toEqual([0, 0, 0, 0])
      expect([live.exits, none.exits, shown.exits, away.exits]).toEqual([[], [], [], []])
    })

    it("leaves a binding replaced before the queue got to it", () => {
      const w = gone(bound("claude", "999999999"))
      w.rings.agentGone?.("t")
      ;(w.running as { binding: Binding | null }).binding = bound("codex", "888888888")
      for (const task of w.tasks.splice(0)) task()
      expect(w.exits).toEqual([])
    })
  })

  it("answers the profile of the agent bound or shown now, as they change", () => {
    const { running } = record()
    const { state, host } = world(running)
    const rings = doorbellHost(host)
    // None bound, none shown.
    expect(rings.profile("t")).toBeUndefined()
    // A prompt shown before any session binds.
    state.shown = "codex"
    expect(rings.profile("t")).toBe(harnesses.codex.box)
    // A session binds: its agent's, whatever is shown.
    state.current = { ...running, binding: bound("claude") }
    expect(rings.profile("t")).toBe(harnesses.claude.box)
    // It unbinds: back to what is shown, then to none.
    state.current = { ...running, binding: null }
    expect(rings.profile("t")).toBe(harnesses.codex.box)
    state.shown = undefined
    expect(rings.profile("t")).toBeUndefined()
    // A gone terminal has none.
    state.shown = "codex"
    state.current = undefined
    expect(rings.profile("t")).toBeUndefined()
  })

  it("asks the profile the typist reads through at each call", () => {
    expect(profileOf(null, () => undefined)).toBeUndefined()
    expect(profileOf(bound("codex"), () => "claude")).toBe(harnesses.codex.box)
  })

  it("leaves a typist reading through it with no box to find where there is no profile", async () => {
    const { running } = record()
    const { state, host } = world(running)
    const rings = doorbellHost(host)
    const typist = createTypist(rings.target("t")!, {
      profile: () => rings.profile("t"),
      timing: { calmMs: 5, pollMs: 1 },
    })
    await typist.look()
    await sleep(20)
    const look = (await typist.look())!
    expect(await typist.ready(look)).toBe("no-input-box")
    state.shown = "claude"
    expect(rings.profile("t")).toBe(harnesses.claude.box)
  })
})

// Each harness's screen after the doorbell's line was pasted into its box, as probed in a
// PTY (the paste check's fixtures in @novadeck/tui-input): `a` Claude Code 2.1.286, `b`
// Codex 0.159.3, `c` Antigravity 1.2.14. A recording keeps the rows' text only; the cursor
// is put at the end of the line, where the paste left it.
type Recorded = { readonly height: number; readonly rows: { readonly [row: string]: string } }
type Pair = {
  readonly name: string
  readonly expected: "accept" | "reject" | "draft"
  readonly after: Recorded & { readonly columns: number }
}
const pasted = (recording: string): readonly Pair[] =>
  (
    JSON.parse(
      readFileSync(
        new URL(
          `../../../../libraries/tui-input/src/fixtures/paste-${recording}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { readonly pairs: readonly Pair[] }
  ).pairs

const drawn = ({ height, columns, rows }: Pair["after"]): ScreenText => {
  const all = Array.from({ length: height }, (_, row) => rows[row] ?? "")
  const last = all.findLastIndex((row) => row.includes("n7Q2"))
  const row = last === -1 ? all.findLastIndex((each) => each.trim() !== "") : last
  return screen({ rows: all, columns, cursor: { row, column: all[row]!.trimEnd().length } })
}

describe.each([
  { agent: "claude", recording: "a" },
  { agent: "codex", recording: "b" },
  { agent: "agy", recording: "c" },
] as const)("Novadeck's own line left in $agent's box", ({ agent, recording }) => {
  // The ring that pasted n7Q2 never confirmed, unless a test says it did.
  let confirmed = false
  const { host } = world(record(bound(agent, "10")).running)
  const rings = doorbellHost({
    ...host,
    messaging: {
      ...host.messaging,
      unconfirmed: (_: string, nonce: string) => nonce === "n7Q2" && !confirmed,
    } as unknown as Messaging,
  })
  const pairs = pasted(recording)
  const alone = pairs.find((pair) => pair.expected === "accept")!

  it.each(pairs.filter((pair) => pair.expected === "accept").map((pair) => [pair.name, pair]))(
    "is told by its nonce, however the ring left it: %s",
    (_, pair) => {
      const shown = drawn(pair.after)
      // The box reads as text, which held messages behind it as the person's draft.
      expect(rings.reading("t", shown)).toBe("draft")
      expect(rings.leftover("t", shown)).toBe("n7Q2")
    },
  )

  it.each(pairs.filter((pair) => pair.expected !== "accept").map((pair) => [pair.name, pair]))(
    "is not taken from a draft, a menu or a picker: %s",
    (_, pair) => {
      expect(rings.leftover("t", drawn(pair.after))).toBeUndefined()
    },
  )

  it.runIf(agent === "claude")("is left alone while a prompt queued beside it shows", () => {
    // Claude Code's hint under its box while messages are queued.
    const queued = {
      ...alone.after,
      rows: { ...alone.after.rows, 0: "Press up to edit queued messages" },
    }
    expect(rings.leftover("t", drawn(alone.after))).toBe("n7Q2")
    expect(rings.leftover("t", drawn(queued))).toBeUndefined()
  })

  it("is the person's once its ring was confirmed: put back by Escape, or recalled", () => {
    confirmed = true
    try {
      expect(rings.leftover("t", drawn(alone.after))).toBeUndefined()
    } finally {
      confirmed = false
    }
  })
})

// A session stopped at its prompt with work its turn left running (#325): a background
// agent and shell, or a subagent that runs on. Each harness's box takes a prompt then
// (fixtures/background-prompt.probe.json, from e2e/probes/background-prompt.e2e.ts), so
// the doorbell reads its screen and rings it once the box is empty, whatever its activity
// says still runs. Real messaging, the manager's `working` and the harness's box readers,
// on the screens the probe recorded; only the activity is stubbed.
describe("a session stopped with background work running", () => {
  type Screens = { readonly screens: { readonly [label: string]: ScreenText } }
  const recorded = (agent: AgentName) =>
    loadProbe<Screens>(adapterFolder(agent), "background-prompt.probe.json").screens
  const stopped = recorded("claude")["1 stopped, work running"]!
  const typed = recorded("claude")["2 a key typed"]!

  // The screen #325 reported, rebuilt: a later Claude Code, its footer naming the shell and
  // the agent, the agent's row under it, and the spinner's row above the box.
  const rule = "─".repeat(60)
  const reported = screen({
    rows: [
      "● Started the work.",
      "",
      "✻ Waiting for 1 background agent to finish",
      rule,
      "❯ ",
      rule,
      "  ⏵⏵ auto mode on · 1 shell · ← 1 agent",
      "",
      "  ● main",
      "  ◯ fixer   Checking test results in test12.log      3h 40m 8s · ↓ 708.9k tokens",
    ],
    cursor: { row: 4, column: 2 },
  })

  // What a harness's hooks say of its root's turn.
  const fact = (of: Binding) => ({
    agent: of.agent,
    sessionId: of.sessionId,
    instance: of.instance,
    startedAt: 1,
  })
  const prompted = (of: Binding): HarnessEvent => ({
    type: "turn-started",
    ...fact(of),
    cause: "prompt",
  })
  const ended = (of: Binding, background: Background): HarnessEvent => ({
    type: "turn-ended",
    ...fact(of),
    outcome: "completed",
    background,
  })

  /** Terminal "t", its agent bound, and "s", which sends it a message; the doorbell's host. */
  const setup = (agent: AgentName) => {
    const clock = { now: 1_000_000 }
    const messaging = new Messaging({
      records: memoryMailbox(),
      now: () => clock.now,
      sweepMs: 0,
      restoreMs: 0,
      platform: "linux",
    })
    const binding: Binding = { agent, sessionId: `s-${agent}`, instance: "1" }
    const sender: Binding = { agent: "codex", sessionId: "s-sender", instance: "2" }
    const roots = new Map<string, Root | null>()
    const follow = (terminalId: string, one: Binding, events: readonly HarnessEvent[] = []) => {
      const { root, changes } = followRoot(roots.get(terminalId) ?? null, one, events, {
        mode: harnesses[one.agent].messaging.root,
        statusLine: false,
        awaited: (sessionId) => messaging.awaits(terminalId, sessionId),
      })
      roots.set(terminalId, root)
      messaging.rooted(terminalId, changes)
    }
    messaging.register("t", { projectId: "p", sessionId: "w" }, "moth", null)
    messaging.register("s", { projectId: "p", sessionId: "w" }, "fox", null)
    follow("t", binding)
    follow("s", sender)
    const ask = (event: string, events: HarnessEvent[]) => {
      clock.now += 1_000
      const timed = events.map((one) => ({ ...one, startedAt: clock.now }))
      follow("t", binding, timed)
      return messaging.ask("t", { agent, event, events: timed, deadline: clock.now + 3_000 })
    }
    const { running } = record(binding)
    const terminal = { ...running, activity: null as Activity | null }
    const rings = doorbellHost({
      ...world(terminal).host,
      messaging,
      working: (terminalId, activity) => agentWorking(messaging, terminalId, { binding, activity }),
    })
    /** Its turn, then a Stop that says what it left running. */
    const turn = (background: Background) => {
      ask(agent === "agy" ? "PreInvocation" : "UserPromptSubmit", [prompted(binding)])
      ask("Stop", [ended(binding, background)])
    }
    const send = () => {
      clock.now += 1_000
      const answer = messaging.send("s", { to: "moth", text: "Any news?" })
      expect(answer).toMatchObject({ ok: true })
      return answer
    }
    /** The doorbell's read of a calm screen, from a moment ago. */
    const emptied = () => {
      clock.now += 1_000
      rings.emptied("t", clock.now - 500)
    }
    return { messaging, rings, terminal, turn, send, emptied, clock }
  }

  // What each harness's activity says runs after its Stop, as the probe saw.
  const left = (agent: AgentName, state: "idle" | "working" = "idle"): Activity => ({
    ...startedActivity(0),
    state,
    subagents: [
      { id: "a1", type: agent === "codex" ? "default" : "general-purpose", startedAt: 0 },
    ],
    background: agent === "codex" ? null : { agents: 1, tasks: agent === "claude" ? 1 : 0 },
  })

  it.each([
    { agent: "claude", said: { agents: 1, tasks: 1 } },
    { agent: "agy", said: { agents: 0, tasks: 0, more: true } },
  ] as const)(
    "rings $agent at its empty box while it waits Working on its background work",
    ({ agent, said }) => {
      const { messaging, rings, terminal, turn, send, emptied } = setup(agent)
      turn(said)
      terminal.activity = left(agent)
      expect(messaging.delivery("t")).toMatchObject({ state: "working", phase: "background" })
      expect(send()).toMatchObject({
        state: "queued",
        route: "ringing it once its box reads empty",
      })
      // Its screen is looked at, and the box it shows reads empty, not a draft.
      expect(rings.ringable("t")).toBe(false)
      expect(rings.stalled("t")).toBe(true)
      expect(rings.reading("t", recorded(agent)["1 stopped, work running"]!)).toBe("empty")
      expect(rings.reading("t", recorded(agent)["2 a key typed"]!)).toBe("draft")
      // Read empty: Ready, and rung as any Ready terminal is.
      emptied()
      expect(messaging.delivery("t")?.state).toBe("ready")
      expect(rings.ringable("t")).toBe(true)
    },
  )

  it.each(["claude", "codex"] as const)(
    "rings $0 at its empty box while Drafting, its activity still listing the work",
    (agent) => {
      const { messaging, rings, terminal, turn, send, emptied } = setup(agent)
      // As in #325: idle, but not Settled by its Stop alone (a key since), so the activity
      // is weighed, and it lists a background agent (Claude Code) or a subagent that runs
      // on with the root idle (Codex).
      turn({ agents: 0, tasks: 0 })
      messaging.keys("t", ["content"], false)
      terminal.activity = left(agent)
      expect(messaging.delivery("t")?.state).toBe("drafting")
      send()
      expect(rings.stalled("t")).toBe(true)
      const screens =
        agent === "claude" ? [stopped, reported] : [recorded(agent)["1 stopped, work running"]!]
      for (const shown of screens) expect(rings.reading("t", shown)).toBe("empty")
      emptied()
      expect(messaging.delivery("t")?.state).toBe("ready")
      expect(rings.ringable("t")).toBe(true)
    },
  )

  it("still holds one whose turn runs, saying it is working, not that its box holds text", () => {
    const { messaging, rings, terminal, turn, send } = setup("claude")
    turn({ agents: 0, tasks: 0 })
    messaging.keys("t", ["content"], false)
    terminal.activity = left("claude", "working")
    send()
    expect(rings.stalled("t")).toBe(false)
    expect(messaging.list("t", "fox").waits).toBe("working")
    expect(rings.reading("t", stopped)).toBe("working")
  })

  it("names what it saw: text in its box, a prompt queued, or its shell mode", () => {
    const { messaging, rings, terminal, turn, send } = setup("claude")
    turn({ agents: 0, tasks: 0 })
    messaging.keys("t", ["content"], false)
    terminal.activity = left("claude")
    send()
    expect(rings.reading("t", typed)).toBe("draft")
    const box = (line: string, ...under: string[]) =>
      screen({ rows: [rule, line, rule, ...under], cursor: { row: 1, column: line.length } })
    expect(rings.reading("t", box("! ls"))).toBe("shell")
    expect(
      rings.reading(
        "t",
        screen({
          rows: ["❯ Queued prompt", "", rule, "❯ ", rule, "  Press up to edit queued messages"],
          cursor: { row: 3, column: 2 },
        }),
      ),
    ).toBe("queued")
  })
})
