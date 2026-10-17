import { afterEach, describe, expect, it } from "vitest"

import { createHold } from "./hold.js"

const roots: HTMLElement[] = []
afterEach(() => {
  for (const root of roots.splice(0)) root.remove()
})

// A scroller holding something whose size comes later, as an image that loads.
const scroller = (): { root: HTMLElement; inner: HTMLElement } => {
  const root = document.createElement("div")
  root.style.cssText = "height: 200px; width: 200px; overflow: auto"
  const inner = document.createElement("div")
  inner.style.height = "0"
  root.append(inner)
  document.body.append(root)
  roots.push(root)
  return { root, inner }
}

describe("holding a place", () => {
  it("sets it again as what it watches gets its size, however late, once that's ready", async () => {
    const { root, inner } = scroller()
    let ready = false
    const { hold } = createHold(
      root,
      () => [inner],
      () => ready,
    )
    hold(() => {
      root.scrollTop = 500
    })
    expect(root.scrollTop).toBe(0)
    // Longer than the moment it holds for once ready.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    ready = true
    inner.style.height = "2000px"
    await expect.poll(() => root.scrollTop).toBe(500)
  })

  it("lets go a moment after it's ready and has a size", async () => {
    const { root, inner } = scroller()
    inner.style.height = "2000px"
    const { hold } = createHold(root, () => [inner])
    let placed = 0
    hold(() => {
      placed += 1
      root.scrollTop = 500
    })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const before = placed
    root.style.height = "300px"
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(placed).toBe(before)
  })

  it("sets it again when asked, as for something ready without a change of size", async () => {
    const { root, inner } = scroller()
    let ready = false
    const { hold, refresh } = createHold(
      root,
      () => [inner],
      () => ready,
    )
    let placed = 0
    hold(() => {
      placed += 1
      root.scrollTop = 500
    })
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const before = placed
    ready = true
    refresh()
    expect(placed).toBe(before + 1)
  })

  it("stops when released", async () => {
    const { root, inner } = scroller()
    const { hold, release } = createHold(root, () => [inner])
    hold(() => {
      root.scrollTop = 500
    })
    release()
    inner.style.height = "2000px"
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(root.scrollTop).toBe(0)
  })
})
