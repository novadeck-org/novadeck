import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import type { InboxBadge } from "./inbox-badge"
import { SidebarRail } from "./SidebarRail"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const waiting: InboxBadge = { count: 1, label: "Inbox, 1 waiting" }

const rail = (badge: InboxBadge | undefined, bellRings: number) =>
  createElement(SidebarRail, {
    sidebarVisible: false,
    sidebarPanel: "terminals",
    zen: false,
    badge,
    bellRings,
    toggleSidebar: () => {},
    hideSidebar: () => {},
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
