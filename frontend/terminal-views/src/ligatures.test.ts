import { afterEach, describe, expect, it, vi } from "vitest"

import { ligaturesOn, watchLigatures } from "./ligatures"

const root = document.documentElement
afterEach(() => root.removeAttribute("data-ligatures"))

// A mutation observer tells in a microtask.
const settled = (): Promise<void> => new Promise((done) => setTimeout(done))

describe("the ligatures setting on the page's root", () => {
  it("reads on only from data-ligatures=on", () => {
    expect(ligaturesOn()).toBe(false)
    root.dataset.ligatures = "off"
    expect(ligaturesOn()).toBe(false)
    root.dataset.ligatures = "on"
    expect(ligaturesOn()).toBe(true)
  })

  it("tells each watcher when it changes, until that one stops", async () => {
    const first = vi.fn<() => void>()
    const second = vi.fn<() => void>()
    const stopFirst = watchLigatures(first)
    watchLigatures(second)
    root.dataset.ligatures = "on"
    await settled()
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1])
    stopFirst()
    root.dataset.ligatures = "off"
    await settled()
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 2])
  })

  it("ignores other attributes", async () => {
    const changed = vi.fn<() => void>()
    const stop = watchLigatures(changed)
    root.dataset.scheme = "dark"
    await settled()
    stop()
    root.removeAttribute("data-scheme")
    expect(changed).not.toHaveBeenCalled()
  })
})
