import { scriptedRunner } from "@novadeck/runner-adapter/scripted-server"
import { App } from "@novadeck/ui/app/App"
import { pageTheme } from "@novadeck/ui/theme/source"
import { afterEach, onTestFailed, onTestFinished } from "vitest"
import { cleanup, render } from "vitest-browser-react"
import { page, userEvent } from "vitest/browser"

import { pageScheme, saveFromAnotherWindow, systemScheme } from "../support/appearance"
import { joinTeam } from "../support/backend"
import { expectStaysTrue } from "../support/layouts"
import {
  chooseView,
  clickInto,
  draftOf,
  expectSelected,
  labelled,
  nextFrames,
  openWorkspace,
  press,
  sidebarPanel,
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
      const animations = document.getAnimations().filter(
        (animation) =>
          animation.playState === "running" &&
          animation.effect?.getTiming().iterations !== Infinity &&
          // A clock's, not a scroll's, which follows the list as long as it shows.
          animation.timeline instanceof DocumentTimeline,
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
  // Past the fold's motion and any entrance.
  const settled = () => new Promise((done) => setTimeout(done, 800))
  // Whether Checkout implementation's lit wire, this frame, runs to the one teammate shown and
  // no further: a single tick, the segment ending on its row.
  const onOneTeammate = () => {
    const lead = tabOf("Checkout implementation").getAttribute("data-terminal-tab-id")!
    const wire = `.team-wire-shape[data-lit][data-lead="${CSS.escape(lead)}"]`
    const taps = [...document.querySelectorAll(`${wire} > .team-wire-tap`)]
    const segment = document.querySelector(`${wire} > .team-wire-segment`)
    if (taps.length !== 1 || !segment) return taps.length === 0
    const row = Math.round(taps[0]!.getBoundingClientRect().top)
    return Math.abs(Math.round(segment.getBoundingClientRect().bottom) - (row + 1)) <= 1
  }
  // Whether every frame from `act` to half a second past its first runs to one teammate.
  const everyFrameWhile = (act: () => void) =>
    new Promise<boolean>((done) => {
      act()
      let start: number | undefined
      let always = true
      const step = (now: number) => {
        start ??= now
        always &&= onOneTeammate()
        if (now - start < 500) requestAnimationFrame(step)
        else done(always)
      }
      requestAnimationFrame(step)
    })

  it("never reaches the teammate going away, moving from one folded teammate to another", async () => {
    await openWorkspace("/?demo=messages&nested=on")
    await terminalTab("Dev server").click()
    await expect.poll(gutter).not.toBeNull()
    await userEvent.hover(gutter()!)
    await userEvent.click(gutter()!)
    await expect.poll(() => laidOut("Runtime")).toBe(false)
    await userEvent.click(foldRow("Tests"))
    await expect.poll(() => laidOut("Tests")).toBe(true)
    await settled()
    // Both ways, as the tab going away may stand above the one coming or below it.
    expect(await everyFrameWhile(() => foldRow("Runtime").click())).toBe(true)
    await settled()
    expect(await everyFrameWhile(() => foldRow("Tests").click())).toBe(true)
  })

  it("drops a teammate's tick at once as its team folds around the selected one", async () => {
    await openWorkspace("/?demo=messages&nested=on")
    await terminalTab("Runtime").click()
    await expect.poll(gutter).not.toBeNull()
    await settled()
    await userEvent.hover(gutter()!)
    await settled()
    const ticks = () =>
      document.querySelectorAll(".team-wire-shape[data-lit] > .team-wire-tap").length
    // Only the selected teammate's: no tick rides a collapsing tab, wherever the list stands.
    const most = await new Promise<number>((done) => {
      gutter()!.click()
      let start: number | undefined
      let furthest = 0
      const step = (now: number) => {
        start ??= now
        furthest = Math.max(furthest, ticks())
        if (now - start < 400) requestAnimationFrame(step)
        else done(furthest)
      }
      requestAnimationFrame(step)
    })
    expect(most).toBe(1)
    expect(laidOut("Runtime")).toBe(true)
  })

  const entrances = new Set(["team-wire-grow", "team-wire-reach"])
  // Whether any part of a wire plays an entrance this frame.
  const playing = () =>
    [...document.querySelectorAll(".team-wire-shape > i")].some((part) =>
      // An entrance: not the fade a selection lights it with, nor an armed fold's blink.
      part
        .getAnimations()
        .some(
          (animation) =>
            animation instanceof CSSAnimation &&
            entrances.has(animation.animationName) &&
            animation.playState === "running",
        ),
    )
  // Whether a wire played at any frame while `act` and its aftermath run.
  const playsWhile = (act: () => void) =>
    new Promise<boolean>((done) => {
      act()
      let start: number | undefined
      let played = false
      const step = (now: number) => {
        start ??= now
        played ||= playing()
        if (now - start < 600) requestAnimationFrame(step)
        else done(played)
      }
      requestAnimationFrame(step)
    })
  const select = (name: string) => () =>
    tabOf(name).querySelector<HTMLElement>(".sidebar-item-select")!.click()

  it("plays nothing as one of its members is selected, or another and back again", async () => {
    await openWorkspace("/?demo=messages")
    await expect.poll(() => document.querySelectorAll(".team-wire-shape").length).toBe(1)
    await settled()
    expect(await playsWhile(select("Checkout review"))).toBe(false)
    expect(await playsWhile(select("Checkout implementation"))).toBe(false)
    expect(await playsWhile(select("Dev server"))).toBe(false)
    expect(await playsWhile(select("Checkout review"))).toBe(false)
  })

  it("reaches out the tick of a teammate who joins, and only that one", async () => {
    await openWorkspace("/?demo=messages")
    await expect.poll(() => document.querySelectorAll(".team-wire-tap").length).toBe(1)
    await settled()
    joinTeam("Dev server", "Checkout implementation")
    const joining = () =>
      document.querySelector<HTMLElement>(".team-wire-tap[data-joining]")?.style.top ?? null
    await expect.poll(joining).not.toBeNull()
    expect(document.querySelectorAll(".team-wire-tap[data-joining]")).toHaveLength(1)
    expect(document.querySelector(".team-wire-shape[data-entering]")).toBeNull()
    // Once played, a later selection plays it no more.
    await settled()
    expect(await playsWhile(select("Dev server"))).toBe(false)
  })

  it("draws a team in whole as it forms", async () => {
    await openWorkspace("/?demo=messages")
    await expect.poll(() => document.querySelectorAll(".team-wire-shape").length).toBe(1)
    await settled()
    joinTeam("Dev server", "Runtime")
    await expect
      .poll(() => document.querySelectorAll(".team-wire-shape[data-entering]").length)
      .toBe(1)
    expect(document.querySelectorAll(".team-wire-shape")).toHaveLength(2)
  })

  it("stays on its tabs as the list scrolls, measuring and redrawing nothing", async () => {
    await openWorkspace("/?demo=messages")
    const list = document.querySelector<HTMLElement>(".terminal-tab-list")!
    list.style.flex = "none"
    list.style.height = "160px"
    await expect.poll(() => document.querySelectorAll(".team-wire-tap").length).toBe(1)
    await settled()
    const tap = document.querySelector<HTMLElement>(".team-wire-tap")!
    const placed = tap.style.top
    const name = (who: string) =>
      tabOf(who).querySelector(".sidebar-item-copy strong")!.getBoundingClientRect()
    const offset = () => {
      const rect = tap.getBoundingClientRect()
      return Math.round(
        rect.top - (name("Checkout review").top + name("Checkout review").height / 2),
      )
    }
    const before = offset()
    list.scrollTop = 40
    await nextFrames(3)
    expect(list.scrollTop).toBeGreaterThan(0)
    expect(Math.abs(offset() - before)).toBeLessThanOrEqual(1)
    expect(tap.style.top).toBe(placed)
    expect(document.querySelector(".team-wire-tap")).toBe(tap)
  })
})

