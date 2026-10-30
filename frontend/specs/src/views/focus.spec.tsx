import { page } from "vitest/browser"

import { bounds, focusView, gridView, headerGap } from "../support/layouts"
import {
  expectSelected,
  expectStaysAbsent,
  focusStage,
  openWorkspace,
  press,
  terminal,
  terminalTab,
  view,
  labelled,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

/** How far each edge of a terminal sits from the matching edge of the Focus view. */
const edgeGaps = (name: string): number[] => {
  const region = bounds(focusView())
  const shown = bounds(terminal(name))
  return (["top", "right", "bottom", "left"] as const).map((edge) =>
    Math.abs(shown[edge] - region[edge]),
  )
}

describe("Focus view", () => {
  context("when a terminal is selected", () => {
    it("shows it edge to edge in the view", async () => {
      await openWorkspace()

      await expect.element(focusView().getByRole("region", { name: /terminal$/ })).toBeVisible()
      await expect
        .poll(() => Math.max(...edgeGaps("Checkout implementation")))
        .toBeLessThanOrEqual(16)
    })

    it("shows another terminal when its tab is selected", async () => {
      await openWorkspace()

      await terminalTab("Tests").click()

      await expect.element(terminal("Tests")).toBeVisible()
      await expect.element(terminal("Checkout implementation")).not.toBeInTheDocument()
      await expect.element(focusView().getByRole("region", { name: /terminal$/ })).toHaveLength(1)
    })
  })

  context("when choosing Open in Grid from the header", () => {
    it("shows the terminal selected in Grid", async () => {
      await openWorkspace()
      await terminalTab("Runtime").click()

      await terminal("Runtime").getByRole("button", { name: "Open in Grid" }).click()

      await expect.element(view("Grid")).toBeChecked()
      await expect
        .element(gridView().getByRole("region", { name: labelled("", "Runtime", " terminal") }))
        .toBeVisible()
      await expect.element(terminal("Build")).toBeInTheDocument()
      await expectSelected("Runtime")
    })
  })

  context("when double-clicking the header outside the name", () => {
    it("has no effect", async () => {
      await openWorkspace()
      await expect.element(view("Focus")).toBeChecked()

      await terminal("Checkout implementation").dblClick({
        position: headerGap("Checkout implementation"),
      })

      await expectStaysAbsent(
        page.getByRole("textbox", { name: labelled("Rename ", "Checkout implementation") }),
      )
      await expectStaysAbsent(gridView())
      await expect.element(view("Focus")).toBeChecked()
      await expect
        .element(
          terminal("Checkout implementation").getByRole("heading", {
            name: "Checkout implementation",
          }),
        )
        .toBeVisible()
    })
  })

  context("when pressing Escape on the stage outside navigate mode", () => {
    it("keeps showing the selected terminal", async () => {
      await openWorkspace()
      await expectSelected("Checkout implementation")
      await focusStage()

      await press("{Escape}")

      await expectSelected("Checkout implementation")
      await expect.element(terminal("Checkout implementation")).toBeVisible()
    })
  })
})
