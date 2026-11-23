import { afterEach } from "vitest"
import { page } from "vitest/browser"

import { openWorkspace, sidebar, sidebarPanel, viewSwitcher } from "../support/workspace"
import { context, describe, expect, it } from "../test"

// Where macOS's buttons end, from the window's left edge, in CSS pixels at the normal scale:
// the stand-in's 16 before them and 54 across them (as apps/desktop's window/controls.ts).
const buttonsEnd = 70

// The rail's width, its `w-11`.
const railWidth = 44

const box = (selector: string): DOMRect => {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`No ${selector} on the page`)
  return element.getBoundingClientRect()
}

const header = (): HTMLElement => document.querySelector<HTMLElement>(".app-header")!

// Where the project switcher starts, the header's first control.
const switcherStart = (): number => box(".workspace-switcher-trigger").left

describe("the window's own controls over the page", () => {
  afterEach(() => page.viewport(1440, 900))

  context("on macOS, where the buttons sit at the start", () => {
    it("runs the rail and the sidebar to the window's top, the header heading the terminals alone", async () => {
      await openWorkspace("/?controls=inset")
      await expect.element(sidebar()).toBeVisible()

      expect(box(".sidebar-tools").top).toBe(0)
      expect(box(".workspace-sidebar-pane").top).toBe(0)
      expect(header().closest(".workspace-main-pane")).not.toBeNull()
      expect(box(".app-header").top).toBe(0)
      expect(box(".app-header").left).toBeGreaterThanOrEqual(
        sidebar().element().getBoundingClientRect().right,
      )
      // The sidebar's panels start below the strip the buttons sit on.
      expect(sidebar().element().getBoundingClientRect().top).toBe(box(".app-header").height)
    })

    it("with the sidebar hidden, runs the header from the rail, its start clear of the buttons", async () => {
      await openWorkspace("/?controls=inset")
      // The open panel's toggle, pressed again with no panel before it, hides the sidebar.
      await sidebarPanel("Terminals").click()
      await expect.element(sidebar()).not.toBeInTheDocument()

      await expect.poll(() => box(".app-header").left).toBe(railWidth)
      expect(switcherStart()).toBeGreaterThanOrEqual(buttonsEnd)
    })

    it("on a narrow screen, where the sidebar is a drawer, keeps the header clear of the buttons", async () => {
      await page.viewport(600, 800)
      await openWorkspace("/?controls=inset")

      expect(switcherStart()).toBeGreaterThanOrEqual(buttonsEnd)
    })

    it("gives the view switch's words up by the header's width, not the window's", async () => {
      // 900 wide, the sidebar's 228 and the rail's 44 leave the header 628.
      await page.viewport(900, 800)
      await openWorkspace("/?controls=inset")
      await expect.element(sidebar()).toBeVisible()

      await expect.element(viewSwitcher().getByText("Grid", { exact: true })).not.toBeVisible()
    })

    it("in Zen, hides the header and the rail's strip with the rail", async () => {
      await openWorkspace("/?controls=inset")
      await page.getByRole("button", { name: "Enter Zen mode" }).click()
      await expect
        .element(
          page
            .getByRole("group", { name: "Zen controls" })
            .getByRole("button", { name: "Exit Zen" }),
        )
        .toBeVisible()

      expect(header().getBoundingClientRect().height).toBe(0)
      expect(box(".rail-titlebar").height).toBe(0)
    })
  })

  context("on Windows, where the buttons sit at the end", () => {
    it("keeps the header across the window's top, over the rail and the sidebar", async () => {
      await openWorkspace("/?controls=caption")
      await expect.element(sidebar()).toBeVisible()

      expect(header().parentElement?.matches(".workspace")).toBe(true)
      expect(box(".sidebar-tools").top).toBeGreaterThanOrEqual(box(".app-header").bottom)
      expect(document.querySelector(".rail-titlebar")).toBeNull()
    })
  })

  context("in a browser, with the window's own title bar", () => {
    it("keeps the header across the top, and the view switch's words on a 900px screen", async () => {
      await page.viewport(900, 800)
      await openWorkspace()

      expect(header().parentElement?.matches(".workspace")).toBe(true)
      expect(document.querySelector(".rail-titlebar")).toBeNull()
      await expect.element(viewSwitcher().getByText("Grid", { exact: true })).toBeVisible()
    })
  })
})
