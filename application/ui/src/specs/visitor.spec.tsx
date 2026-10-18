import { afterEach, describe, expect, it, vi } from "vitest"
import { page } from "vitest/browser"

import { taskbarIcon } from "./support/companions"
import { pressShortcut, terminalCount } from "./support/keyboard"
import { workspaceSwitcher } from "./support/sessions"
import {
  chooseView,
  expectStaysAbsent,
  labelled,
  openWorkspace,
  press,
  sidebar,
  sidebarPanel,
  tabDescription,
  typeInto,
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
      await expect.element(terminalCount(4)).toBeVisible()
      await page.viewport(390, 800)
      await expect.element(panel()).toBeVisible()
      await pressShortcut("newTerminal")
      await page.viewport(1440, 900)
      await expect.element(terminalCount(4)).toBeVisible()
      await expectStaysAbsent(terminalCount(5))
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

    // The page around the app is still tilted and not the visitor's yet: its wheel is that
    // page's, until the page says the visitor engaged the app. Nothing in the app takes it or
    // scrolls with it, not even a terminal with history above, and nothing cancels it, so
    // the browser scrolls the page with it.
    it("leaves the wheel to the page around it until that page engages it", async () => {
      expect(window.parent).not.toBe(window)
      await openEmbedded()
      const target = document.querySelector<HTMLElement>("[data-terminal-content]")!
      const reached = vi.fn<() => void>()
      target.addEventListener("wheel", reached)
      const wheel = (): WheelEvent => {
        const event = new WheelEvent("wheel", { deltaY: 60, cancelable: true, bubbles: true })
        target.dispatchEvent(event)
        return event
      }
      expect(wheel().defaultPrevented).toBe(false)
      expect(reached).not.toHaveBeenCalled()
      expect(getComputedStyle(target).overflowY).toBe("hidden")
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "novadeck:engaged" },
          source: window.parent,
        }),
      )
      wheel()
      expect(reached).toHaveBeenCalled()
      expect(getComputedStyle(target).overflowY).toBe("auto")
    })

    it("tells the page of its first click once, and keeps the wheel once pressed in", async () => {
      const post = vi.spyOn(window.parent, "postMessage")
      try {
        await openEmbedded()
        const target = document.querySelector("[data-terminal-content]")!
        target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
        const event = new WheelEvent("wheel", { deltaY: 60, cancelable: true, bubbles: true })
        target.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(false)
        await page.getByRole("button", { name: "Workspace preferences" }).click()
        await press("{Escape}")
        await page.getByRole("button", { name: "Workspace preferences" }).click()
        await expect
          .poll(() => post.mock.calls.filter(([m]) => m?.type === "novadeck:clicked").length)
          .toBe(1)
      } finally {
        post.mockRestore()
      }
    })

    // The page around treats focus moving into the frame as the visitor's first click, so
    // nothing the desk does by itself, reading and then asking, may take it.
    it("reads before it asks for its plan, and takes no focus meanwhile", async () => {
      await openWorkspace("/?visitor=on&readingMs=1500", { embedded: true })
      await expect.element(terminalCount(4)).toBeVisible()
      expect(page.getByText("Claude has written up a plan").query()).toBeNull()
      await expect
        .poll(() => tabDescription("Checkout implementation"), { timeout: 4000 })
        .toBe("Plan ready for review")
      await framesPass(10)
      expect(document.activeElement).toBe(document.body)
    })

    // True of the app anywhere; framed, it leaves the page around it its focus.
    it("takes no focus until the person uses it", async () => {
      await openEmbedded()
      await framesPass(10)
      expect(document.activeElement).toBe(document.body)
    })
  })

  describe("on its desk", () => {
    // The bell, whose name says how many wait, e.g. "Notifications, 1 waiting".
    const bell = () => sidebarPanel("Notifications")
    const waiting = (count: number) =>
      page.getByRole("radio", { name: `Notifications, ${count} waiting` })
    // Answers what the agent in the terminal asks with its first option, on its screen.
    const answer = async (name: string): Promise<void> => {
      await page.getByRole("button", { name: labelled("Select ", name) }).click()
      await typeInto(name, "1")
      await press("{Enter}")
    }

    it("opens with one agent asking, and nothing elsewhere", async () => {
      await openVisitor()
      await expect.element(terminalCount(4)).toBeVisible()
      await expect
        .poll(() => tabDescription("Checkout implementation"))
        .toBe("Plan ready for review")
      await expect.element(bell()).toHaveAccessibleName("Notifications, 1 waiting")
      await expect.element(workspaceSwitcher()).not.toHaveAttribute("data-project-status")
    })

    it("moves on only once the visitor answers, and ends quiet", async () => {
      // Codex asks a second after Claude Code's turn ends, past the moment a finish counts as
      // seen by whoever looks at it.
      await openWorkspace("/?visitor=on&turnMs=200&nudgeMs=1000")
      // Codex reviews, and asks nothing while the plan waits.
      await expect.element(waiting(1)).toBeInTheDocument()
      await expectStaysAbsent(waiting(2), { ms: 800 })
      expect(tabDescription("Checkout review")).toBeNull()

      await answer("Checkout implementation")
      await expect
        .element(taskbarIcon("Checkout implementation", "order-summary.png"))
        .toBeVisible()
      await expect.poll(() => tabDescription("Checkout review")).toBe("Needs permission")
      await expect.element(waiting(1)).toBeInTheDocument()

      await answer("Checkout review")
      await expect.poll(() => tabDescription("Checkout review") ?? "").not.toContain("Needs")
      await expect.element(bell()).toHaveAccessibleName("Notifications")
      await expectStaysAbsent(page.getByRole("radio", { name: /^Notifications, / }), { ms: 800 })
    })
  })
})