describe("A tab's spinner", () => {
  // Every spinner and blink a tab draws, with the tab it stands in.
  const spinners = () =>
    document.getAnimations().flatMap((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target
      const tab = target?.closest("[data-terminal-tab-id]")
      return animation instanceof CSSAnimation && animation.animationName === "terminal-spin" && tab
        ? [{ animation, tab }]
        : []
    })

  it("rests while its tab is scrolled out of the list's sight, and spins again as it comes back", async () => {
    await openWorkspace("/?demo=messages")
    await expect.poll(() => spinners().length).toBeGreaterThan(0)
    const list = document.querySelector<HTMLElement>(".terminal-tab-list")!
    list.style.flex = "none"
    list.style.height = "40px"
    list.scrollTop = list.scrollHeight
    // Those out of sight rest; none in sight does.
    await expect
      .poll(() => spinners().filter(({ tab }) => tab.hasAttribute("data-offscreen")).length)
      .toBeGreaterThan(0)
    for (const { animation, tab } of spinners())
      expect(animation.playState).toBe(tab.hasAttribute("data-offscreen") ? "paused" : "running")
    // One that rested, scrolled back into sight.
    const rested = spinners().find(({ tab }) => tab.hasAttribute("data-offscreen"))!
    rested.tab.scrollIntoView({ block: "nearest" })
    await expect.poll(() => rested.animation.playState).toBe("running")
  })
})

