import type { IpcMainEvent } from "electron"

import { badgeChannel } from "../../bridge.js"
import { context, describe, expect, it } from "../../test"
import { applyBadge, dockBadgeText, registerBadgeIpc, type BadgeTarget } from "./badge"

const png = "data:image/png;base64,iVBORw0KGgo="

const registered = (own: boolean) => {
  const listeners = new Map<string, (event: IpcMainEvent, value: unknown) => void>()
  const applied: [string, unknown][] = []
  registerBadgeIpc(
    { on: (channel, listener) => void listeners.set(channel, listener) },
    {
      window: () => (own ? "window" : undefined),
      apply: (window, badge) => void applied.push([window, badge]),
    },
  )
  const send = (value: unknown): void => listeners.get(badgeChannel)?.({} as IpcMainEvent, value)
  return { send, applied }
}

describe("taking the page's badge", () => {
  it("applies a valid badge for the window it came from, and only its two fields", () => {
    const { send, applied } = registered(true)
    send({ count: 3, image: png, extra: 1 })
    expect(applied).toEqual([["window", { count: 3, image: png }]])
  })

  it("drops an invalid badge", () => {
    const { send, applied } = registered(true)
    for (const value of [
      undefined,
      "3",
      { count: -1, image: null },
      { count: 1000, image: null },
      { count: 2.5, image: null },
      { count: 1, image: "file:///etc/passwd" },
      { count: 1, image: `data:image/png;base64,${"A".repeat(16384)}` },
    ])
      send(value)
    expect(applied).toEqual([])
  })

  it("drops a badge from any other sender", () => {
    const { send, applied } = registered(false)
    send({ count: 3, image: null })
    expect(applied).toEqual([])
  })
})

describe("the dock's badge text", () => {
  it("is the count, capped, and empty at 0", () => {
    expect(dockBadgeText(0)).toBe("")
    expect(dockBadgeText(7)).toBe("7")
    expect(dockBadgeText(99)).toBe("99")
    expect(dockBadgeText(100)).toBe("99+")
  })
})

const target = (platform: NodeJS.Platform, { dock = true, destroyed = false } = {}) => {
  const calls: unknown[][] = []
  const value: BadgeTarget = {
    platform,
    app: {
      setBadgeCount: (count) => void calls.push(["count", count]),
      ...(dock ? { dock: { setBadge: (text: string) => void calls.push(["dock", text]) } } : {}),
    },
    nativeImage: { createFromDataURL: (url) => ({ icon: url }) },
    window: {
      isDestroyed: () => destroyed,
      setOverlayIcon: (image, description) => void calls.push(["overlay", image, description]),
    },
  }
  return { value, calls }
}

describe("applying a badge", () => {
  context("on macOS", () => {
    it("sets the dock's text and clears it at 0", () => {
      const { value, calls } = target("darwin")
      applyBadge(value, { count: 120, image: png })
      applyBadge(value, { count: 0, image: null })
      expect(calls).toEqual([
        ["dock", "99+"],
        ["dock", ""],
      ])
    })

    it("does nothing without a dock", () => {
      const { value, calls } = target("darwin", { dock: false })
      applyBadge(value, { count: 2, image: null })
      expect(calls).toEqual([])
    })
  })

  context("on Linux", () => {
    it("sets the launcher's count and clears it at 0", () => {
      const { value, calls } = target("linux")
      applyBadge(value, { count: 3, image: png })
      applyBadge(value, { count: 0, image: null })
      expect(calls).toEqual([
        ["count", 3],
        ["count", 0],
      ])
    })
  })

  context("on Windows", () => {
    it("sets the taskbar overlay from the image, described", () => {
      const { value, calls } = target("win32")
      applyBadge(value, { count: 3, image: png })
      expect(calls).toEqual([["overlay", { icon: png }, "3 waiting in the Inbox"]])
    })

    it("clears the overlay at 0 or without an image", () => {
      const { value, calls } = target("win32")
      applyBadge(value, { count: 0, image: png })
      applyBadge(value, { count: 4, image: null })
      expect(calls).toEqual([
        ["overlay", null, ""],
        ["overlay", null, ""],
      ])
    })

    it("leaves a destroyed window alone", () => {
      const { value, calls } = target("win32", { destroyed: true })
      applyBadge(value, { count: 3, image: png })
      expect(calls).toEqual([])
    })
  })
})
