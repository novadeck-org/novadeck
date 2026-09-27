import { describe as context, describe, expect, it } from "vitest"

import {
  commandInput,
  expectSelected,
  openWorkspace,
  press,
  terminal,
  terminalTab,
  view,
  viewSwitcher,
} from "./support/workspace"

// This project uses ordinary motion: the main behavior suite opts out of animations.
const animationsFinished = async (): Promise<void> => {
  await expect
    .poll(
      () =>
        document.getAnimations().filter((animation) => animation.playState === "running").length,
    )
    .toBe(0)
}

describe("workspace motion", () => {
  context("when moving a terminal between views", () => {
    it("finishes the transition with its selection and input intact", async () => {
      expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false)
      expect(document.startViewTransition).toBeTypeOf("function")
      await openWorkspace()
      await terminalTab("Dev server").click()
      await commandInput("Dev server").fill("retained draft")

      await viewSwitcher().getByText("Grid", { exact: true }).click()
      await expect.element(view("Grid")).toBeChecked()
      await animationsFinished()
      await expectSelected("Dev server")
      await expect.element(commandInput("Dev server")).toHaveValue("retained draft")

      await terminal("Dev server")
        .getByRole("button", { name: "Focus Dev server", exact: true })
        .click()
      await expect.element(view("Focus")).toBeChecked()
      await animationsFinished()
      await expect.element(commandInput("Dev server")).toHaveValue("retained draft")
      await commandInput("Dev server").click()
      await press("!")
      await expect.element(commandInput("Dev server")).toHaveValue("retained draft!")
    })
  })

  context("when another view is requested during a transition", () => {
    it("settles on the last requested view and remains interactive", async () => {
      await openWorkspace()
      await viewSwitcher().getByText("Grid", { exact: true }).click()
      await viewSwitcher().getByText("Canvas", { exact: true }).click()
      await expect.element(view("Canvas")).toBeChecked()
      await animationsFinished()
      await expect.element(terminal("Checkout implementation")).toBeVisible()

      await viewSwitcher().getByText("Focus", { exact: true }).click()
      await expect.element(view("Focus")).toBeChecked()
      await animationsFinished()
      await commandInput("Checkout implementation").fill("still interactive")
      await expect.element(commandInput("Checkout implementation")).toHaveValue("still interactive")
    })
  })
})
