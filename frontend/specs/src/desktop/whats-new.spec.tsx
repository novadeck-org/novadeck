import { onTestFinished } from "vitest"
import { page, type Locator } from "vitest/browser"

import {
  headsUpDismissals,
  reportProgress,
  startDownload,
  whatsNewAsked,
  whatsNewCalls,
} from "../support/backend"
import { findDialog, pressShortcut } from "../support/keyboard"
import {
  commandInput,
  expectStaysAbsent,
  openWorkspace,
  press,
  terminalTab,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// The card is a region named by its label, which the CSS sets in capitals.
const card = (): Locator => page.getByRole("region", { name: /New in Novadeck/ })
const closeButton = (): Locator => card().getByRole("button", { name: "Dismiss" })
// The icons are Lucide's, each an svg classed by its name.
const iconsOf = (): (string | undefined)[] =>
  [...card().element().querySelectorAll(".whats-new-list li")].map((row) =>
    [...(row.querySelector("svg")?.classList ?? [])].find((name) => name.startsWith("lucide-")),
  )
const announcer = () => page.getByRole("status").filter({ hasText: /New in Novadeck/ })
const sandboxNotice = (): Locator =>
  page.getByRole("region", { name: "Novadeck is running without its security sandbox" })
const dock = () => page.getByRole("group", { name: "Zen controls" })
// A demo download takes 3 seconds, then its finished bar stays 4 more before it fades.
const slow = { timeout: 12_000 }
const cardElement = (): Element | null => document.querySelector(".whats-new")

describe("the what's-new card", () => {
  it("is absent where the app has no word of it", async () => {
    await openWorkspace()
    await expectStaysAbsent(card())
    expect(cardElement()).toBeNull()
  })

  it("is absent when the app answers that there is nothing to show", async () => {
    await openWorkspace("/?update=noHighlights")
    // The app takes 1.5 s to say so: the page has asked, and shows nothing once it has.
    await expect.poll(whatsNewAsked).toBeGreaterThan(0)
    await expectStaysAbsent(card(), { ms: 2_500 })
    expect(cardElement()).toBeNull()
    expect(whatsNewCalls()).toEqual({ dismissed: 0 })
  })

  context("after an update with highlights", () => {
    it("lists each as a title with its line, led by its icon", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      await expect.element(card().getByText("New in Novadeck 0.0.80")).toBeVisible()
      await expect.element(card().getByText("Word handles for terminals")).toBeVisible()
      await expect.element(card().getByText('Talk to @moth instead of "terminal 3".')).toBeVisible()
      await expect.element(card().getByText("Plans open beside the terminal")).toBeVisible()
      await expect.element(card().getByText("Answer agents from the Inbox")).toBeVisible()
      // Nothing about restarting: this card is not the download's, and it has no link out.
      expect(card().element().textContent).not.toMatch(/restart|install/i)
      expect(card().element().querySelectorAll("button")).toHaveLength(1)
      expect(iconsOf()).toEqual(["lucide-users", "lucide-panel-right", "lucide-inbox"])
      for (const svg of card().element().querySelectorAll(".whats-new-list svg"))
        expect(svg.getAttribute("aria-hidden")).toBe("true")
    })

    it("names the version it is new since beside the ×, when the app knows it", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card().getByText("From 0.0.79")).toBeVisible()
    })

    it("leads a highlight that names no icon with a sparkle, so the rows line up", async () => {
      await openWorkspace("/?update=whatsNewMarkup")
      await expect.element(card()).toBeVisible()
      expect(iconsOf()).toEqual(["lucide-sparkles"])
      // This app doesn't know the version updated from, so the card names none.
      expect(card().element().textContent).not.toMatch(/From/)
    })

    it("sets each icon's tile level with its title's top, in a column of its own", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      const rows = [...card().element().querySelectorAll(".whats-new-list li")]
      const lefts = rows.map((row) => row.querySelector("svg")!.getBoundingClientRect().left)
      expect(new Set(lefts).size).toBe(1)
      for (const row of rows) {
        const tile = row.querySelector(".whats-new-icon")!.getBoundingClientRect()
        const title = row.querySelector(".whats-new-title")!.getBoundingClientRect()
        expect(tile.right).toBeLessThanOrEqual(title.left)
        // A title of two lines still has its tile beside the first.
        expect(Math.abs(tile.top - title.top)).toBeLessThan(2)
      }
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

    it("is dismissed by the ×, which tells the app once", async () => {
      await openWorkspace("/?update=whatsNew")
      await closeButton().click()
      await expect.element(card()).not.toBeInTheDocument()
      expect(whatsNewCalls()).toEqual({ dismissed: 1 })
      await expectStaysAbsent(card())
      expect(whatsNewCalls().dismissed).toBe(1)
    })

    it("is reached with the keyboard", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      // From the footer's start, Tab gets to the card's controls: × first, then the
      // highlights when they scroll.
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
    })

    it("waits out Zen mode with the footer, and is there after", async () => {
      await openWorkspace("/?update=whatsNew")
      await expect.element(card()).toBeVisible()
      await page.getByRole("button", { name: "Enter Zen mode" }).click()
      await expect.element(card()).not.toBeInTheDocument()
      expect(cardElement()).toBeNull()
      expect(whatsNewCalls().dismissed).toBe(0)
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
      expect(whatsNewCalls()).toEqual({ dismissed: 1 })
    })

    it("keeps to the room between the header and the footer, scrolling its highlights", async () => {
      await page.viewport(1280, 520)
      onTestFinished(() => page.viewport(1440, 900))
      await openWorkspace("/?update=whatsNewLong")
      await expect.element(card()).toBeVisible()
      const box = card().element().getBoundingClientRect()
      const header = document.querySelector("header")?.getBoundingClientRect()
      expect(box.top).toBeGreaterThanOrEqual(header?.bottom ?? 0)
      await expect.element(closeButton()).toBeVisible()
      const list = card().element().querySelector(".whats-new-list")!
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight)
      // Only a list that scrolls is a Tab stop.
      await expect.poll(() => list.getAttribute("tabindex")).toBe("0")
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
      // The notice takes focus a frame after it shows, and only then does Escape reach it.
      await expect.element(sandboxNotice()).toHaveFocus()
      await press("{Escape}")
      await expect.element(sandboxNotice()).not.toBeInTheDocument()
      await expect.element(card()).toBeVisible()
    })
  })

  it("shows the app's text as text, never as markup", async () => {
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

describe("the heads-up card", () => {
  const headsUp = (): Locator => page.getByRole("region", { name: /Heads up in Novadeck/ })
  const gotIt = (): Locator => headsUp().getByRole("button", { name: "Got it" })
  const dismiss = (): Locator => headsUp().getByRole("button", { name: "Dismiss" })
  const tell = (): Locator => headsUp().getByRole("button", { name: "Bad call? Tell us" })
  const news = (): Locator => page.getByRole("region", { name: /New in Novadeck/ })
  const feedbackBox = (): Locator => page.getByRole("textbox", { name: "Your feedback" })
  const announced = () => page.getByRole("status").filter({ hasText: /Heads up in Novadeck/ })
  const headsUpElement = (): Element | null => document.querySelector(".whats-new.heads-up")

  it("comes first, ahead of the highlights, with its items and no From stamp", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await expect.element(headsUp()).toBeVisible()
    await expect.element(headsUp().getByText("Heads up in Novadeck 0.0.80")).toBeVisible()
    await expect.element(headsUp().getByText("Canvas arranges itself")).toBeVisible()
    await expect
      .element(
        headsUp().getByText(
          "Programs no longer get Ctrl+V, so vim's block select won't start with it.",
        ),
      )
      .toBeVisible()
    await expect.element(headsUp().getByText("Ctrl+V pastes on Linux")).toBeVisible()
    expect(
      [...headsUpElement()!.querySelectorAll(".whats-new-list li")].map((row) =>
        [...(row.querySelector("svg")?.classList ?? [])].find((name) => name.startsWith("lucide-")),
      ),
    ).toEqual(["lucide-layout-grid", "lucide-keyboard"])
    expect(headsUp().element().textContent).not.toMatch(/From/)
    await expect.element(news()).not.toBeInTheDocument()
    expect(document.querySelectorAll(".whats-new")).toHaveLength(1)
  })

  it("is announced once, politely, and never takes focus", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await expect.element(headsUp()).toBeVisible()
    await expect
      .element(announced())
      .toHaveTextContent(
        "Heads up in Novadeck 0.0.80: Canvas arranges itself, Ctrl+V pastes on Linux",
      )
    expect(announced().element().getAttribute("aria-live")).toBe("polite")
    expect(headsUpElement()?.contains(document.activeElement) ?? false).toBe(false)
  })

  it("wears the warning colours on its tape and tiles", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await expect.element(headsUp()).toBeVisible()
    const tape = getComputedStyle(headsUpElement()!.querySelector(".whats-new-tape")!)
    const tile = getComputedStyle(headsUpElement()!.querySelector(".whats-new-icon")!)
    const warning = getComputedStyle(document.documentElement).getPropertyValue("--color-warning")
    expect(warning).not.toBe("")
    const probe = document.createElement("span")
    probe.style.backgroundColor = warning
    document.body.append(probe)
    const expected = getComputedStyle(probe).backgroundColor
    probe.remove()
    expect(tape.backgroundColor).toBe(expected)
    expect(tile.backgroundColor).toBe(expected)
  })

  it("hands the corner to the highlights at once when Got it is pressed, telling the app once", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await gotIt().click()
    await expect.element(headsUp()).not.toBeInTheDocument()
    await expect.element(news()).toBeVisible()
    await expect.element(news().getByText("Word handles for terminals")).toBeVisible()
    expect(headsUpDismissals()).toBe(1)
    expect(whatsNewCalls()).toEqual({ dismissed: 0 })
    await expectStaysAbsent(headsUp())
    // The highlights are announced as their own card.
    await expect
      .element(announcer())
      .toHaveTextContent(
        "New in Novadeck 0.0.80: Word handles for terminals, Plans open beside the terminal, Answer agents from the Inbox",
      )
    await closeButton().click()
    await expect.element(news()).not.toBeInTheDocument()
    expect(whatsNewCalls()).toEqual({ dismissed: 1 })
  })

  it("does the same when its × is pressed", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await dismiss().click()
    await expect.element(headsUp()).not.toBeInTheDocument()
    await expect.element(news()).toBeVisible()
    expect(headsUpDismissals()).toBe(1)
    expect(whatsNewCalls()).toEqual({ dismissed: 0 })
  })

  it("settles the whole version when it is all there is", async () => {
    await openWorkspace("/?update=headsUpAlone")
    await expect.element(headsUp()).toBeVisible()
    await gotIt().click()
    await expect.element(headsUp()).not.toBeInTheDocument()
    await expectStaysAbsent(news())
    expect(headsUpDismissals()).toBe(1)
    expect(whatsNewCalls()).toEqual({ dismissed: 1 })
  })

  it("opens the feedback card with Idea picked, waits while it is open, and is back after", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await expect.element(tell()).toBeVisible()
    await tell().click()
    await expect.element(feedbackBox()).toBeVisible()
    await expect.element(page.getByRole("radio", { name: "Idea" })).toBeChecked()
    await expect.element(page.getByText(/^About the Heads-up in /)).toBeVisible()
    await expect.element(headsUp()).not.toBeInTheDocument()
    // Opening it dismisses nothing and tells the app nothing.
    expect(headsUpDismissals()).toBe(0)
    expect(whatsNewCalls()).toEqual({ dismissed: 0 })
    await press("{Escape}")
    await expect.element(feedbackBox()).not.toBeInTheDocument()
    await expect.element(headsUp()).toBeVisible()
    await expect.element(gotIt()).toBeVisible()
    expect(headsUpDismissals()).toBe(0)
    // It is not announced again on its return.
    await expectStaysAbsent(announced())
  })

  it("keeps what the person wrote in the feedback card, and does not pick over it", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await page.getByRole("button", { name: "Feedback", exact: true }).click()
    await expect.element(feedbackBox()).toBeVisible()
    await page.getByRole("radio", { name: "Bug" }).click({ force: true })
    await feedbackBox().fill("a note")
    await press("{Escape}")
    await expect.element(headsUp()).toBeVisible()
    await tell().click()
    await expect.element(feedbackBox()).toHaveValue("a note")
    await expect.element(page.getByRole("radio", { name: "Bug" })).toBeChecked()
  })

  it("has no feedback hint where the backend takes no feedback", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp&feedback=off")
    await expect.element(headsUp()).toBeVisible()
    await expect.element(gotIt()).toBeVisible()
    expect(headsUp().element().textContent).not.toMatch(/Tell us/)
    expect(headsUp().element().querySelectorAll("button")).toHaveLength(2)
  })

  it("is reached with the keyboard, Got it among its buttons", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await expect.element(headsUp()).toBeVisible()
    document.querySelector<HTMLElement>("footer")?.setAttribute("tabindex", "-1")
    document.querySelector<HTMLElement>("footer")?.focus()
    await expect
      .poll(async () => {
        await press("{Tab}")
        return headsUpElement()?.contains(document.activeElement) ?? false
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
    expect(reached.has("Got it")).toBe(true)
    expect(reached.has("Bad call? Tell us")).toBe(true)
  })

  it("gives Escape from inside it back to the terminal, leaving it up", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await terminalTab("Checkout review").click()
    await expect.element(commandInput("Checkout review")).toHaveFocus()
    gotIt().element().focus()
    await expect.element(gotIt()).toHaveFocus()
    await press("{Escape}")
    await expect.element(commandInput("Checkout review")).toHaveFocus()
    await expect.element(headsUp()).toBeVisible()
    expect(headsUpDismissals()).toBe(0)
  })

  it("hands focus to the terminal when Got it is pressed from the keyboard", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await terminalTab("Checkout review").click()
    gotIt().element().focus()
    await press("{Enter}")
    await expect.element(headsUp()).not.toBeInTheDocument()
    await expect.element(news()).toBeVisible()
    await expect.element(commandInput("Checkout review")).toHaveFocus()
  })

  it("leaves typing in a terminal alone", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await expect.element(headsUp()).toBeVisible()
    await terminalTab("Checkout review").click()
    await press("echo hi")
    expect(headsUpElement()?.contains(document.activeElement) ?? false).toBe(false)
    await expect.element(headsUp()).toBeVisible()
  })

  it("waits out Zen mode with the footer, and is there after without a second announcement", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await expect.element(announced()).toBeInTheDocument()
    await page.getByRole("button", { name: "Enter Zen mode" }).click()
    await expect.element(headsUp()).not.toBeInTheDocument()
    await expect.element(announced()).not.toBeInTheDocument()
    await dock().getByRole("button", { name: "Exit Zen" }).click()
    await expect.element(headsUp()).toBeVisible()
    await expectStaysAbsent(announced())
    expect(headsUpDismissals()).toBe(0)
  })

  it("waits for a download's bar, and returns once the bar has faded", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await expect.element(headsUp()).toBeVisible()
    startDownload("0.0.81")
    await expect.element(page.getByText("Updating Novadeck")).toBeVisible()
    await expect.element(headsUp()).not.toBeInTheDocument()
    await expect.element(page.getByText("Update ready"), slow).not.toBeInTheDocument()
    await expect.element(headsUp()).toBeVisible()
  })

  it("waits while a dialog is open, and returns once it closes", async () => {
    await openWorkspace("/?update=whatsNewHeadsUp")
    await expect.element(headsUp()).toBeVisible()
    await pressShortcut("find")
    await expect.element(findDialog()).toBeVisible()
    await expect.element(headsUp()).not.toBeInTheDocument()
    await press("{Escape}")
    await expect.element(findDialog()).not.toBeInTheDocument()
    await expect.element(headsUp()).toBeVisible()
  })
})

describe("a portable copy's changelog with heads-ups", () => {
  it("lists them above the highlights under a Heads up label, in one card", async () => {
    await openWorkspace("/?portable=update-heads-up")
    const portable = page.getByRole("region", { name: /New in Novadeck/ })
    await expect.element(portable).toBeVisible()
    await expect.element(portable.getByText("Heads up", { exact: true })).toBeVisible()
    const rows = [...portable.element().querySelectorAll(".whats-new-list li")].map(
      (row) => row.textContent,
    )
    expect(rows[0]).toBe("Heads up")
    expect(rows[1]).toContain("Canvas arranges itself")
    expect(rows[2]).toContain("Ctrl+V pastes on Linux")
    expect(rows[3]).toContain("Word handles for terminals")
    expect(document.querySelectorAll(".whats-new")).toHaveLength(1)
    expect(portable.element().querySelectorAll(".whats-new-list li.heads-up")).toHaveLength(2)
  })
})
