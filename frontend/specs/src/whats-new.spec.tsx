import { beforeEach, describe as context, describe, expect, it } from "vitest"
import { page, type Locator } from "vitest/browser"

import {
  forgetHostCalls,
  reportProgress,
  startDownload,
  whatsNewAsked,
  whatsNewCalls,
} from "./support/backend"
import { findDialog, pressShortcut } from "./support/keyboard"
import {
  commandInput,
  expectStaysAbsent,
  openWorkspace,
  press,
  terminalTab,
} from "./support/workspace"

// The card is a region named by its label, which the CSS sets in capitals.
const card = (): Locator => page.getByRole("region", { name: /New in Novadeck/ })
const closeButton = (): Locator => card().getByRole("button", { name: "Dismiss" })
const releaseNotes = (): Locator => card().getByRole("button", { name: "Release notes" })
const announcer = () => page.getByRole("status").filter({ hasText: /New in Novadeck/ })
const sandboxNotice = (): Locator =>
  page.getByRole("region", { name: "Novadeck is running without its security sandbox" })
const dock = () => page.getByRole("group", { name: "Zen controls" })
// A demo download takes 3 seconds, then its finished bar stays 4 more before it fades.
const slow = { timeout: 12_000 }
const cardElement = (): Element | null => document.querySelector(".whats-new")

