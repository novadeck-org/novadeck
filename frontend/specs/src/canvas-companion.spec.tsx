import { describe, expect, it } from "vitest"
import { userEvent } from "vitest/browser"

import { boxOf, canvasView, scrollCanvas, settled } from "./support/canvas"
import { companionPane, openShowcase, taskbarIcon } from "./support/companions"
import {
  currentSessionName,
  emptyWorkspace,
  expectCurrentSession,
  pressNewSession,
  savedSession,
} from "./support/sessions"
import { chooseView, layoutSettled, sidebarPanel, terminal, terminalTab } from "./support/workspace"

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
