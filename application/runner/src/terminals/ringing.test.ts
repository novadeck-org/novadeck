import { setTimeout as sleep } from "node:timers/promises"

import { screen } from "@novadeck/harness-core/testing/screens"
import { createTypist } from "@novadeck/tui-input"

import type { Binding } from "../harnesses/bindings.js"
import { harnesses } from "../harnesses/registry.js"
import type { Messaging } from "../messaging/messaging.js"
import { describe, expect, it } from "../test.js"
import { doorbellHost, profileOf, typingTarget, type RingRecord } from "./ringing.js"

const bound = (agent: "claude" | "codex", instance?: string) =>
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
  const host = {
    live: (id: string) => (id === "t" ? state.current : undefined),
    screen: () => Promise.resolve(screen({ rows: ["> "] })),
    shownAgent: () => state.shown,
    alive: () => true,
    exited: (_: string, __: RingRecord, binding: Binding) => void exits.push(binding),
    messaging: { shownAgent: () => state.shown } as unknown as Messaging,
    working: () => false,
    stopping: () => false,
  }
  return { state, exits, host }
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

  it("says false, and ends the binding, when the bound agent left unseen", async () => {
    const binding = bound("claude", "999999999")
    const { running } = record(binding)
    const { host, exits } = world(running)
    const target = typingTarget("t", { ...host, alive: () => false })
    expect(await target.holdsForeground()).toBe(false)
    expect(exits).toEqual([binding])
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
