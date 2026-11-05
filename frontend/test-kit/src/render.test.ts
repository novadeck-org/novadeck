import { createElement, useEffect } from "react"
import { afterAll, expect, it, vi } from "vitest"

import { nextFrame, render } from "./render"

// Counted by hand: the config's restoreMocks clears a mock's calls between tests.
let unmounted = 0
const Probe = () => {
  useEffect(
    () => () => {
      unmounted += 1
    },
    [],
  )
  return createElement("p", { "data-probe": "" }, "drawn")
}

// The tests run in order: each finds what the one before left.
it("renders into the page", () => {
  const { container } = render(createElement(Probe))
  expect(container.isConnected).toBe(true)
  expect(document.querySelectorAll("[data-probe]")).toHaveLength(1)
})

it("unmounts what a test rendered once it finishes", () => {
  expect(unmounted).toBe(1)
  expect(document.body.children).toHaveLength(0)
})

it("unmounts once, however often asked", () => {
  unmounted = 0
  const { unmount } = render(createElement(Probe))
  unmount()
  unmount()
  expect(unmounted).toBe(1)
  expect(document.body.children).toHaveLength(0)
})

it("lets a frame run", async () => {
  let ran = false
  requestAnimationFrame(() => {
    ran = true
  })
  await nextFrame()
  expect(ran).toBe(true)
})

it("lets a frame run while only timeouts are faked", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  try {
    await expect(nextFrame()).resolves.toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})

it("says why it cannot wait where frames are faked", () => {
  vi.useFakeTimers()
  try {
    expect(() => nextFrame()).toThrow(/requestAnimationFrame is faked/)
  } finally {
    vi.useRealTimers()
  }
})

afterAll(() => {
  if (document.body.children.length) throw new Error("A test left its render in the page")
})
