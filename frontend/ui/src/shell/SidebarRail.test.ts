import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import type { InboxBadge } from "./inbox-badge"
import { railTooltip, SidebarRail } from "./SidebarRail"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const waiting: InboxBadge = { count: 1, label: "Inbox, 1 waiting" }

const rail = (badge: InboxBadge | undefined, bellRings: number, sessionsAsk?: string) =>
  createElement(SidebarRail, {
    sidebarVisible: false,
    sidebarPanel: "terminals",
    zen: false,
    badge,
    bellRings,
    sessionsAsk,
    toggleSidebar: () => {},
  })

describe("the rail's Inbox dot", () => {
  it("rings for a new item, and not again when the Inbox empties and the dot comes back", () => {
    const { container, rerender, unmount } = render(rail(undefined, 0))
    unmounts.push(unmount)
    const dot = () => container.querySelector("#inbox-toggle .bell-dot")
    const ring = () => container.querySelector("#inbox-toggle .bell-dot-ring")
    expect(dot()).toBeNull()
    rerender(rail(waiting, 0))
    expect(dot()).not.toBeNull()
    expect(ring()).toBeNull()
    rerender(rail(waiting, 1))
    expect(ring()).not.toBeNull()
    rerender(rail(undefined, 1))
    expect(dot()).toBeNull()
    rerender(rail(waiting, 1))
    expect(dot()).not.toBeNull()
    expect(ring()).toBeNull()
  })
})

describe("the rail's Sessions dot", () => {
  it("shows while another session asks, says so in the toggle's description, and never rings", () => {
    const { container, rerender, unmount } = render(rail(undefined, 0))
    unmounts.push(unmount)
    const toggle = () => container.querySelector("#sessions-toggle")!
    expect(toggle().querySelector(".bell-dot")).toBeNull()
    expect(toggle().getAttribute("aria-label")).toBe("Sessions")
    rerender(rail(undefined, 0, "1 needs you"))
    expect(toggle().querySelector(".bell-dot")).not.toBeNull()
    expect(toggle().getAttribute("aria-label")).toBe("Sessions")
    expect(toggle().getAttribute("aria-description")).toBe("1 needs you")
    rerender(rail(undefined, 0, "3 need you · 1 question"))
    expect(toggle().getAttribute("aria-description")).toBe("3 need you · 1 question")
    rerender(rail(undefined, 5, "1 needs you"))
    expect(toggle().querySelector(".bell-dot-ring")).toBeNull()
  })
})

describe("the rail's tooltips", () => {
  it("say where a click on the open panel's toggle takes the sidebar, and each panel's key", () => {
    const keys = (letter: string) =>
      (navigator.platform.includes("Mac")
        ? ["⌘", "Shift", letter]
        : ["Ctrl", "Shift", letter]
      ).join("\u00a0")
    expect(railTooltip({ panel: "sessions", open: false, back: "terminals" })).toBe(
      `Sessions · ${keys("S")}`,
    )
    expect(railTooltip({ panel: "sessions", open: true, back: "terminals" })).toBe(
      `Sessions · back to Terminals · ${keys("S")}`,
    )
    expect(railTooltip({ panel: "inbox", detail: "2 waiting", open: true, back: "inbox" })).toBe(
      `Inbox · 2 waiting · hide sidebar · ${keys("B")}`,
    )
    expect(railTooltip({ panel: "history", open: true, back: null })).toBe("History · hide sidebar")
  })
})
