import { context, describe, expect, it } from "../test"
import {
  bumpNavigation,
  enterZen,
  exitZen,
  firstFlight,
  flies,
  flightAfter,
  hideSidebar,
  initialShell,
  resetPresentation,
  showPanel,
  sidebarVisible,
} from "./shell-state"

describe("shell state", () => {
  context("when deciding whether the sidebar shows", () => {
    it("follows the collapse on desktop, the drawer on a phone, and hides in Zen", () => {
      const shell = { ...initialShell(false), sidebar: false }
      expect(sidebarVisible(shell, true)).toBe(true)
      expect(sidebarVisible(shell, false)).toBe(false)
      expect(sidebarVisible({ ...shell, sidebar: true }, false)).toBe(true)
      expect(sidebarVisible(enterZen(shell, "terminals"), true)).toBe(false)
    })
  })

  context("when entering and leaving Zen", () => {
    it("remembers the sidebar and restores it on exit", () => {
      const shell = { ...initialShell(true), sidebar: true }
      const zen = enterZen(shell, "sessions")
      expect(zen.zen).toEqual({ sidebar: true, collapsed: true, panel: "sessions" })
      expect(enterZen(zen, "terminals")).toBe(zen)
      const restored = exitZen({ ...zen, sidebar: false })
      expect(restored).toMatchObject({ zen: null, sidebar: true, sidebarCollapsed: true })
      expect(exitZen(restored)).toBe(restored)
    })
  })

  context("when showing or hiding a panel", () => {
    it("opens the sidebar out of Zen and collapses it again", () => {
      const shown = showPanel(enterZen(initialShell(true), "terminals"))
      expect(shown).toMatchObject({ zen: null, sidebar: true, sidebarCollapsed: false })
      expect(hideSidebar(shown)).toMatchObject({ sidebar: false, sidebarCollapsed: true })
    })
  })

  context("when the presentation starts over", () => {
    it("pulses navigation and opens the drawer only for the session just created", () => {
      const shell = { ...bumpNavigation(initialShell(false), "fit"), freshSession: "new" }
      expect(shell.navigation).toEqual({ count: 2, move: "fit" })
      const created = resetPresentation({ ...shell, revealCanvas: true }, "new")
      expect(created).toMatchObject({
        navigation: { count: 3, move: "center" },
        revealCanvas: false,
        sidebar: true,
        freshSession: null,
      })
      expect(resetPresentation(shell, "other").sidebar).toBe(false)
    })
  })
})

describe("a navigation that flies", () => {
  const center = { count: 4, move: "center" } as const
  const fly = { count: 5, move: "fly" } as const

  context("when the stage mounts after it", () => {
    it("is spent, as it was for a stage that is gone", () => {
      const flight = firstFlight(fly, "p/s", "canvas")
      expect(flies(flightAfter(flight, fly, "p/s", "canvas"), fly, "p/s", "canvas")).toBe(false)
    })
  })

  context("when it arrives", () => {
    it("flies the view on screen, in the session it brought to the front", () => {
      const flight = flightAfter(firstFlight(center, "p/s", "grid"), fly, "q/t", "canvas")
      expect(flight).toEqual({ count: 5, context: "q/t", view: "canvas", spent: false })
      expect(flies(flight, fly, "q/t", "canvas")).toBe(true)
    })

    it("flies again on every render until something changes", () => {
      const flight = flightAfter(firstFlight(center, "p/s", "canvas"), fly, "p/s", "canvas")
      expect(flightAfter(flight, fly, "p/s", "canvas")).toBe(flight)
    })
  })

  context("when the view or the session changes after it", () => {
    it("is spent, and a view opened later frames as it would", () => {
      const flown = flightAfter(firstFlight(center, "p/s", "canvas"), fly, "p/s", "canvas")
      const inGrid = flightAfter(flown, fly, "p/s", "grid")
      expect(inGrid.spent).toBe(true)
      const back = flightAfter(inGrid, fly, "p/s", "canvas")
      expect(flies(back, fly, "p/s", "canvas")).toBe(false)
      expect(flies(flightAfter(flown, fly, "q/t", "canvas"), fly, "q/t", "canvas")).toBe(false)
    })
  })

  context("when the navigation does not fly", () => {
    it("flies nothing", () => {
      const flight = flightAfter(firstFlight(fly, "p/s", "canvas"), center, "p/s", "canvas")
      expect(flies(flight, { ...center, count: 4 }, "p/s", "canvas")).toBe(false)
    })
  })
})
