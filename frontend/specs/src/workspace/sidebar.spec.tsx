import { page, userEvent, type Locator } from "vitest/browser"

import {
  closePreferences,
  openPreferencesOn,
  preferencesDialog,
  pressShortcut,
} from "../support/keyboard"
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
      await expect.element(sidebar()).toHaveAccessibleName("Sessions")

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

  context("when a panel's key is pressed", () => {
    it("shows Files, Worktrees and History by their keys", async () => {
      // The agents demo has the storefront's files and agent worktrees on.
      await openWorkspace("/?demo=agents")
      await pressShortcut("files")
      await expect.element(sidebar()).toHaveAccessibleName("Files")
      await pressShortcut("worktrees")
      await expect.element(sidebar()).toHaveAccessibleName("Worktrees")
      await pressShortcut("history")
      await expect.element(sidebar()).toHaveAccessibleName("History")
    })

    it("leaves a key alone where the rail has no toggle for its panel", async () => {
      // The plain demo has no files to show.
      await openWorkspace()
      await sidebarPanel("Inbox").click()
      await expect.element(sidebar()).toHaveAccessibleName("Inbox")

      await pressShortcut("files")

      await expectStaysTrue(
        () => sidebar().element().getAttribute("aria-label") === "Inbox",
        "the Inbox stays",
      )
    })
  })

  context("when another panel is shown", () => {
    it("stops laying out the one behind it, and draws it again when it's back", async () => {
      // The agents demo has the storefront's files and agent worktrees on.
      await openWorkspace("/?demo=agents")
      // Whether the browser renders the panel's content, whatever its fade: its header is
      // checked, as the panel's own box is drawn either way.
      const laidOut = (id: string) =>
        document.querySelector(`#${id} .sidebar-panel-header`)!.checkVisibility({
          visibilityProperty: false,
          opacityProperty: false,
        })
      await pressShortcut("files")
      const rows = () => sidebar().getByRole("treeitem")
      await expect.element(rows().first()).toBeVisible()
      expect(laidOut("files-panel")).toBe(true)
      for (const id of ["terminals-panel", "sessions-panel", "inbox-panel", "worktrees-panel"])
        expect(laidOut(id), id).toBe(false)

      await pressShortcut("worktrees")

      await expect.element(sidebar()).toHaveAccessibleName("Worktrees")
      await expect.poll(() => laidOut("files-panel")).toBe(false)
      expect(laidOut("worktrees-panel")).toBe(true)

      await pressShortcut("files")

      await expect.element(sidebar()).toHaveAccessibleName("Files")
      await expect.poll(() => laidOut("files-panel")).toBe(true)
      await expect.element(rows().first()).toBeVisible()
      await expect.poll(() => laidOut("worktrees-panel")).toBe(false)
    })
  })

  context("when the project has more than one session", () => {
    it("names the open session after the Terminals heading's count", async () => {
      await openWorkspace()
      const heading = () => sidebar().getByRole("heading", { name: /^Terminals/ })
      const scope = () =>
        document.querySelector("#terminals-panel .sidebar-panel-scope")?.textContent ?? null
      await expect.element(heading()).toBeVisible()
      expect(scope()).toBeNull()

      await sidebarPanel("Sessions").click()
      await page.getByRole("button", { name: "New session" }).click()

      await expect.element(sidebar()).toHaveAccessibleName("Terminals")
      await expect.element(heading()).toBeVisible()
      // A fresh session is named after the minute it started, such as "Nov 16, 14:05", with a
      // number after it where another of that minute has the name.
      await expect.poll(scope).toMatch(/^\w{3} \d{1,2}, \d{2}:\d{2}( \(\d+\))?$/)
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

describe("the agent worktrees switch", () => {
  const worktrees = () => preferencesDialog().getByRole("switch", { name: "Agent worktrees" })

  it("shows the Worktrees panel only while agent worktrees are on", async () => {
    await openWorkspace("/projects/storefront/sessions/initial/focus?panel=worktrees")
    await expect.element(sidebar()).toHaveAccessibleName("Worktrees")
    // Turned off with Worktrees open, the panel goes and the sidebar goes back to Terminals.
    await openPreferencesOn("Agents")
    await expect.element(worktrees()).toHaveAttribute("aria-checked", "true")
    await worktrees().click()
    await closePreferences()
    await expect.element(sidebarPanel("Worktrees")).not.toBeInTheDocument()
    await expect.element(sidebar()).toHaveAccessibleName("Terminals")
    // On again, it comes back.
    await openPreferencesOn("Agents")
    await worktrees().click()
    await closePreferences()
    await sidebarPanel("Worktrees").click()
    await expect.element(sidebar()).toHaveAccessibleName("Worktrees")
  })

  it("forgets a step back to the Worktrees panel once it is gone", async () => {
    await openWorkspace()
    await sidebarPanel("Worktrees").click()
    await sidebarPanel("Inbox").click()
    await expect.element(sidebar()).toHaveAccessibleName("Inbox")
    await openPreferencesOn("Agents")
    await worktrees().click()
    await closePreferences()
    await expect.element(sidebarPanel("Worktrees")).not.toBeInTheDocument()
    // The Inbox's toggle, with no Worktrees to go back to, hides the sidebar.
    await sidebarPanel("Inbox").click()
    await expect.element(sidebar()).not.toBeInTheDocument()
  })
})
