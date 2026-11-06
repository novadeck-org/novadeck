import { afterEach, onTestFailed } from "vitest"
import { userEvent } from "vitest/browser"

import { pageScheme, saveFromAnotherWindow, systemScheme } from "../support/appearance"
import {
  clickInto,
  draftOf,
  expectSelected,
  labelled,
  nextFrames,
  openWorkspace,
  press,
  terminal,
  terminalTab,
  typeInto,
  view,
  viewSwitcher,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// This project uses ordinary motion: the main behaviour suite opts out of animations.
// Transitions finish; a running terminal's spinner and header sweep loop for as long as
// it runs, so they never count.
const animationsFinished = async (): Promise<void> => {
  let pending: unknown[] = []
  onTestFailed(() =>
    console.error(
      "UI_PENDING_ANIMATIONS",
      JSON.stringify({
        visibility: document.visibilityState,
        pending,
      }),
    ),
  )
  await expect
    .poll(() => {
      const animations = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getTiming().iterations !== Infinity,
        )
      // Preserve the final sample even if cleanup removes its elements before the
      // failure hook. A count alone cannot identify a stuck transition or its clock.
      pending = animations.map((animation) => {
        const effect = animation.effect
        const target = effect instanceof KeyframeEffect ? effect.target : null
        return {
          id: animation.id,
          name: animation instanceof CSSAnimation ? animation.animationName : null,
          target: target instanceof Element ? target.outerHTML.slice(0, 250) : String(target),
          pseudo: effect instanceof KeyframeEffect ? effect.pseudoElement : null,
          currentTime: animation.currentTime,
          playbackRate: animation.playbackRate,
          pending: animation.pending,
          timing: effect?.getTiming(),
          computed: effect?.getComputedTiming(),
        }
      })
      return animations.length
    })
    .toBe(0)
}

describe("workspace motion", () => {
  context("when moving a terminal between views", () => {
    it("finishes the transition with its selection and input intact", async () => {
      expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false)
      expect(document.startViewTransition).toBeTypeOf("function")
      await openWorkspace()
      await terminalTab("Checkout review").click()
      await typeInto("Checkout review", "retained draft")

      await viewSwitcher().getByText("Grid", { exact: true }).click()
      await expect.element(view("Grid")).toBeChecked()
      await animationsFinished()
      await expectSelected("Checkout review")
      await expect.poll(() => draftOf("Checkout review")).toBe("retained draft")

      await terminal("Checkout review")
        .getByRole("button", { name: labelled("Focus ", "Checkout review") })
        .click()
      await expect.element(view("Focus")).toBeChecked()
      await animationsFinished()
      await expect.poll(() => draftOf("Checkout review")).toBe("retained draft")
      await clickInto("Checkout review")
      await press("!")
      await expect.poll(() => draftOf("Checkout review")).toBe("retained draft!")
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
      await typeInto("Checkout implementation", "still interactive")
      await expect.poll(() => draftOf("Checkout implementation")).toBe("still interactive")
    })
  })
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
      await nextFrames(3)

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
        appearance: { theme: "coolant", scheme: "dark" },
      })
      await nextFrames(3)

      expect(pageScheme()).toBe("dark")
      expect(surface.getAnimations()).toEqual([])
      expect(getComputedStyle(surface).backgroundColor).not.toBe(light)
      surface.remove()
    })
  })
})

describe("A team's wire", () => {
  // The messages demo with a nested team: Checkout implementation leads Tests and Runtime.
  const tabOf = (name: string) =>
    [...document.querySelectorAll<HTMLElement>("[data-terminal-tab-id]")].find((tab) =>
      tab
        .querySelector(".sidebar-item-select")
        ?.getAttribute("aria-label")
        ?.startsWith(`Select ${name}`),
    )!
  const laidOut = (name: string) => tabOf(name).getClientRects().length > 0
  const gutter = () => document.querySelector<HTMLElement>("[data-team-wire-gutter]")
  const foldRow = (name: string) =>
    document.querySelector<HTMLElement>(
      `[data-team-fold-row="${tabOf(name).getAttribute("data-terminal-tab-id")!}"]`,
    )!
  // Where the lit wires end as drawn this frame, their entrance included.
  const litBottom = () =>
    Math.max(
      ...[...document.querySelectorAll(".team-wire-shape[data-lit] > .team-wire-segment")].map(
        (segment) => segment.getBoundingClientRect().bottom,
      ),
    )
  // Past the fold's motion and the wire's entrance.
  const settled = () => new Promise((done) => setTimeout(done, 800))
  // How far the lit wires reach, frame by frame, from `act` to the end of their entrance, however
  // late a slow runner paints it: half a second past its first frame and any hold.
  const reachWhile = (act: () => void) =>
    new Promise<number>((done) => {
      act()
      let start: number | undefined
      let furthest = 0
      const step = (now: number) => {
        if (start === undefined || document.querySelector(".team-wire[data-holding]")) start = now
        furthest = Math.max(furthest, litBottom())
        if (now - start < 500) requestAnimationFrame(step)
        else done(furthest)
      }
      requestAnimationFrame(step)
    })

  it("draws no further than it ends, moving from one folded teammate to another", async () => {
    await openWorkspace("/?demo=messages&nested=on")
    await terminalTab("Dev server").click()
    await expect.poll(gutter).not.toBeNull()
    await userEvent.hover(gutter()!)
    await userEvent.click(gutter()!)
    await expect.poll(() => laidOut("Runtime")).toBe(false)
    await userEvent.click(foldRow("Tests"))
    await expect.poll(() => laidOut("Tests")).toBe(true)
    await settled()
    // The first teammate shown swaps nothing, so its wire draws at once.
    expect(document.querySelector(".team-wire")!.hasAttribute("data-holding")).toBe(false)
    const moveTo = async (name: string) => {
      const reached = await reachWhile(() => foldRow(name).click())
      await settled()
      expect(reached).toBeLessThanOrEqual(litBottom() + 1)
    }
    // Both ways, as the tab going away may stand above the one coming or below it.
    await moveTo("Runtime")
    await moveTo("Tests")
  })

  it("ends a hold as its tab leaves, with its team's wire out of view", async () => {
    await openWorkspace("/?demo=messages&nested=on")
    await terminalTab("Dev server").click()
    await expect.poll(gutter).not.toBeNull()
    await userEvent.hover(gutter()!)
    await userEvent.click(gutter()!)
    await expect.poll(() => laidOut("Runtime")).toBe(false)
    await userEvent.click(foldRow("Runtime"))
    await expect.poll(() => laidOut("Runtime")).toBe(true)
    await settled()
    // Nothing of the team shows, so nothing about the wires changes as Runtime's tab leaves.
    const list = document.querySelector<HTMLElement>(".terminal-tab-list")!
    list.style.flex = "none"
    list.style.height = "40px"
    list.scrollTop = list.scrollHeight
    await settled()
    const wire = document.querySelector(".team-wire")!
    tabOf("Dev server").querySelector<HTMLElement>(".sidebar-item-select")!.click()
    await expect.poll(() => wire.hasAttribute("data-holding")).toBe(true)
    await expect.poll(() => wire.hasAttribute("data-holding")).toBe(false)
  })
})
