import { afterEach, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import { pressShortcut, terminalCount } from "./support/keyboard"
import { workspaceSwitcher } from "./support/sessions"
import {
  chooseView,
  expectStaysAbsent,
  openWorkspace,
  press,
  sidebar,
  sidebarPanel,
} from "./support/workspace"

// The website's demo, as far as the app's own parts of it go.
const openVisitor = async (): Promise<void> => {
  await openWorkspace("/?visitor=on")
}

const panel = () => page.getByRole("main", { name: "Best on a desktop browser" })
const download = () => panel().getByRole("link", { name: "Download Novadeck" })
const edge = (selector: string): DOMRect =>
  document.querySelector(selector)!.getBoundingClientRect()
const card = () => page.getByRole("region", { name: "Things to try" })
const hint = (text: string) => card().getByRole("listitem").filter({ hasText: text })
const framesPass = (count: number): Promise<void> =>
  count === 0
    ? Promise.resolve()
    : new Promise((resolve) => requestAnimationFrame(resolve)).then(() => framesPass(count - 1))
const narrowAndWiden = async (): Promise<void> => {
  await page.viewport(390, 800)
  await expect.element(panel()).toBeVisible()
  await page.viewport(1440, 900)
  await expect.element(workspaceSwitcher()).toBeVisible()
}

describe("the visitor build", () => {
  afterEach(() => page.viewport(1440, 900))

  it("keeps focus on the page when the things to try are dismissed", async () => {
    await openVisitor()
    await card().getByRole("button", { name: "Dismiss the things to try" }).click()
    await expect.element(card()).not.toBeInTheDocument()
    expect(document.activeElement).not.toBe(document.body)
  })

  it("closes the card from inside it with Escape", async () => {
    await openVisitor()
    card().getByRole("button", { name: "Dismiss the things to try" }).element().focus()
    await press("{Escape}")
    await expect.element(card()).not.toBeInTheDocument()
    expect(document.activeElement).not.toBe(document.body)
  })

  it("keeps the things to try clear of Zen's open dock", async () => {
    await openVisitor()
    await page.getByRole("button", { name: "Enter Zen mode" }).first().click()
    await expect.poll(() => document.querySelector(".zen-dock")).not.toBeNull()
    await expect.element(card()).toBeVisible()
    expect(edge(".visitor-hints").bottom).toBeLessThanOrEqual(edge(".zen-dock").top)
  })

  describe("in a window too narrow for the app", () => {
    // Everything the person may have open when the window narrows.
    const openers: Record<string, () => Promise<unknown>> = {
      Preferences: async () => {
        await page.getByRole("button", { name: "Workspace preferences" }).click()
        await expect.element(page.getByRole("dialog", { name: "Preferences" })).toBeVisible()
      },
      "the sidebar, as a drawer": async () => {
        await sidebarPanel("Sessions").click()
        await expect.element(sidebar()).toBeVisible()
      },
      "the workspace switcher": async () => {
        await workspaceSwitcher().click()
        await expect.element(page.getByRole("dialog", { name: "Switch workspace" })).toBeVisible()
      },
    }

    for (const [name, open] of Object.entries(openers))
      it(`leaves only the panel to reach with ${name} open`, async () => {
        await openVisitor()
        await open()
        await page.viewport(390, 800)
        await expect.element(panel()).toBeVisible()
        // The app is gone, not hidden: no dialog, sidebar or header is left to reach.
        expect(page.getByRole("dialog").query()).toBeNull()
        expect(page.getByRole("complementary").query()).toBeNull()
        expect(workspaceSwitcher().query()).toBeNull()
        expect(
          document.querySelector("[inert], [aria-hidden='true'], [data-aria-hidden]"),
        ).toBeNull()
        expect(getComputedStyle(document.body).pointerEvents).not.toBe("none")
        await press("{Tab}")
        await expect.element(download()).toHaveFocus()
      })

    it("does not act on the app's shortcuts", async () => {
      await openVisitor()
      await expect.element(terminalCount(6)).toBeVisible()
      await page.viewport(390, 800)
      await expect.element(panel()).toBeVisible()
      await pressShortcut("newTerminal")
      await page.viewport(1440, 900)
      await expect.element(terminalCount(6)).toBeVisible()
      await expectStaysAbsent(terminalCount(7))
    })

    it("brings a dialog the address names back when the window widens, with focus inside", async () => {
      await openVisitor()
      await page.getByRole("button", { name: "Workspace preferences" }).click()
      await expect.element(page.getByRole("dialog", { name: "Preferences" })).toBeVisible()
      await page.viewport(390, 800)
      await expect.element(panel()).toBeVisible()
      await page.viewport(1440, 900)
      const dialog = page.getByRole("dialog", { name: "Preferences" })
      await expect.element(dialog).toBeVisible()
      await expect.poll(() => dialog.element().contains(document.activeElement)).toBe(true)
    })

    it("puts focus on the page's controls, not the body, when it widens", async () => {
      await openVisitor()
      await page.viewport(390, 800)
      await expect.element(panel()).toBeVisible()
      await page.viewport(1440, 900)
      await expect.element(panel()).not.toBeInTheDocument()
      await expect.poll(() => document.activeElement).not.toBe(document.body)
    })

    it("leaves focus where it already is when the app comes back", async () => {
      await openVisitor()
      await page.viewport(390, 800)
      await expect.element(panel()).toBeVisible()
      // Takes focus the moment the header mounts, ahead of the refocus a few frames on.
      const button = "[aria-label='Workspace preferences']"
      const taken = new Promise<HTMLElement>((resolve) => {
        const watch = new MutationObserver(() => {
          const element = document.querySelector<HTMLElement>(button)
          if (!element) return
          watch.disconnect()
          element.focus()
          resolve(element)
        })
        watch.observe(document.body, { childList: true, subtree: true })
      })
      await page.viewport(1440, 900)
      const element = await taken
      await framesPass(10)
      expect(document.activeElement).toBe(element)
    })

    it("keeps the views hint halfway, then ticked, as the person left it", async () => {
      await openVisitor()
      const views = "Switch to Grid, then Canvas"
      await chooseView("Grid")
      await narrowAndWiden()
      // Grid is on screen again, and was seen before the app unmounted: Canvas is still to do.
      await expect.element(hint(views)).toHaveAttribute("data-done", "false")
      await chooseView("Canvas")
      await expect.element(hint(views)).toHaveAttribute("data-done", "true")
      await narrowAndWiden()
      await chooseView("Focus")
      await expect.element(hint(views)).toHaveAttribute("data-done", "true")
    })

    it("keeps the things to try as the person left them", async () => {
      await openVisitor()
      await card().getByRole("button", { name: "Dismiss the things to try" }).click()
      await page.viewport(390, 800)
      await expect.element(panel()).toBeVisible()
      await page.viewport(1440, 900)
      await expect
        .element(page.getByRole("button", { name: "Workspace preferences" }))
        .toBeVisible()
      await expectStaysAbsent(card())
    })
  })
})