// Grid opens tiles' screens as they come into sight (grid-offscreen.spec.tsx). A smooth scroll
// as it opens would bring the tiles it passes into sight on the way, so it opens in place.
describe("Grid opening", () => {
  it("opens on a tile far down without opening the tiles above it on the way", async () => {
    await page.viewport(1440, 900)
    // Ten agents in two columns: five rows, the last far below the first's margin.
    const runner = scriptedRunner({ terminals: 10 })
    const connection = await runner.connect(new AbortController().signal, pageTheme)
    onTestFinished(async () => {
      await cleanup()
      connection.close()
      await expect.poll(() => runner.connected()).toBe(false)
    })
    await render(<App createBackend={connection.createBackend} />)
    await chooseView("Focus")
    await terminalTab("Agent 10").click()
    await expect.element(terminal("Agent 10")).toBeVisible()
    await chooseView("Grid")
    // A tile holds xterm's element only once it takes its screen.
    const opened = (id: string): boolean =>
      document.querySelector(`[data-grid-terminal="${id}"] .xterm`) !== null
    await expect.poll(() => opened(runner.terminalIds.at(-1)!)).toBe(true)
    await expectStaysTrue(() => !opened(runner.terminalIds[0]!), "the first tile's screen", {
      ms: 1_000,
    })
  })
})

// Keeping an agent filters the Files tree to its work: the rows that stay slide together and the
// rest fade, drawn once more over the view as they go (useFilterMotion.tsx).
describe("The Files tree's filter", () => {
  it("fades the rows that go and brings them back, leaving nothing behind", async () => {
    await openWorkspace("/?demo=agents")
    await sidebarPanel("Files").click()
    const tree = page.getByRole("tree", { name: "Project files" })
    const untouched = page.getByRole("treeitem", { name: /^index\.html/ })
    await expect.element(untouched).toBeVisible()
    const ghosts = tree.element().querySelector(".files-ghosts")!
    const rows = tree.element().querySelector<HTMLElement>(".files-rows")!
    // How many rows that went were drawn at once, and how far down the rows showed while they
    // moved: to the view's foot, so a row sliding up from below a tree that shrank shows whole.
    let ghosted = 0
    let reached = 0
    const watch = new MutationObserver(() => {
      ghosted = Math.max(ghosted, ghosts.childElementCount)
      if (rows.style.overflow === "clip") reached = Math.max(reached, rows.offsetHeight)
    })
    watch.observe(ghosts, { childList: true })
    watch.observe(rows, { attributes: true, attributeFilter: ["style"] })
    const foot = (): number =>
      tree.element().scrollTop +
      tree.element().clientHeight -
      Number.parseFloat(getComputedStyle(tree.element()).paddingBottom)
    onTestFinished(() => watch.disconnect())
    // The rows' own motion, not a file's trail or a cursor's blink.
    const settled = (): boolean =>
      ghosts.childElementCount === 0 &&
      rows.style.overflow === "" &&
      [...tree.element().querySelectorAll(".files-rows > .files-slot")].every(
        (slot) => slot.getAnimations().length === 0,
      )
    const moth = page.getByRole("group", { name: "Show agents' work" }).getByRole("button", {
      name: "@moth",
    })

    await moth.click()
    await expect.element(untouched).not.toBeInTheDocument()
    await expect.poll(() => ghosted).toBeGreaterThan(0)
    // The tree is shorter than its view now, and its rows showed down to the view's foot.
    expect(Number.parseFloat(rows.style.height)).toBeLessThan(foot())
    expect(reached).toBeGreaterThanOrEqual(foot() - 1)
    await expect.poll(settled).toBe(true)

    await moth.click()
    await expect.element(untouched).toBeVisible()
    await expect.poll(settled).toBe(true)
  })
})
