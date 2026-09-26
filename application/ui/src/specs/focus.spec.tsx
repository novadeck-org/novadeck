import { describe as context, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import { bounds, focusView, gridView, headerGap } from "./support/layouts"
import {
  chooseView,
  commandInput,
  expectNothingSelected,
  expectSelected,
  expectStaysAbsent,
  openWorkspace,
  press,
  terminal,
  terminalTab,
  view,
  viewSwitcher,
} from "./support/workspace"

const openPreferences = async (): Promise<void> => {
  await page.getByRole("button", { name: "Workspace preferences" }).click()
  await expect.element(page.getByRole("dialog", { name: "Preferences" })).toBeVisible()
}

const disableView = async (name: "Focus" | "Grid" | "Canvas"): Promise<void> => {
  await openPreferences()
  await page.getByRole("group", { name: "View modes" }).getByRole("checkbox", { name }).click()
  await page.getByRole("button", { name: "Close preferences" }).click()
  await expect.element(page.getByRole("dialog", { name: "Preferences" })).not.toBeInTheDocument()
}

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
        .element(gridView().getByRole("region", { name: "Runtime terminal" }))
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

      await expectStaysAbsent(page.getByRole("textbox", { name: "Rename Checkout implementation" }))
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

  context("when Escape deselects the terminal", () => {
    it("keeps showing it", async () => {
      await openWorkspace()
      await expectSelected("Checkout implementation")

      await press("{Escape}")

      await expectNothingSelected()
      await expect.element(terminal("Checkout implementation")).toBeVisible()
    })

    it("activates it again when clicked", async () => {
      await openWorkspace()
      await press("{Escape}")
      await expectNothingSelected()

      await terminal("Checkout implementation").click()

      await expectSelected("Checkout implementation")
      await expect.element(terminal("Checkout implementation")).toBeVisible()
    })

    it("activates it again when its input receives focus", async () => {
      await openWorkspace()
      await press("{Escape}")
      await expectNothingSelected()

      await commandInput("Checkout implementation").click()

      await expectSelected("Checkout implementation")
      await expect.element(commandInput("Checkout implementation")).toHaveFocus()
    })
  })
})

describe("available view modes", () => {
  context("when a view is disabled in Preferences", () => {
    it("removes it from the view switcher", async () => {
      await openWorkspace()
      await expect.element(view("Grid")).toBeInTheDocument()

      await disableView("Grid")

      await expect.element(view("Grid")).not.toBeInTheDocument()
      await expect.element(viewSwitcher().getByRole("radio")).toHaveLength(2)
    })

    it("offers the remaining windowed view from the Focus header", async () => {
      await openWorkspace()
      await expect.element(page.getByRole("button", { name: "Open in Grid" })).toBeVisible()

      await disableView("Grid")

      await expect.element(page.getByRole("button", { name: "Open in Canvas" })).toBeVisible()
      await expect
        .element(page.getByRole("button", { name: "Open in Grid" }))
        .not.toBeInTheDocument()
    })

    it("moves away from the view when it is the current one", async () => {
      await openWorkspace()
      await chooseView("Grid")

      await disableView("Grid")

      await expect.element(gridView()).not.toBeInTheDocument()
      await expect
        .poll(() => viewSwitcher().getByRole("radio", { checked: true }).elements())
        .toHaveLength(1)
    })
  })

  context("when Focus is disabled", () => {
    it("leaves no Focus action on Grid terminals", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await expect.element(page.getByRole("button", { name: "Focus Tests" })).toBeInTheDocument()

      await disableView("Focus")

      await expect.element(view("Focus")).not.toBeInTheDocument()
      await expect
        .element(page.getByRole("button", { name: "Focus Tests" }))
        .not.toBeInTheDocument()
    })
  })

  context("when only one view remains", () => {
    it("keeps showing that view with no view to switch to", async () => {
      await openWorkspace()

      await disableView("Grid")
      await disableView("Canvas")

      await expect.element(focusView()).toBeVisible()
      await expect.element(page.getByRole("button", { name: /^Open in / })).not.toBeInTheDocument()
    })
  })
})
