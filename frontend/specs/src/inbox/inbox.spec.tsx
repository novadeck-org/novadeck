import { afterEach, beforeEach } from "vitest"
import { page, userEvent } from "vitest/browser"

import { desktopWindow } from "../support/backend"
import { openConversation, openMessages } from "../support/messages"
import {
  expectStaysAbsent,
  openWorkspace,
  sidebarPanel,
  tabDescription,
  terminal,
  terminalTab,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// The Inbox demo: the agents demo with an Inbox of hardcoded entries across its projects, one
// of each kind, waiting on the person, over what its own agents wait on: api-service's plan and
// permission, and, a moment after it opens, infra's failed turn and design-system's done report.
const inbox = "/?demo=inbox"

// These demos read their agents' conversations with the chat view off, so the footer would offer
// Agent Chat, in a live region and a card these specs don't look at: answered.
beforeEach(() => localStorage.setItem("novadeck.agent-chat-offer-answered", "true"))

const openInbox = async (route = inbox): Promise<void> => {
  await openWorkspace(route)
  await sidebarPanel("Inbox").click()
}

// Moves off the terminal the demo opens on, which the preview ask comes from, and back to the
// Inbox: where these specs start.
const lookAway = async (): Promise<void> => {
  await sidebarPanel("Terminals").click()
  await terminalTab("Checkout review").click()
  await sidebarPanel("Inbox").click()
}

// What the Inbox demo holds once it has settled: the 12 that wait, the preview ask, and the demo
// agents' done reports.
const settledRows = 15

const rows = () =>
  page.getByRole("list", { name: "Messages from your agents" }).getByRole("listitem")
// A row's own button, by its words: not the buttons beside it that name it too (Dismiss,
// Snooze, Unsnooze).
const row = (subject: RegExp | string) => {
  const words = typeof subject === "string" ? new RegExp(subject) : subject
  return page.getByRole("list", { name: "Messages from your agents" }).getByRole("button", {
    name: new RegExp(`^(?!(?:Dismiss|Snooze|Unsnooze): ).*(?:${words.source})`, words.flags),
  })
}
const sheet = (title: string) => page.getByRole("dialog", { name: title })
const confirmation = () => page.getByRole("status").filter({ hasText: /\w/ })
// A row of an open sheet's numbered menu, by its words: a button, as the chat's rows are.
const answer = (open: ReturnType<typeof sheet>, name: RegExp | string) =>
  open.getByRole("button", { name })
// The open sheet's card, once it stands still: the agent's context over it comes in late and
// moves it, and a click on it is held back for a moment after it moved, as aimed at where a
// row was.
const cardStill = async (): Promise<void> => {
  const top = () =>
    document.querySelector(".inbox-sheet .request-card")?.getBoundingClientRect().top
  let last: number | undefined = Number.NaN
  await expect
    .poll(
      async () => {
        const before = last
        last = top()
        await new Promise((resolve) => setTimeout(resolve, 450))
        return before === last && top() === last
      },
      { timeout: 10_000, interval: 0 },
    )
    .toBe(true)
}
// The agent's context on an open sheet: your last words and its latest steps.
const whereItWas = (open: ReturnType<typeof sheet>) =>
  open.getByRole("region", { name: "Where it was" })
// Presses a row of an open sheet's menu, as the person would once the card stands still.
const press = async (open: ReturnType<typeof sheet>, name: RegExp | string): Promise<void> => {
  await cardStill()
  await answer(open, name).click()
}
// A row that takes the person's own words: the field in its place, named by the row's words.
const ownWords = (open: ReturnType<typeof sheet>, name: string) =>
  open.getByRole("textbox", { name, exact: true })
afterEach(() => {
  history.replaceState(null, "", "/")
})

describe("The Inbox on the rail", () => {
  it("counts what isn't an update", async () => {
    await openWorkspace(inbox)
    await terminalTab("Checkout review").click()

    await expect.element(sidebarPanel("Inbox")).toHaveAccessibleName("Inbox, 12 waiting")
  })
})

describe("The agents demo's Inbox", () => {
  it("lists what its agents wait on, and an answer there moves the agent on", async () => {
    await openWorkspace("/?demo=agents")
    await expect.poll(() => tabDescription("Checkout review") ?? "").toContain("Needs permission")
    await sidebarPanel("Inbox").click()
    await expect.element(row("Approve the plan?").first()).toBeVisible()
    await expect.element(row("Which approach should I take?")).toBeVisible()

    await row("Run pnpm test").click()
    await press(sheet("Checkout review"), "Yes, proceed")

    await expect.element(confirmation()).toMatchTextContent("Allowed @crow's command.")
    await sidebarPanel("Terminals").click()
    await expect.poll(() => tabDescription("Checkout review") ?? "").not.toContain("Needs")
  })
})

describe("The Inbox's list", () => {
  it("lists one row for each entry, the newest first, with no lines between them", async () => {
    await openInbox()
    await lookAway()

    await expect.element(rows()).toHaveLength(settledRows)
    await expect
      .element(rows().filter({ hasText: "Seems stuck" }))
      .toMatchTextContent(/Seems stuck: the same failure 3 times[\s\S]*api-service[\s\S]*7m/)
    // Newest first: the held message (3m) before the stuck agent (7m) before the login (11m).
    const order = (): string[] =>
      Array.from(document.querySelectorAll("[data-inbox-row]")).map(
        (each) => each.textContent ?? "",
      )
    const at = (words: string): number => order().findIndex((each) => each.includes(words))
    expect(at("Release a held message")).toBeLessThan(at("Seems stuck"))
    expect(at("Seems stuck")).toBeLessThan(at("vercel login"))
    // Open and resolved rows share the list, and nothing divides them.
    expect(
      document.querySelector("[data-updates-start], [data-settled-start], .inbox-rule"),
    ).toBeNull()
  })

  it("draws each kind with its own icon, tinted by what it wants of the person", async () => {
    await openInbox()
    await lookAway()
    const tint = (words: string): string | null =>
      rows().filter({ hasText: words }).element().getAttribute("data-tint")

    expect(tint("Run pnpm add")).toBe("attention")
    expect(tint("Release a held message")).toBe("attention")
    expect(tint("Hit Claude")).toBe("note")
    expect(tint("Seems stuck")).toBe("danger")
    expect(tint("Search index rebuilt")).toBe("success")
    expect(tint("Heads-up")).toBe("ink")
    // One icon per kind: the permission and the plan differ, and so do a question and a login.
    const icon = (words: string): string =>
      rows()
        .filter({ hasText: words })
        .element()
        .querySelector(".inbox-row-icon svg")!
        .getAttribute("class") ?? ""
    expect(icon("Run pnpm add")).toContain("shield-question")
    expect(icon("Release a held message")).toContain("message-square-lock")
    expect(icon("Hit Claude")).toContain("gauge")
    expect(icon("Search index rebuilt")).toContain("flag")
    expect(icon("Could you run vercel login")).toContain("square-terminal")
  })

  it("says how long an agent has waited only for one that stopped", async () => {
    await openInbox()

    await expect.element(rows().filter({ hasText: "Run pnpm add" })).toMatchTextContent("6m")
    await expect
      .element(rows().filter({ hasText: "vercel login" }))
      .not.toMatchTextContent(/\d+m\b/)
  })

  it("marks a long entry with its reading time and a limit with when it resumes", async () => {
    await openInbox()

    await expect.element(rows().filter({ hasText: "webhooks" })).toMatchTextContent("1 min read")
    await expect
      .element(rows().filter({ hasText: "limit" }))
      .toMatchTextContent(/Resumes at \d\d:\d\d/)
  })
})

describe("An Inbox entry's sheet", () => {
  context("when opening a command permission", () => {
    it("shows the command word for word, beside its row, with the row lifted", async () => {
      await openInbox()
      await row("Run pnpm add").click()

      await expect.element(sheet("Checkout review")).toBeVisible()
      await expect.element(sheet("Checkout review")).toMatchTextContent(/^Command/)
      await expect
        .element(sheet("Checkout review"))
        .toMatchTextContent("pnpm add -D @stripe/stripe-js")
      await expect.element(row("Run pnpm add")).toHaveAttribute("aria-current", "true")
    })

    it("closes on Esc", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await expect.element(sheet("Checkout review")).toBeVisible()
      await userEvent.keyboard("{Escape}")

      await expect.element(sheet("Checkout review")).not.toBeInTheDocument()
    })

    it("closes on its close button", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await sheet("Checkout review").getByRole("button", { name: "Close" }).click()

      await expect.element(sheet("Checkout review")).not.toBeInTheDocument()
    })

    it("closes on a click in the workspace", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await expect.element(sheet("Checkout review")).toBeVisible()
      // Right of the sheet, which sits beside its row and so lies lower while the list is
      // still filling in: a point under it would be a click on the sheet.
      await page
        .getByRole("region", { name: "focus view" })
        .click({ position: { x: 1000, y: 600 } })

      await expect.element(sheet("Checkout review")).not.toBeInTheDocument()
    })

    it("closes when its row is pressed again", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await expect.element(sheet("Checkout review")).toBeVisible()
      await row("Run pnpm add").click()

      await expect.element(sheet("Checkout review")).not.toBeInTheDocument()
      await expect.element(row("Run pnpm add")).not.toHaveAttribute("aria-current")
    })

    it("closes on a click in the sidebar off the list's buttons", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await expect.element(sheet("Checkout review")).toBeVisible()
      await page
        .getByRole("region", { name: /^Inbox/ })
        .getByRole("heading", { name: /^Inbox/ })
        .click()

      await expect.element(sheet("Checkout review")).not.toBeInTheDocument()
    })

    it("stays open on a press on the list's scrollbar", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await expect.element(sheet("Checkout review")).toBeVisible()
      const list = page.getByRole("list", { name: "Messages from your agents" }).element()
      // A list too short to scroll has no scrollbar to press.
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight)
      // The test browser draws no scrollbar, so the press is sent as one lands on it: on the
      // list itself, not on a row.
      for (const type of ["pointerdown", "pointerup", "click"])
        list.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, button: 0 }))

      await expectStaysAbsent({
        shown: () => sheet("Checkout review").query() === null,
        name: "the sheet closing",
      })
    })

    it("moves to another entry when another row is pressed, and with j and k", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await expect.element(sheet("Checkout review")).toBeVisible()

      await row("Which date library").click()
      await expect.element(sheet("Tests")).toBeVisible()
      await expect.element(sheet("Checkout review")).not.toBeInTheDocument()

      // One row down the list, the permission for the edit.
      await userEvent.keyboard("j")
      await expect.element(sheet("Runtime")).toBeVisible()
    })

    it("is reached from its row with the keyboard, and a key pressed twice answers nothing", async () => {
      await openInbox()
      row("Run pnpm add").element().focus()
      await userEvent.keyboard("{Enter}")
      const open = sheet("Checkout review")

      // Opening from the keyboard lands on the sheet's title, not on a button.
      await expect.element(open.getByRole("heading", { name: "Checkout review" })).toHaveFocus()
      await userEvent.keyboard("{Enter}")
      await expectStaysAbsent(confirmation())

      // Past the head's three buttons (Snooze, Show terminal, Close), Tab reaches the agent's
      // context, the tool lines that open as the chat's do, then the card's menu, on its first
      // option, in Codex's own words.
      await userEvent.tab()
      await userEvent.tab()
      await userEvent.tab()
      await userEvent.tab()
      const lines = whereItWas(open).getByRole("button")
      await expect.element(lines.first()).toHaveFocus()
      for (const _ of lines.elements())
        // eslint-disable-next-line no-await-in-loop -- Tab moves one stop at a time.
        await userEvent.tab()
      await expect.element(answer(open, "Yes, proceed")).toHaveFocus()
      await userEvent.keyboard("{Enter}")
      await expect.element(confirmation()).toMatchTextContent("Allowed @crow's command.")
    })

    it("returns from its title to the row on Shift+Tab, as from its first control", async () => {
      await openInbox()
      row("Run pnpm add").element().focus()
      await userEvent.keyboard("{Enter}")
      await expect
        .element(sheet("Checkout review").getByRole("heading", { name: "Checkout review" }))
        .toHaveFocus()

      await userEvent.tab({ shift: true })
      await expect.element(row("Run pnpm add")).toHaveFocus()
      await expect.element(sheet("Checkout review")).toBeVisible()
    })

    it("lets Tab go on past the last row, closing the sheet, rather than looping", async () => {
      await openInbox()
      // The oldest row is the last, and opening a report reads it, which leaves it listed.
      await row("Search index rebuilt").click()
      row("Search index rebuilt").element().focus()
      await userEvent.tab()
      await userEvent.tab()
      await userEvent.tab()

      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument()
      await expect.element(row("Search index rebuilt")).not.toHaveFocus()
    })

    it("follows its row in the tab order, and gives focus back to it", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      row("Run pnpm add").element().focus()
      await userEvent.tab()
      // The sheet's page, from its first control: the agent's context over the card.
      await expect
        .element(whereItWas(sheet("Checkout review")).getByRole("button").first())
        .toHaveFocus()

      await userEvent.tab({ shift: true })
      await expect
        .element(sheet("Checkout review").getByRole("button", { name: "Close" }))
        .toHaveFocus()
      // Back past Show terminal and Snooze.
      await userEvent.tab({ shift: true })
      await userEvent.tab({ shift: true })
      await userEvent.tab({ shift: true })
      await expect.element(row("Run pnpm add")).toHaveFocus()
      await expect.element(sheet("Checkout review")).toBeVisible()
    })

    it("shows the terminal it is about, with the terminals in the sidebar", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await sheet("Checkout review").getByRole("button", { name: "Show terminal" }).click()

      await expect.element(sheet("Checkout review")).not.toBeInTheDocument()
      await expect.element(terminal("Checkout review")).toBeVisible()
      await expect.element(sidebarPanel("Terminals")).toBeChecked()
    })
  })

  context("when allowing a command", () => {
    it("moves on to what asks next, with a receipt, keeping its row answered until the sheet closes", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await press(sheet("Checkout review"), "Yes, proceed")

      // The sheet moves on to what is newest that still waits, with the receipt.
      await expect.element(confirmation()).toMatchTextContent("Allowed @crow's command.")
      await expect.element(sheet("Checkout review")).not.toBeInTheDocument()
      // The answered row stays where it was, resolved, with the answer.
      const answered = rows().filter({ hasText: "Run pnpm add" })
      await expect.element(answered).toHaveAttribute("data-settled", "answered")
      await userEvent.keyboard("{Escape}")
      await expect.element(answered).toHaveAttribute("data-settled", "answered")
      await expect.element(answered).toMatchTextContent("Answered")
    })

    it("answers at once on a number pressed on its row", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await userEvent.keyboard("1")

      await expect.element(confirmation()).toMatchTextContent("Allowed @crow's command.")
    })
  })

  context("when denying a command", () => {
    it("takes the person's words in place of Codex's own option for words, and sends them with it", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      const open = sheet("Checkout review")
      await userEvent.type(ownWords(open, "No, and tell Codex what to do differently"), "Use npm.")
      await userEvent.keyboard("{Enter}")

      await expect
        .element(confirmation())
        .toMatchTextContent("Denied @crow's command, with your words.")
    })
  })

  context("when sending a plan back", () => {
    it("takes the person's words in place of Claude's own option for them", async () => {
      await openInbox("/?demo=agents")
      // storefront's plan waits on the terminal the demo opens on, which may hold it back.
      await lookAway()
      await row(/Approve the plan\?.*storefront/).click()
      const open = page.getByRole("dialog")
      await userEvent.type(
        ownWords(open, "No, and tell Claude what to change"),
        "Add a rollback step.",
      )
      await userEvent.keyboard("{Enter}")

      await expect
        .element(confirmation())
        .toMatchTextContent(/Sent back @\w+'s plan, with your words\./)
    })
  })

  context("when a prompt can't be answered from here", () => {
    it("shows it verbatim and offers only the way to the terminal", async () => {
      await openInbox()
      await row("Edit src/cart/CartSummary.tsx").click()
      const open = sheet("Runtime")

      await expect
        .element(open)
        .toMatchTextContent("Do you want to make this edit to CartSummary.tsx?")
      await expect
        .element(open)
        .toMatchTextContent("Novadeck can't answer this dialog. Answer it in the terminal.")
      // As the chat's card: no menu, and the key to the terminal in its head.
      await expect.element(open.getByRole("group", { name: "Answers" })).not.toBeInTheDocument()
      await cardStill()
      await open.getByRole("button", { name: "Answer in terminal" }).click()

      await expect.element(open).not.toBeInTheDocument()
      await expect.element(terminal("Runtime")).toBeVisible()
      await expect.element(sidebarPanel("Terminals")).toBeChecked()
    })
  })

  context("when an agent asks with options", () => {
    it("numbers them with its pick, and takes a hard-to-undo one on a second press", async () => {
      await openInbox()
      await row("How should failed payment webhooks retry").click()
      const open = sheet("Dev server")

      await expect.element(open).toMatchTextContent("Hard to undo: This sets the database schema")
      await expect.element(open.getByText("its pick")).toBeVisible()
      await press(open, /Our own retries/)
      await expect.element(answer(open, /Our own retries/)).toMatchTextContent("↵ again to send it")
      await expectStaysAbsent(confirmation())
      await press(open, /Our own retries/)

      await expect.element(confirmation()).toMatchTextContent("Reply queued for @fox.")
    })

    it("keeps a reply it has not sent as a draft on the row", async () => {
      await openInbox()
      // The list is still filling in, and a row that lands above this one moves its sheet
      // under the pointer partway through; typing waits for it to have settled.
      await lookAway()
      await expect.element(rows()).toHaveLength(settledRows)
      await row("How should failed payment webhooks retry").click()
      const open = sheet("Dev server")
      // The row is the field, typed into in place.
      const box = ownWords(open, "Reply in your own words")
      await userEvent.type(box, "Let me think")
      await userEvent.keyboard("{Escape}")
      await userEvent.keyboard("{Escape}")

      await expect.element(rows().filter({ hasText: "webhooks" })).toMatchTextContent("Draft")
    })
  })

  context("when a reply fails", () => {
    it("keeps the sheet and says why, and shows no receipt", async () => {
      await openInbox(`${inbox}&inboxAnswer=failed`)
      await row("How should failed payment webhooks retry").click()
      const open = sheet("Dev server")
      await press(open, /Our own retries/)
      await press(open, /Our own retries/)
      await expect.element(open.getByRole("alert")).toMatchTextContent("Try again")
      await expectStaysAbsent(confirmation())
      await press(open, /Our own retries/)
      await press(open, /Our own retries/)
      await expect.element(confirmation()).toMatchTextContent("Reply queued for @fox.")
    })

    it("says a stale ask is no longer available, keeping the words", async () => {
      await openInbox(`${inbox}&inboxAnswer=stale`)
      await lookAway()
      await row("Should the preview show test or sample products").click()
      const open = sheet("Checkout implementation")
      const box = ownWords(open, "Reply")
      await userEvent.type(box, "Samples.")
      await userEvent.keyboard("{Enter}")
      await expect
        .element(open.getByRole("alert"))
        .toMatchTextContent("That ask is no longer available.")
      await expect.element(box).toHaveValue("Samples.")
      await expectStaysAbsent(confirmation())
    })
  })

  context("when looking at Inbox history", () => {
    it("shows the ask and the person's reply in the conversation named You", async () => {
      await openInbox()
      await lookAway()
      await row("Should the preview show test or sample products").click()
      const open = sheet("Checkout implementation")
      await userEvent.type(ownWords(open, "Reply"), "Sample products.")
      await userEvent.keyboard("{Enter}")
      await expect.element(confirmation()).toMatchTextContent("Reply queued for @moth.")
      await userEvent.keyboard("{Escape}")
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument()
      await sidebarPanel("Terminals").click()
      const pane = await openMessages("Checkout implementation")
      const history = await openConversation(pane, "You")
      await expect.element(history).toMatchTextContent("Asked you · answered")
      await expect
        .element(history)
        .toMatchTextContent("Should the preview show test or sample products?")
      await expect.element(history).toMatchTextContent("Sample products.")
      await expect.element(history).not.toMatchTextContent("@you")
    })
  })

  context("when an agent's own question is on screen", () => {
    it("asks it as the chat does: a page of its options, in the agent's own words", async () => {
      await openInbox()
      await row("Which date library").click()
      const open = sheet("Tests")

      // A question of one pick is a page of options to pick from, the agent's mark kept.
      await expect.element(open.getByRole("tab", { name: "Dates", selected: true })).toBeVisible()
      await expect
        .element(open.getByRole("radio", { name: "date-fns (Recommended)" }))
        .not.toBeChecked()
      await expect.element(open.getByRole("textbox", { name: /^Other: / })).toBeInTheDocument()
    })
  })

  context("when Novadeck holds a message", () => {
    it("shows who wrote to whom, and releases it", async () => {
      await openInbox()
      await row("Release a held message").click()
      const open = sheet("Tests")

      await expect
        .element(open)
        .toMatchTextContent(
          "@owl and @moth kept messaging while neither did any work, so Novadeck holds their thread.",
        )
      await press(open, /^Release/)

      await expect.element(confirmation()).toMatchTextContent("Released @owl's message to @moth.")
    })
  })

  context("when an agent is stuck", () => {
    it("shows exactly what Nudge sends, and lets the person write their own", async () => {
      await openInbox()
      await row("Seems stuck").click()
      const open = sheet("Runtime")

      await expect.element(open).toMatchTextContent("×3")
      await expect.element(open).toMatchTextContent("You've hit the same failure 3 times.")
      await userEvent.type(ownWords(open, "Nudge it in your own words"), "Read the test first.")
      await userEvent.keyboard("{Enter}")

      await expect.element(confirmation()).toMatchTextContent("Nudged @kite with your words.")
    })
  })

  context("when an agent hits a limit", () => {
    it("offers only the auto-resume switch, which stays on the entry", async () => {
      await openInbox()
      await row("Hit Claude's 5-hour limit").click()
      const open = sheet("Build")
      const resume = open.getByRole("checkbox", { name: /Resume automatically at/ })

      await expect.element(resume).toBeChecked()
      await cardStill()
      await resume.click()
      await expect.element(resume).not.toBeChecked()
      await expect.element(row("Hit Claude's 5-hour limit")).toBeVisible()
    })
  })

  context("when an agent asks while working", () => {
    it("takes a reply without claiming the agent resumed", async () => {
      await openInbox()
      await lookAway()
      await row("Should the preview show test or sample products").click()
      const open = sheet("Checkout implementation")
      await userEvent.type(ownWords(open, "Reply"), "Sample products.")
      await userEvent.keyboard("{Enter}")

      await expect.element(confirmation()).toMatchTextContent("Reply queued for @moth.")
      await expect.element(confirmation()).not.toMatchTextContent("working again")
    })
  })

  context("when an agent asks for a command to be run", () => {
    it("shows it to copy, and a button for when it is done", async () => {
      await openInbox()
      await row("Could you run vercel login").click()
      const open = page.getByRole("dialog")

      await expect.element(open.getByRole("button", { name: "Copy command" })).toBeVisible()
      await press(open, "I've logged in")

      await expect.element(confirmation()).toMatchTextContent(/^Told @\w+ it's done\.$/)
    })
  })

  context("when an agent reports it is done", () => {
    it("shows its report, which opening reads, and it stays listed as read", async () => {
      await openInbox()
      await row("Search index rebuilt").click()
      const open = page.getByRole("dialog")

      await expect.element(open).toMatchTextContent("Rebuilt the index for all 412 pages")
      // Nothing to mark: opening it read it, and it is history now, in gray.
      await expect.element(open.getByRole("button", { name: "Mark read" })).not.toBeInTheDocument()
      await expect
        .element(rows().filter({ hasText: "Search index rebuilt" }))
        .toHaveAttribute("data-settled", "read")
      await expect.element(open).toMatchTextContent(/^Read/)
    })
  })
})

