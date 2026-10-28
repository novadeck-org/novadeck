import { describe, expect, it } from "vitest"
import { page, userEvent } from "vitest/browser"

import { agentShowsPage } from "./support/backend"
import { boxOf, canvasView, scrollCanvas, settled } from "./support/canvas"
import { companionPane, openShowcase, taskbarIcon } from "./support/companions"
import {
  currentSessionName,
  emptyWorkspace,
  expectCurrentSession,
  pressNewSession,
  savedSession,
} from "./support/sessions"
import {
  chooseView,
  expectStaysAbsent,
  layoutSettled,
  openWorkspace,
  sidebarPanel,
  terminal,
  terminalTab,
} from "./support/workspace"

// A terminal's companion sheet hangs off its Canvas node, past the window's edge. Canvas
// frames it into view when it opens, and must when it is already open as Canvas mounts.

// Whether the sheet lies within the Canvas view, once the camera has stopped.
const sheetInView = (): boolean => {
  const sheet = companionPane("Build Studio").element().getBoundingClientRect()
  const view = canvasView().element().getBoundingClientRect()
  return (
    sheet.left >= view.left - 1 &&
    sheet.top >= view.top - 1 &&
    sheet.right <= view.right + 1 &&
    sheet.bottom <= view.bottom + 1
  )
}

describe("Canvas with a companion sheet open on arrival", () => {
  // The showcase's terminals stand in one column, whose fit is limited by its height, so the
  // sheet fits beside them however the camera is chosen: this guards the switch itself.
  it("frames the sheet when switched to from Grid", async () => {
    await openShowcase("grid")
    await terminalTab("Build Studio").click()
    await taskbarIcon("Build Studio", "Plan: A home for Studio").click()
    await expect.element(companionPane("Build Studio")).toBeVisible()

    await chooseView("Canvas")
    await layoutSettled()

    await expect.poll(sheetInView, { timeout: 3000 }).toBe(true)
  })

  it("frames the sheet when the showcase opens straight in Canvas", async () => {
    await openShowcase("canvas")
    await expect.element(companionPane("Build Studio")).toBeVisible()

    await expect.poll(sheetInView, { timeout: 3000 }).toBe(true)
  })
})

describe("Canvas returned to with its camera as it was left", () => {
  it("frames a sheet opened afterwards", async () => {
    await openShowcase("canvas")
    await companionPane("Build Studio")
      .getByRole("button", { name: "Minimize to the taskbar" })
      .click()
    await expect.poll(() => companionPane("Build Studio").query()).toBeNull()
    // Zoomed in on the board, so a sheet opening beside Build Studio would overflow it.
    const before = await settled(() => boxOf(terminal("Build Studio")))
    await scrollCanvas(-400)
    await expect
      .poll(() => boxOf(terminal("Build Studio")).width)
      .toBeGreaterThan(before.width * 1.3)
    const zoomed = await settled(() => boxOf(terminal("Build Studio")))
    const zoom = zoomed.width / before.width
    expect(zoomed.left + zoomed.width + 740 * zoom).toBeGreaterThan(boxOf(canvasView()).width)

    // A session left and returned to keeps its camera, rather than framing anything.
    await sidebarPanel("Sessions").click()
    const original = await currentSessionName()
    await pressNewSession()
    await expect.element(emptyWorkspace()).toBeVisible()
    await sidebarPanel("Sessions").click()
    await savedSession(original).click()
    await expectCurrentSession(original)
    await expect.element(terminal("Build Studio")).toBeVisible()
    await layoutSettled()

    // From the keyboard: zoomed in, the taskbar may lie past the view's bottom.
    taskbarIcon("Build Studio", "Plan: A home for Studio").element().focus()
    await userEvent.keyboard("{Enter}")
    await expect.element(companionPane("Build Studio")).toBeVisible()
    await expect.poll(sheetInView, { timeout: 3000 }).toBe(true)
  })
})

describe("Canvas with a sheet an agent opens beside a window that is not on top", () => {
  const node = (name: string): HTMLElement =>
    terminal(name).element().closest<HTMLElement>(".react-flow__node")!
  const layer = (name: string): number => Number(getComputedStyle(node(name)).zIndex)
  const selected = (name: string): boolean => node(name).classList.contains("selected")
  const others = ["Menu page", "Opening hours", "Photo gallery", "Order form"]
  const camera = (): string =>
    document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? ""

  it("waits behind a toast, the camera still; its Open selects the window, above every other", async () => {
    await openWorkspace("/projects/bar-mleczny/sessions/initial/canvas?demo=babcia")
    await expect.element(terminal("Seasonal specials")).toBeVisible()
    await terminalTab("Menu page").click()
    await layoutSettled()
    expect(selected("Menu page")).toBe(true)
    const before = camera()

    agentShowsPage()
    const toast = page.getByRole("button", { name: "Open", exact: true })
    await expect.element(toast).toBeVisible()
    await expect.element(page.getByText("wants to show you")).toBeVisible()
    expect(document.querySelector(".toast")?.textContent).toContain("Seasonal specials")
    await expectStaysAbsent(companionPane("Seasonal specials"), { ms: 500 })
    expect(camera()).toBe(before)
    expect(selected("Menu page")).toBe(true)

    await toast.click()
    await expect.element(companionPane("Seasonal specials")).toBeVisible()
    await expect.poll(() => selected("Seasonal specials")).toBe(true)
    await expect
      .poll(() => others.every((name) => layer("Seasonal specials") > layer(name)))
      .toBe(true)
  })

  it("raises the window of a sheet already open when Canvas mounts", async () => {
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

  it("keeps the selected window above another's sheet open on arrival, when it has one too", async () => {
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
