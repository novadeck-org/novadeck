import { page, userEvent } from "vitest/browser"

import { agentShowsPage } from "../support/backend"
import { boxOf, canvasView, scrollCanvas, settled } from "../support/canvas"
import { companionPane, openShowcase, taskbarIcon } from "../support/companions"
import { pressableToasts } from "../support/toasts"
import {
  chooseView,
  expectStaysAbsent,
  layoutSettled,
  openWorkspace,
  terminal,
  terminalTab,
} from "../support/workspace"
import { describe, expect, it } from "../test"

// A terminal's companion pane hangs off its Canvas node, past the window's edge. Canvas
// frames it into view when it opens, and must when it is already open as Canvas mounts.

// Whether the pane lies within the Canvas view, once the camera has stopped.
const paneInView = (): boolean => {
  const pane = companionPane("Build Studio").element().getBoundingClientRect()
  const view = canvasView().element().getBoundingClientRect()
  return (
    pane.left >= view.left - 1 &&
    pane.top >= view.top - 1 &&
    pane.right <= view.right + 1 &&
    pane.bottom <= view.bottom + 1
  )
}

describe("Canvas with a companion pane open on arrival", () => {
  // This guards the switch itself: the first camera takes in the pane open on a window.
  it("frames the pane when switched to from Grid", async () => {
    await openShowcase("grid")
    await terminalTab("Build Studio").click()
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    await expect.element(companionPane("Build Studio")).toBeVisible()

    await chooseView("Canvas")
    await layoutSettled()

    await expect.poll(paneInView, { timeout: 3000 }).toBe(true)
  })

  it("frames the pane when the showcase opens straight in Canvas", async () => {
    await openShowcase("canvas")
    await expect.element(companionPane("Build Studio")).toBeVisible()

    await expect.poll(paneInView, { timeout: 3000 }).toBe(true)
  })
})

describe("Canvas zoomed in on a window", () => {
  it("frames a pane opened afterwards", async () => {
    await openShowcase("canvas")
    await companionPane("Build Studio")
      .getByRole("button", { name: "Minimize to the taskbar" })
      .click()
    await expect.poll(() => companionPane("Build Studio").query()).toBeNull()
    // Zoomed in on the board, so a pane opening beside Build Studio would overflow it.
    const before = await settled(() => boxOf(terminal("Build Studio")))
    await scrollCanvas(-400)
    // The wheel's zoom lands over several frames, and a slow runner can draw identical ones
    // between them, so wait for the overflow itself rather than for a still frame.
    const overflows = (): boolean => {
      const box = boxOf(terminal("Build Studio"))
      const zoom = box.width / before.width
      return box.left + box.width + 740 * zoom > boxOf(canvasView()).width
    }
    await expect.poll(overflows).toBe(true)
    await settled(() => boxOf(terminal("Build Studio")))

    // From the keyboard: zoomed in, the taskbar may lie past the view's bottom.
    taskbarIcon("Build Studio", "Plan: A home for Studio").element().focus()
    await userEvent.keyboard("{Enter}")
    await expect.element(companionPane("Build Studio")).toBeVisible()
    await expect.poll(paneInView, { timeout: 3000 }).toBe(true)
  })
})

describe("Canvas with a pane an agent opens beside a window that is not on top", () => {
  // Its toast is pressed.
  pressableToasts()
  const node = (name: string): HTMLElement =>
    terminal(name).element().closest<HTMLElement>(".react-flow__node")!
  const layer = (name: string): number => Number(getComputedStyle(node(name)).zIndex)
  const selected = (name: string): boolean => node(name).classList.contains("selected")
  const others = ["Menu page", "Opening hours", "Photo gallery", "Order form"]
  const camera = (): string =>
    document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? ""

  it("waits behind a toast, the camera still; a click on it selects the window, above every other", async () => {
    await openWorkspace("/projects/bar-mleczny/sessions/initial/canvas?demo=babcia")
    await expect.element(terminal("Seasonal specials")).toBeVisible()
    await terminalTab("Menu page").click()
    await layoutSettled()
    expect(selected("Menu page")).toBe(true)
    const before = camera()

    agentShowsPage()
    await expect.element(page.getByText("wants to show you")).toBeVisible()
    const toast = document.querySelector<HTMLElement>(".toast")!
    expect(toast.textContent).toContain("Seasonal specials")
    await expectStaysAbsent(companionPane("Seasonal specials"), { ms: 500 })
    expect(camera()).toBe(before)
    expect(selected("Menu page")).toBe(true)

    // A click on it, as on an Inbox toast, takes the person there.
    await userEvent.click(page.elementLocator(toast))
    await expect.element(companionPane("Seasonal specials")).toBeVisible()
    await expect.poll(() => selected("Seasonal specials")).toBe(true)
    await expect
      .poll(() => others.every((name) => layer("Seasonal specials") > layer(name)))
      .toBe(true)
  })

  it("raises the window of a pane already open when Canvas mounts", async () => {
    await openWorkspace("/projects/bar-mleczny/sessions/initial/grid?demo=babcia")
    await expect.element(terminal("Seasonal specials")).toBeVisible()
    // Opened where the person is, then left open as they move to another window.
    await terminalTab("Seasonal specials").click()
    agentShowsPage()
    await expect.element(companionPane("Seasonal specials")).toBeVisible()
    await terminalTab("Menu page").click()

    await chooseView("Canvas")
    await layoutSettled()

    expect(selected("Seasonal specials")).toBe(false)
    await expect
      .poll(() => others.every((name) => layer("Seasonal specials") > layer(name)))
      .toBe(true)
  })

  it("keeps the selected window above another's pane open on arrival, when it has one too", async () => {
    await openShowcase("grid")
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    await expect.element(companionPane("Build Studio")).toBeVisible()
    await taskbarIcon("Refactor auth", "Plan: refactor-auth.md").click()
    await expect.element(companionPane("Refactor auth")).toBeVisible()
    await terminalTab("Build Studio").click()

    await chooseView("Canvas")
    await layoutSettled()

    await expect.element(companionPane("Refactor auth")).toBeVisible()
    await expect.poll(() => layer("Build Studio")).toBeGreaterThan(layer("Refactor auth"))
  })
})
