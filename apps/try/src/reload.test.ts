import { describe as context, describe, expect, it } from "vitest"

import {
  reloadGapMs,
  reloadKey,
  reloadOnStaleDeploy,
  reloadsNow,
  type ReloadStorage,
} from "./reload"

const storage = (kept?: string): ReloadStorage & { readonly kept: Map<string, string> } => {
  const map = new Map<string, string>(kept === undefined ? [] : [[reloadKey, kept]])
  return {
    kept: map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  }
}

// A page whose part fails to load, at the times given, and what it does each time.
const failures = (at: readonly number[], kept = storage()) => {
  const page = new EventTarget()
  const reloads: number[] = []
  let now = 0
  reloadOnStaleDeploy(
    page,
    () => kept,
    () => reloads.push(now),
    () => now,
  )
  const prevented = at.map((time) => {
    now = time
    const event = new Event("vite:preloadError", { cancelable: true })
    page.dispatchEvent(event)
    return event.defaultPrevented
  })
  return { reloads, prevented }
}

describe("reloading a page that outlived a deploy", () => {
  it("reloads on the first part that fails to load, and holds the error back", () => {
    expect(failures([1_000])).toEqual({ reloads: [1_000], prevented: [true] })
  })

  it("doesn't reload again when the reloaded page fails at once, and lets that error through", () => {
    expect(failures([1_000, 3_000])).toEqual({ reloads: [1_000], prevented: [true, false] })
  })

  it("reloads again for a later deploy, however long the tab has been open", () => {
    const later = 1_000 + reloadGapMs
    expect(failures([1_000, later, later + 5 * 86_400_000]).reloads).toEqual([
      1_000,
      later,
      later + 5 * 86_400_000,
    ])
  })

  context("with what a session kept before", () => {
    it("reads an earlier build's mark as long ago", () => {
      expect(reloadsNow(storage("1"), 10 * reloadGapMs)).toBe(true)
    })

    it("reads a mark it can't make sense of as long ago, and replaces it", () => {
      const kept = storage("soon")
      expect(reloadsNow(kept, 5_000)).toBe(true)
      expect(kept.kept.get(reloadKey)).toBe("5000")
    })

    it("isn't held by a time ahead of now, as a clock that went back leaves", () => {
      expect(reloadsNow(storage(String(10 * reloadGapMs)), reloadGapMs)).toBe(true)
    })
  })

  it("never reloads where the session's storage can't be reached", () => {
    const page = new EventTarget()
    let reloads = 0
    reloadOnStaleDeploy(
      page,
      () => {
        throw new DOMException("blocked", "SecurityError")
      },
      () => void (reloads += 1),
    )
    const event = new Event("vite:preloadError", { cancelable: true })
    page.dispatchEvent(event)
    expect({ reloads, prevented: event.defaultPrevented }).toEqual({ reloads: 0, prevented: false })
  })
})
