import { readFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"
import { screen } from "@novadeck/harness-core/testing/screens"
import type { AgentName } from "@novadeck/protocol"
import { createTypist } from "@novadeck/tui-input"

import type { Binding } from "../harnesses/bindings.js"
import { harnesses } from "../harnesses/registry.js"
import type { Messaging } from "../messaging/messaging.js"
import { describe, expect, it } from "../test.js"
import { doorbellHost, profileOf, typingTarget, type RingRecord } from "./ringing.js"

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
