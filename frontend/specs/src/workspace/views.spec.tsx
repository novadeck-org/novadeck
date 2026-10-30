import { page } from "vitest/browser"

import { focusView, gridView } from "../support/layouts"
import {
  chooseView,
  expectSelected,
  expectStaysAbsent,
  focusStage,
  openWorkspace,
  press,
  terminal,
  terminalTab,
  view,
  viewSwitcher,
  labelled,
  clickInto,
  commandInput,
  navigateChip,
  sidebar,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

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

describe("workspace views", () => {
  context("when the workspace opens", () => {
    it("shows the first terminal in Focus", async () => {
      await openWorkspace()

      await expect.element(view("Focus")).toBeChecked()
      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await expect.element(terminal("Dev server")).not.toBeInTheDocument()
      await expectSelected("Checkout implementation")
    })
  })

  for (const name of ["Grid", "Canvas"] as const) {
    context(`when switching to ${name}`, () => {
      it("shows every terminal and keeps the selection", async () => {
        await openWorkspace()
        await terminalTab("Dev server").click()

        await chooseView(name)

        await expect
          .poll(() => page.getByRole("region", { name: / terminal$/ }).elements())
          .toHaveLength(6)
        await expectSelected("Dev server")
      })
    })
  }

  for (const name of ["Focus", "Grid", "Canvas"] as const) {
    context(`when pressing Escape in ${name}`, () => {
      it("does nothing outside navigate mode: it keeps the selection and the sidebar", async () => {
        await openWorkspace()
        await chooseView(name)
        await terminalTab("Dev server").click()
        await focusStage()

        await press("{Escape}")

        await expectSelected("Dev server")
        await expect.element(sidebar()).toBeVisible()
        await expectStaysAbsent(navigateChip())
      })

      it("leaves Escape to a focused terminal input", async () => {
        await openWorkspace()
        await chooseView(name)
        await terminalTab("Dev server").click()
        await clickInto("Dev server")

        await press("{Escape}")

        await expectSelected("Dev server")
        await expect.element(commandInput("Dev server")).toHaveFocus()
      })
    })
  }
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
      await expect
        .element(page.getByRole("button", { name: labelled("Focus ", "Tests") }))
        .toBeInTheDocument()

      await disableView("Focus")

      await expect.element(view("Focus")).not.toBeInTheDocument()
      await expect
        .element(page.getByRole("button", { name: labelled("Focus ", "Tests") }))
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

    it("hides the view switcher, keeping Zen", async () => {
      await openWorkspace()

      await disableView("Grid")
      await disableView("Canvas")

      await expect.element(viewSwitcher()).not.toBeInTheDocument()
      await expect.element(page.getByRole("button", { name: "Enter Zen mode" })).toBeVisible()

      await page.getByRole("button", { name: "Enter Zen mode" }).click()
      const dock = page.getByRole("group", { name: "Zen controls" })
      await expect.element(dock.getByRole("button", { name: "Exit Zen" })).toBeVisible()
      await expect.element(dock.getByRole("button", { name: /view$/ })).not.toBeInTheDocument()
    })

    it("brings the view switcher back once another view is enabled", async () => {
      await openWorkspace()
      await disableView("Grid")
      await disableView("Canvas")
      await expect.element(viewSwitcher()).not.toBeInTheDocument()

      // The same checkbox turns Grid back on.
      await disableView("Grid")

      await expect.element(viewSwitcher().getByRole("radio")).toHaveLength(2)
    })
  })
})
