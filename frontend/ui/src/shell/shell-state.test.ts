import { context, describe, expect, it } from "../test"
import {
  bumpNavigation,
  enterZen,
  exitZen,
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
      const shell = { ...bumpNavigation(initialShell(false), true), freshSession: "new" }
      expect(shell.navigation).toEqual({ count: 2, fit: true })
      const created = resetPresentation({ ...shell, revealCanvas: true }, "new")
      expect(created).toMatchObject({
        navigation: { count: 3, fit: false },
        revealCanvas: false,
        sidebar: true,
        freshSession: null,
      })
      expect(resetPresentation(shell, "other").sidebar).toBe(false)
    })
  })
})