describe("The Inbox's history", () => {
  const dismissButton = (subject: string) =>
    page.getByRole("button", { name: new RegExp(`^Dismiss: .*${subject}`) })

  it("offers no Mark all read and no Clear settled", async () => {
    await openInbox()
    await lookAway()
    await rows().filter({ hasText: "webhooks" }).hover()
    await dismissButton("webhooks").click()

    await expect
      .element(page.getByRole("button", { name: "Mark all read" }))
      .not.toBeInTheDocument()
    await expect
      .element(page.getByRole("button", { name: "Clear settled" }))
      .not.toBeInTheDocument()
  })

  it("lists only the ten resolved rows that resolved last, in gray, and counts none", async () => {
    await openWorkspace(`${inbox}&desktop=on`)
    desktopWindow.arriveResolved()
    await sidebarPanel("Inbox").click()

    // Seventeen resolved, ten listed, each of them gray and none of them counted.
    await expect
      .poll(() => document.querySelectorAll("[data-inbox-row][data-settled]").length)
      .toBe(10)
    expect(
      document.querySelectorAll("[data-inbox-row][data-settled]:not([data-tint='muted'])"),
    ).toHaveLength(0)
    expect(sidebarPanel("Inbox").element().getAttribute("aria-label")).not.toContain("27")
  })

  it("opens a resolved row as a read-only card in gray, saying how it ended", async () => {
    await openInbox()
    await lookAway()
    await rows().filter({ hasText: "Could you run vercel login" }).hover()
    await row("Could you run vercel login").click()
    await press(page.getByRole("dialog"), "I've logged in")
    await expect.element(confirmation()).toMatchTextContent(/^Told @\w+ it's done\.$/)
    await userEvent.keyboard("{Escape}")

    await row("Could you run vercel login").click()
    const open = page.getByRole("dialog")
    await expect
      .poll(() => document.querySelector(".inbox-sheet")?.getAttribute("data-state"))
      .toBe("settled")
    await expect.element(open).toMatchTextContent("You answered: I've logged in")
    await expect.element(open.getByRole("group", { name: "Answers" })).not.toBeInTheDocument()
    await expect.element(open.getByRole("button", { name: "Snooze" })).not.toBeInTheDocument()
    await expect.element(open.getByRole("button", { name: "Copy command" })).toBeVisible()
  })
})

describe("Dismissing an ask", () => {
  const dismissButton = (subject: string) =>
    page.getByRole("button", { name: new RegExp(`^Dismiss: .*${subject}`) })

  it("resolves the row in place: it counts no more, stays gray, and opens its sheet to read", async () => {
    await openInbox()
    await lookAway()
    await expect.element(rows()).toHaveLength(settledRows)

    // The agent's own asks have it; a permission prompt, which blocks the agent, does not.
    await rows().filter({ hasText: "webhooks" }).hover()
    await expect.element(dismissButton("webhooks")).toBeVisible()
    await expect
      .element(page.getByRole("button", { name: /^Dismiss: .*pnpm add/ }))
      .not.toBeInTheDocument()
    await dismissButton("webhooks").click()

    await expect.element(rows()).toHaveLength(settledRows)
    await expect.element(sidebarPanel("Inbox")).toHaveAccessibleName("Inbox, 11 waiting")
    const resolved = rows().filter({ hasText: "webhooks" })
    await expect.element(resolved).toMatchTextContent("Dismissed")
    await expect.element(resolved).toHaveAttribute("data-settled", "dismissed")
    await expect.element(dismissButton("webhooks")).not.toBeInTheDocument()
    await row("webhooks").click()
    await expect.element(page.getByRole("dialog")).toMatchTextContent("You dismissed this ask")
  })

  it("dismisses on Delete, with the keyboard on to the next row", async () => {
    await openInbox()
    await lookAway()
    await expect.element(rows()).toHaveLength(settledRows)
    row("vercel login").element().focus()
    await userEvent.keyboard("{Delete}")

    await expect
      .element(rows().filter({ hasText: "vercel login" }))
      .toHaveAttribute("data-settled", "dismissed")
    expect(document.activeElement?.classList.contains("inbox-row-select")).toBe(true)
    expect(document.activeElement).not.toBe(row("vercel login").element())
    await expect.element(sidebarPanel("Inbox")).toHaveAccessibleName("Inbox, 11 waiting")
  })

  it("stays where it was in the list when the panel is opened again", async () => {
    await openInbox()
    await lookAway()
    await expect.element(rows()).toHaveLength(settledRows)
    const order = (): string[] =>
      Array.from(document.querySelectorAll("[data-inbox-row]")).map(
        (each) => each.textContent ?? "",
      )
    const before = order().findIndex((each) => each.includes("webhooks"))
    await rows().filter({ hasText: "webhooks" }).hover()
    await dismissButton("webhooks").click()
    expect(order().findIndex((each) => each.includes("webhooks"))).toBe(before)

    await sidebarPanel("Terminals").click()
    await sidebarPanel("Inbox").click()
    await expect.poll(() => order().findIndex((each) => each.includes("webhooks"))).toBe(before)
  })
})

describe("Snoozing a row", () => {
  const button = (name: string, subject: string) =>
    page.getByRole("button", { name: new RegExp(`^${name}: .*${subject}`) })
  const box = (element: Element): DOMRect => element.getBoundingClientRect()

  it("puts the unsnooze button where the dismiss button was, and the row isn't dismissed until it is back", async () => {
    await openInbox()
    await lookAway()
    await expect.element(rows()).toHaveLength(settledRows)
    const webhooks = rows().filter({ hasText: "webhooks" })
    await webhooks.hover()
    await expect.element(button("Dismiss", "webhooks")).toBeVisible()
    await button("Snooze", "webhooks").click()

    // The pointer is still on the row: the button slides in over the bell-off, which slides
    // out, at the end of the detail line.
    await expect.element(webhooks).toHaveAttribute("data-snoozed", "true")
    await webhooks.hover()
    await expect.element(button("Unsnooze", "webhooks")).toBeVisible()
    await expect.element(button("Dismiss", "webhooks")).not.toBeInTheDocument()
    const unsnooze = button("Unsnooze", "webhooks").element()
    const wait = webhooks.element().querySelector<HTMLElement>(".inbox-row-wait")!
    await expect.poll(() => getComputedStyle(unsnooze).transform).toBe("none")
    await expect.poll(() => getComputedStyle(wait).opacity).toBe("0")
    const at = box(unsnooze)
    // Where the bell-off stands at rest, without the slide that moves it out.
    wait.style.transform = "none"
    const mark = box(wait.querySelector("svg")!)
    wait.style.removeProperty("transform")
    expect(at.top).toBeLessThan(mark.top)
    expect(at.bottom).toBeGreaterThan(mark.bottom)
    // Within the 2px the buttons' inset (8px, a tab's) differs from the line's (10px) by.
    expect(Math.abs((at.left + at.right) / 2 - (mark.left + mark.right) / 2)).toBeLessThanOrEqual(2)
    row("webhooks").element().focus()
    await userEvent.keyboard("{Delete}")
    await expectStaysAbsent({
      shown: () => webhooks.element().hasAttribute("data-settled"),
      name: "the snoozed row, dismissed",
    })

    // A double click on it brings the row back and dismisses nothing, though the dismiss
    // button is under its second click.
    await button("Unsnooze", "webhooks").dblClick()
    await expect.element(webhooks).not.toHaveAttribute("data-snoozed")
    await expect.element(button("Dismiss", "webhooks")).toBeVisible()
    await expect.element(webhooks).not.toHaveAttribute("data-settled")
    await button("Dismiss", "webhooks").click()
    await expect.element(webhooks).toHaveAttribute("data-settled", "dismissed")
  })
})

describe("The Inbox on a phone", () => {
  afterEach(async () => {
    await page.viewport(1440, 900)
  })

  it("gives the screen to a sheet, with focus in it, and back to the list", async () => {
    await page.viewport(400, 800)
    await openInbox()
    await row("Run pnpm add").click()
    const screen = page.getByRole("dialog", { name: "Checkout review" })

    await expect.element(screen).toBeVisible()
    await expect
      .poll(() => document.activeElement?.closest(".inbox-fullscreen") !== null)
      .toBe(true)
    await screen.getByRole("button", { name: "Back to the Inbox" }).click()
    await expect.element(screen).not.toBeInTheDocument()
    await expect.element(row("Run pnpm add")).toBeVisible()
  })

  it("closes both the sheet and the list on Show terminal", async () => {
    await page.viewport(400, 800)
    await openInbox()
    await row("Run pnpm add").click()
    await page
      .getByRole("dialog", { name: "Checkout review" })
      .getByRole("button", { name: "Show terminal" })
      .click()

    await expect
      .element(page.getByRole("dialog", { name: "Checkout review" }))
      .not.toBeInTheDocument()
    await expect.element(row("Run pnpm add")).not.toBeInTheDocument()
    await expect.element(terminal("Checkout review")).toBeVisible()
  })
})
