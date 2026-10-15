import { afterEach, describe, expect, it, vi } from "vitest"
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
  view,
  viewSwitcher,
} from "./support/workspace"

// The website's demo, as far as the app's own parts of it go.
const openVisitor = async (): Promise<void> => {
  await openWorkspace("/?visitor=on")
}

const panel = () => page.getByRole("main", { name: "Best on a desktop browser" })
const download = () => panel().getByRole("link", { name: "Download Novadeck" })
const framesPass = (count: number): Promise<void> =>
  count === 0
    ? Promise.resolve()
    : new Promise((resolve) => requestAnimationFrame(resolve)).then(() => framesPass(count - 1))
describe("the visitor build", () => {
  afterEach(() => page.viewport(1440, 900))

  it("says the agents are simulated, with a link to the download", async () => {
    await openVisitor()
    await expect.element(page.getByText(/agents are simulated/)).toBeVisible()
    await expect
      .element(page.getByRole("link", { name: "Download Novadeck" }))
      .toHaveAttribute("href", "https://novadeck.dev/download")
  })

  it("has no debug panel or Addons tab", async () => {
    await openVisitor()
    await expect.element(workspaceSwitcher()).toBeVisible()
    expect(page.getByRole("button", { name: "Open the debug panel" }).query()).toBeNull()
    await page.getByRole("button", { name: "Workspace preferences" }).click()
    const dialog = page.getByRole("dialog", { name: "Preferences" })
    await expect.element(dialog).toBeVisible()
    await expect.element(dialog.getByRole("tab", { name: "General" })).toBeVisible()
    expect(dialog.getByRole("tab", { name: "Addons" }).query()).toBeNull()
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
  })

  it("says nothing to a page around it without ?embed", async () => {
    const post = vi.spyOn(window.parent, "postMessage")
    try {
      await openVisitor()
      await framesPass(5)
      expect(post.mock.calls.filter(([message]) => message?.type === "novadeck:ready")).toEqual([])
    } finally {
      post.mockRestore()
    }
  })

  describe("framed in another page", () => {
    const openEmbedded = async (): Promise<void> => {
      await openWorkspace("/?visitor=on", { embedded: true })
    }

    it("leaves saying what it is to the page around it", async () => {
      await openEmbedded()
      await expect.element(workspaceSwitcher()).toBeVisible()
      expect(page.getByText(/agents are simulated/).query()).toBeNull()
      expect(page.getByRole("link", { name: "Download Novadeck" }).query()).toBeNull()
    })

    it("keeps the app in a narrow frame", async () => {
      await openEmbedded()
      await page.viewport(390, 800)
      await expectStaysAbsent(panel())
      await expect.element(viewSwitcher()).toBeInTheDocument()
    })

    it("adds nothing to the page's Back button as the person moves around", async () => {
      await openEmbedded()
      const entries = window.history.length
      await chooseView("Grid")
      await chooseView("Canvas")
      await expect.element(view("Canvas")).toBeChecked()
      expect(window.history.length).toBe(entries)
    })

    // The test page sits in a frame of its own, so its parent is the runner's page.
    it("tells the page around it once it has booted, once", async () => {
      expect(window.parent).not.toBe(window)
      const post = vi.spyOn(window.parent, "postMessage")
      try {
        await openEmbedded()
        await framesPass(5)
        expect(post.mock.calls.filter(([message]) => message?.type === "novadeck:ready")).toEqual([
          [{ type: "novadeck:ready" }, "*"],
        ])
      } finally {
        post.mockRestore()
      }
    })

    // True of the app anywhere; framed, it leaves the page around it its focus.
    it("takes no focus until the person uses it", async () => {
      await openEmbedded()
      await framesPass(10)
      expect(document.activeElement).toBe(document.body)
    })
  })
})
