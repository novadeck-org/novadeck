import { afterEach, describe as context, describe, expect, it } from "vitest"

import { pageScheme, saveFromAnotherWindow, systemScheme } from "./support/appearance"
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
// Transitions finish; a running terminal's spinner and header sweep loop for as long as
// it runs, so they never count.
const animationsFinished = async (): Promise<void> => {
  await expect
    .poll(
      () =>
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.playState === "running" &&
              animation.effect?.getTiming().iterations !== Infinity,
          ).length,
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

// Waits for the browser to draw this many frames, without reading a style on the way:
// a read would apply pending styles early and hide whether the page stilled them.
const frames = (count: number): Promise<void> =>
  new Promise((resolve) => {
    const next = (left: number): void => {
      if (left === 0) resolve()
      else requestAnimationFrame(() => next(left - 1))
    }
    next(count)
  })

// A surface that fades its ground over two seconds, as a control's hover does.
const fadingSurface = (): HTMLElement => {
  const surface = document.createElement("div")
  surface.style.cssText =
    "width: 40px; height: 40px; background-color: var(--color-paper); transition: background-color 2s linear"
  document.body.append(surface)
  expect(getComputedStyle(surface).transitionDuration).toBe("2s")
  return surface
}

describe("theme motion", () => {
  afterEach(() => systemScheme(null))

  context("when the system's scheme changes", () => {
    it("changes every colour at once instead of fading", async () => {
      await systemScheme("light")
      await openWorkspace()
      const surface = fadingSurface()
      const light = getComputedStyle(surface).backgroundColor

      await systemScheme("dark")
      await frames(3)

      expect(pageScheme()).toBe("dark")
      expect(surface.getAnimations()).toEqual([])
      expect(getComputedStyle(surface).backgroundColor).not.toBe(light)
      surface.remove()
    })
  })

  context("when another window chooses a mode", () => {
    it("changes every colour at once instead of fading", async () => {
      await systemScheme("light")
      await openWorkspace()
      const surface = fadingSurface()
      const light = getComputedStyle(surface).backgroundColor

      const saved = JSON.parse(localStorage.getItem("novadeck.preferences") ?? "{}")
      saveFromAnotherWindow("novadeck.preferences", {
        ...saved,
        appearance: { theme: "graphite", scheme: "dark" },
      })
      await frames(3)

      expect(pageScheme()).toBe("dark")
      expect(surface.getAnimations()).toEqual([])
      expect(getComputedStyle(surface).backgroundColor).not.toBe(light)
      surface.remove()
    })
  })
})
