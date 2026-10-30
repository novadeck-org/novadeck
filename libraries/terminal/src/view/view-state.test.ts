import { describe, expect, it } from "vitest"

import {
  createStore,
  lockOf,
  nextViewState,
  openingState,
  type ViewFacts,
  type ViewLink,
  type ViewPhase,
} from "./view-state.js"

const facts = (link: ViewLink, phase: ViewPhase): ViewFacts => ({ link, phase })
const stream = (live = false, resuming = false, waits = false) => ({ live, resuming, waits })

describe("why a terminal refuses input", () => {
  it("is offline while the host is unreachable, whatever the shell does", () => {
    for (const phase of ["starting", "running", "ended"] as const)
      expect(lockOf(facts("unavailable", phase), stream(true))).toBe("offline")
  })

  it("is reconnecting while the link is coming back, even for an ended shell", () => {
    for (const phase of ["starting", "running", "ended"] as const)
      expect(lockOf(facts("reconnecting", phase), stream(true))).toBe("reconnecting")
  })

  it("takes input once a stream draws the shell, or the shell waits for Enter", () => {
    expect(lockOf(facts("connected", "running"), stream(true))).toBeNull()
    expect(lockOf(facts("connected", "ended"), stream())).toBeNull()
    expect(lockOf(facts("connected", "running"), stream(false, false, true))).toBeNull()
  })

  it("names what a connected shell without a stream waits for", () => {
    expect(lockOf(facts("connected", "starting"), stream())).toBe("starting")
    expect(lockOf(facts("connected", "running"), stream())).toBe("loading")
    expect(lockOf(facts("connected", "running"), stream(false, true))).toBe("reconnecting")
    expect(lockOf(facts("connected", "starting"), stream(false, true))).toBe("reconnecting")
  })
})

describe("a terminal's view state", () => {
  const connected = facts("connected", "running")

  it("opens locked, in the words its stage calls for, with no notice", () => {
    expect(openingState(facts("connected", "starting"))).toEqual({
      ...stream(),
      lock: "starting",
      notice: null,
    })
    expect(openingState(facts("connected", "ended")).lock).toBeNull()
  })

  it("recomputes the lock in the change that brings it", () => {
    const opening = openingState(connected)
    const live = nextViewState(opening, { live: true }, connected)
    expect(live).toEqual({ ...stream(true), lock: null, notice: null })
    expect(nextViewState(live, { live: false, resuming: true }, connected).lock).toBe(
      "reconnecting",
    )
  })

  it("is the same state when nothing changes, so nothing is notified", () => {
    const opening = openingState(connected)
    expect(nextViewState(opening, {}, connected)).toBe(opening)
    expect(nextViewState(opening, { live: false, notice: null }, connected)).toBe(opening)
    const noticed = nextViewState(opening, { notice: "No" }, connected)
    expect(noticed).not.toBe(opening)
    expect(nextViewState(noticed, { notice: "No" }, connected)).toBe(noticed)
  })

  it("follows the facts it is given, as when the stage or the link changes", () => {
    const opening = openingState(connected)
    expect(nextViewState(opening, {}, facts("connected", "ended")).lock).toBeNull()
    expect(nextViewState(opening, {}, facts("unavailable", "running")).lock).toBe("offline")
  })
})

describe("the screens' own store", () => {
  it("notifies its listeners of a change, in the order they subscribed", () => {
    const store = createStore({ count: 0 })
    const heard: string[] = []
    store.subscribe(() => heard.push(`a${store.getSnapshot().count}`))
    store.subscribe(() => heard.push(`b${store.getSnapshot().count}`))
    expect(store.update((state) => ({ count: state.count + 1 }))).toEqual({ count: 1 })
    expect(heard).toEqual(["a1", "b1"])
  })

  it("notifies nobody of a change that returns the same value", () => {
    const store = createStore({ count: 0 })
    const initial = store.getSnapshot()
    let heard = 0
    store.subscribe(() => heard++)
    expect(store.update((state) => state)).toBe(initial)
    expect(heard).toBe(0)
  })

  it("stops notifying a listener once it unsubscribes", () => {
    const store = createStore(0)
    let heard = 0
    const stop = store.subscribe(() => heard++)
    store.update((count) => count + 1)
    stop()
    store.update((count) => count + 1)
    expect(heard).toBe(1)
    expect(store.getSnapshot()).toBe(2)
  })
})