describe("the what's-new card", () => {
  beforeEach(forgetHostCalls)

  it("is absent where the host has no word of it", async () => {
    await openWorkspace()
    await expectStaysAbsent(card())
    expect(cardElement()).toBeNull()
  })

  it("is absent when the host answers that there is nothing to show", async () => {
    await openWorkspace("/?update=noHighlights")
    // The host takes 1.5 s to say so: the page has asked, and shows nothing once it has.
    await expect.poll(whatsNewAsked).toBeGreaterThan(0)
    await expectStaysAbsent(card(), { ms: 2_500 })
    expect(cardElement()).toBeNull()
    expect(whatsNewCalls()).toEqual({ dismissed: 0, pages: 0 })
  })

  context("after an update with highlights", () => {
    it("lists each as a title with its line, and links the release notes", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      await expect.element(card().getByText("New in Novadeck 0.0.80")).toBeVisible()
      await expect.element(card().getByText("Word handles for terminals")).toBeVisible()
      await expect.element(card().getByText('Talk to @moth instead of "terminal 3".')).toBeVisible()
      await expect.element(card().getByText("Plans open beside the terminal")).toBeVisible()
      await expect.element(card().getByText("Answer agents from the Inbox")).toBeVisible()
      await expect.element(releaseNotes()).toBeVisible()
      // Nothing about restarting: this card is not the download's.
      expect(card().element().textContent).not.toMatch(/restart|install/i)
      expect(card().element().querySelectorAll("button")).toHaveLength(2)
    })

    it("announces itself once, politely, and never takes focus", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      await expect
        .element(announcer())
        .toHaveTextContent(
          "New in Novadeck 0.0.80: Word handles for terminals, Plans open beside the terminal, Answer agents from the Inbox",
        )
      expect(announcer().element().getAttribute("aria-live")).toBe("polite")
      expect(cardElement()?.contains(document.activeElement) ?? false).toBe(false)
    })

    it("leaves nothing to browse while it waits, and does not announce again on its return", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(announcer()).toBeInTheDocument()
      await page.getByRole("button", { name: "Enter Zen mode" }).click()
      await expect.element(card()).not.toBeInTheDocument()
      await expect.element(announcer()).not.toBeInTheDocument()
      await dock().getByRole("button", { name: "Show Zen controls" }).click()
      await dock().getByRole("button", { name: "Exit Zen" }).click()
      await expect.element(card()).toBeVisible()
      await expectStaysAbsent(announcer())
    })

    it("leaves typing in a terminal alone", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      await terminalTab("Checkout review").click()
      await expect.element(commandInput("Checkout review")).toHaveFocus()
      await press("echo hi")
      expect(cardElement()?.contains(document.activeElement) ?? false).toBe(false)
      await expect.element(card()).toBeVisible()
    })

    it("opens the release page from the link and stays", async () => {
      await openWorkspace("/?update=whatsNew")
      await releaseNotes().click()
      expect(whatsNewCalls()).toEqual({ dismissed: 0, pages: 1 })
      await expect.element(card()).toBeVisible()
    })

    it("is dismissed by the ×, which tells the host once", async () => {
      await openWorkspace("/?update=whatsNew")
      await closeButton().click()
      await expect.element(card()).not.toBeInTheDocument()
      expect(whatsNewCalls()).toEqual({ dismissed: 1, pages: 0 })
      await expectStaysAbsent(card())
      expect(whatsNewCalls().dismissed).toBe(1)
    })

    it("is reached with the keyboard", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      // From the footer's start, Tab gets to the card's controls: × first, then the
      // highlights when they scroll, then the link.
      document.querySelector<HTMLElement>("footer")?.setAttribute("tabindex", "-1")
      document.querySelector<HTMLElement>("footer")?.focus()
      await expect
        .poll(async () => {
          await press("{Tab}")
          return cardElement()?.contains(document.activeElement) ?? false
        }, slow)
        .toBe(true)
      const reached = new Set<string>()
      for (let step = 0; step < 4; step += 1) {
        reached.add(
          document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent ??
            "",
        )
        // eslint-disable-next-line no-await-in-loop -- Each Tab starts from where the last stopped.
        await press("{Tab}")
      }
      expect(reached.has("Dismiss")).toBe(true)
      expect(reached.has("Release notes ↗")).toBe(true)
    })

    it("waits out Zen mode with the footer, and is there after", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      await page.getByRole("button", { name: "Enter Zen mode" }).click()
      await expect.element(card()).not.toBeInTheDocument()
      expect(cardElement()).toBeNull()
      expect(whatsNewCalls().dismissed).toBe(0)
      await dock().getByRole("button", { name: "Show Zen controls" }).click()
      await dock().getByRole("button", { name: "Exit Zen" }).click()
      await expect.element(card()).toBeVisible()
    })

    it("gives Escape from inside it back to the terminal, leaving it up", async () => {
      await openWorkspace("/?update=whatsNew")
      await terminalTab("Checkout review").click()
      await expect.element(commandInput("Checkout review")).toHaveFocus()
      closeButton().element().focus()
      await expect.element(closeButton()).toHaveFocus()
      await press("{Escape}")
      await expect.element(commandInput("Checkout review")).toHaveFocus()
      await expect.element(card()).toBeVisible()
      expect(whatsNewCalls().dismissed).toBe(0)
    })

    it("waits for a download's bar, and returns once the bar has faded", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      startDownload("0.0.81")
      await expect.element(page.getByText("Updating Novadeck")).toBeVisible()
      await expect.element(card()).not.toBeInTheDocument()
      await expect.element(page.getByText("Update ready"), slow).toBeVisible()
      expect(cardElement()).toBeNull()
      await expect.element(page.getByText("Update ready"), slow).not.toBeInTheDocument()
      await expect.element(card()).toBeVisible()
      await closeButton().click()
      await expect.element(card()).not.toBeInTheDocument()
      expect(whatsNewCalls()).toEqual({ dismissed: 1, pages: 0 })
    })

    it("keeps to the room between the header and the footer, scrolling its highlights", async () => {
      await page.viewport(1280, 520)
      try {
        await openWorkspace("/?update=whatsNewLong")
        await expect.element(card()).toBeVisible()
        const box = card().element().getBoundingClientRect()
        const header = document.querySelector("header")?.getBoundingClientRect()
        expect(box.top).toBeGreaterThanOrEqual(header?.bottom ?? 0)
        await expect.element(closeButton()).toBeVisible()
        await expect.element(releaseNotes()).toBeVisible()
        const list = card().element().querySelector(".whats-new-list")!
        expect(list.scrollHeight).toBeGreaterThan(list.clientHeight)
        // Only a list that scrolls is a Tab stop.
        await expect.poll(() => list.getAttribute("tabindex")).toBe("0")
      } finally {
        await page.viewport(1440, 900)
      }
    })

    it("hands focus to the terminal when a download's bar takes the card's place", async () => {
      await openWorkspace("/?update=whatsNew")
      await terminalTab("Checkout review").click()
      closeButton().element().focus()
      await expect.element(closeButton()).toHaveFocus()
      startDownload("0.0.81")
      await expect.element(card()).not.toBeInTheDocument()
      await expect.element(commandInput("Checkout review")).toHaveFocus()
    })

    it("still hands focus back when the footer re-renders within the frame", async () => {
      await openWorkspace("/?update=whatsNew")
      await terminalTab("Checkout review").click()
      closeButton().element().focus()
      await expect.element(closeButton()).toHaveFocus()
      startDownload("0.0.81")
      // Progress arrives faster than a frame, so the footer renders again while the card's
      // focus is still being handed back.
      let percent = 0
      const timer = setInterval(() => reportProgress("0.0.81", Math.min((percent += 1), 99)), 3)
      try {
        await expect.element(commandInput("Checkout review")).toHaveFocus()
      } finally {
        clearInterval(timer)
      }
    })

    it("keeps a short list out of the Tab order", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      const list = card().element().querySelector(".whats-new-list")!
      expect(list.scrollHeight).toBeLessThanOrEqual(list.clientHeight)
      expect(list.hasAttribute("tabindex")).toBe(false)
    })

    it("waits while a dialog is open, and returns once it closes", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      await pressShortcut("find")
      await expect.element(findDialog()).toBeVisible()
      await expect.element(card()).not.toBeInTheDocument()
      await press("{Escape}")
      await expect.element(findDialog()).not.toBeInTheDocument()
      await expect.element(card()).toBeVisible()
    })

    it("waits while a portable copy's card is open, and returns once it is dismissed", async () => {
      await openWorkspace("/?update=whatsNew&portable=no-release")
      const portable = page.getByRole("region", { name: "Portable copy" })
      await expect.element(portable).toBeVisible()
      await expect.element(card()).not.toBeInTheDocument()
      await portable.getByRole("button", { name: "Dismiss" }).click()
      await expect.element(portable).not.toBeInTheDocument()
      await expect.element(card()).toBeVisible()
    })

    it("is dismissed by Enter on the ×, and focus goes to the terminal", async () => {
      await openWorkspace("/?update=whatsNew")
      await terminalTab("Checkout review").click()
      closeButton().element().focus()
      await expect.element(closeButton()).toHaveFocus()
      await press("{Enter}")
      await expect.element(card()).not.toBeInTheDocument()
      expect(whatsNewCalls().dismissed).toBe(1)
      await expect.element(commandInput("Checkout review")).toHaveFocus()
    })

    it("gives the corner to the sandbox notice while that is open, and comes back", async () => {
      await openWorkspace("/?update=whatsNew&sandbox=off")
      await expect.element(card()).toBeVisible()
      await page.getByRole("button", { name: /^No sandbox:/ }).click()
      await expect.element(sandboxNotice()).toBeVisible()
      await expect.element(card()).not.toBeInTheDocument()
      await press("{Escape}")
      await expect.element(sandboxNotice()).not.toBeInTheDocument()
      await expect.element(card()).toBeVisible()
    })
  })

  it("shows the host's text as text, never as markup", async () => {
    await openWorkspace("/?update=whatsNewMarkup")
    await expect.element(card()).toBeVisible()
    await expect.element(card().getByText("Bold <b>words</b> and **stars**")).toBeVisible()
    await expect
      .element(card().getByText("A [link](https://example.com) and <i>tags</i>."))
      .toBeVisible()
    expect(card().element().querySelector("i, a, strong, em")).toBeNull()
    expect(card().element().querySelectorAll("b")).toHaveLength(1)
  })
})
