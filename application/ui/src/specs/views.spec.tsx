import { describe as context, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import {
  chooseView,
  commandInput,
  expectNothingSelected,
  expectSelected,
  openWorkspace,
  press,
  sidebar,
  terminal,
  terminalTab,
  view,
} from "./support/workspace"

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
      it("deselects the terminal first, then hides the sidebar, then does nothing", async () => {
        await openWorkspace()
        await chooseView(name)
        await terminalTab("Dev server").click()

        await press("{Escape}")
        await expectNothingSelected()
        await expect.element(sidebar()).toBeVisible()

        await press("{Escape}")
        await expect.element(sidebar()).not.toBeInTheDocument()

        await press("{Escape}")
        await expect.element(sidebar()).not.toBeInTheDocument()
        await expectNothingSelected()
      })

      it("leaves Escape to a focused terminal input", async () => {
        await openWorkspace()
        await chooseView(name)
        await terminalTab("Dev server").click()
        await commandInput("Dev server").click()

        await press("{Escape}")

        await expectSelected("Dev server")
        await expect.element(commandInput("Dev server")).toHaveFocus()
      })
    })
  }
})
