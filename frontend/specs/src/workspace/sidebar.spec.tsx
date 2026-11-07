import { page, userEvent, type Locator } from "vitest/browser"

import { pressShortcut } from "../support/keyboard"
import { expectStaysTrue } from "../support/layouts"
import {
  clickInto,
  commandInput,
  expectStaysAbsent,
  openWorkspace,
  press,
  reloadWorkspace,
  sidebar,
  sidebarPanel,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

const resizeHandle = (): Locator => page.getByRole("separator", { name: "Resize sidebar" })

const width = (locator: Locator): number => locator.element().getBoundingClientRect().width

describe("sidebar settings", () => {
  context("when the sidebar is hidden and the app is reloaded", () => {
    it("stays hidden", async () => {
      await openWorkspace()
      await pressShortcut("terminals")
      await expect.element(sidebar()).not.toBeInTheDocument()

      await reloadWorkspace()

      await expectStaysAbsent(sidebar())
      await pressShortcut("terminals")
      await expect.element(sidebar()).toBeVisible()
    })
  })

  context("when the open panel's toggle is pressed again", () => {
    it("goes back one step, to the panel shown before it, then hides from there", async () => {
      await openWorkspace()
      await sidebarPanel("Inbox").click()
      await expect.element(sidebar()).toHaveAccessibleName("Inbox")
      await sidebarPanel("Sessions").click()
      await expect.element(sidebar()).toHaveAccessibleName("Workspace sessions")

      await sidebarPanel("Sessions").click()

      await expect.element(sidebar()).toHaveAccessibleName("Inbox")
      await sidebarPanel("Inbox").click()
      await expect.element(sidebar()).not.toBeInTheDocument()

      // Opened on the Inbox by its key, the same key hides it again.
      await pressShortcut("inbox")
      await expect.element(sidebar()).toHaveAccessibleName("Inbox")
      await pressShortcut("inbox")
      await expect.element(sidebar()).not.toBeInTheDocument()
    })
  })

  context("when the sidebar is hidden by its key while typing in a terminal", () => {
    it("leaves typing in the terminal", async () => {
      await openWorkspace()
      await clickInto("Checkout implementation")
      await expect.element(commandInput("Checkout implementation")).toHaveFocus()

      await pressShortcut("terminals")

      await expect.element(sidebar()).not.toBeInTheDocument()
      await expect.element(commandInput("Checkout implementation")).toHaveFocus()
    })
  })

  context("when the sidebar is resized by dragging its edge", () => {
    it("follows the pointer and keeps its width after a reload", async () => {
      await openWorkspace()
      const before = width(sidebar())
      const edge = resizeHandle().element().getBoundingClientRect()
      const app = page.getByRole("main").element().getBoundingClientRect()
      const y = edge.top + edge.height / 2 - app.top
      const x = edge.left + edge.width / 2 - app.left

      await userEvent.dragAndDrop(page.getByRole("main"), page.getByRole("main"), {
        sourcePosition: { x, y },
        targetPosition: { x: x + 80, y },
      })

      await expect.poll(() => width(sidebar())).toBeGreaterThan(before + 60)
      const resized = width(sidebar())
      await expect
        .poll(() => Number(resizeHandle().element().getAttribute("aria-valuenow")))
        .toBeGreaterThan(before + 60)

      await reloadWorkspace()

      await expect.poll(() => width(sidebar())).toBeCloseTo(resized, 0)
    })
  })

  context("when a rail toggle is dragged, or moved with Alt and the arrows", () => {
    it("takes its new place, keeps the focus, and keeps its place after a reload", async () => {
      await openWorkspace()
      const toggles = page.getByRole("radiogroup", { name: "Sidebar actions" }).getByRole("radio")
      // The Inbox adds how many wait to its name, e.g. "Inbox, 3 waiting".
      const order = () =>
        toggles.elements().map((toggle) => toggle.getAttribute("aria-label")!.split(",")[0])
      const before = order()
      expect(before[0]).toBe("Terminals")
      const moved = [...before.slice(1), "Terminals"]

      const box = toggles.first().element().getBoundingClientRect()
      await userEvent.dragAndDrop(toggles.first(), toggles.last(), {
        sourcePosition: { x: box.width / 2, y: box.height / 2 },
        targetPosition: { x: box.width / 2, y: box.height - 4 },
        steps: 12,
      })
      await expect.poll(order).toEqual(moved)
      // The toggles move as the drag goes; the new order is the rail's once it is let go,
      // and the toggle let go keeps the focus once its drop has played out.
      await expect
        .poll(() => localStorage.getItem("novadeck.sidebar-order"))
        .toMatch(/"terminals"\]$/)
      await expect.poll(() => document.activeElement?.id).toBe("terminals-toggle")

      await press("{Alt>}{ArrowUp}{/Alt}")
      await expect.poll(order).toEqual([...moved.slice(0, -2), "Terminals", moved.at(-2)])
      await expect.poll(() => document.activeElement?.id).toBe("terminals-toggle")
      await press("{Alt>}{ArrowDown}{/Alt}")
      await expect.poll(order).toEqual(moved)
      // At the end already, it stays.
      await press("{Alt>}{ArrowDown}{/Alt}")
      await expectStaysTrue(
        () =>
          JSON.stringify(order()) === JSON.stringify(moved) &&
          document.activeElement?.id === "terminals-toggle",
        "Terminals last, with focus",
      )

      await reloadWorkspace()

      await expect.poll(order).toEqual(moved)
    })
  })
})
