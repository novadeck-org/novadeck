import { afterEach, describe as context, describe, expect, it } from "vitest"
import { page, userEvent } from "vitest/browser"

import { openConversation, openMessages } from "./support/messages"
import {
  expectStaysAbsent,
  openWorkspace,
  sidebarPanel,
  tabDescription,
  terminal,
  terminalTab,
} from "./support/workspace"

// The Inbox demo: the agents demo with an Inbox of hardcoded items across its projects, one
// of each kind, waiting on the person, over what its own agents wait on: api-service's plan and
// permission, and, a moment after it opens, infra's failed turn and design-system's done report.
const inbox = "/?demo=inbox"

const openInbox = async (route = inbox): Promise<void> => {
  await openWorkspace(route)
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
  await sidebarPanel("Inbox").click()
}

// The preview ask comes from the terminal the demo opens on, which the landing rule holds back
// while the person looks at it: selecting another one lands it.
const lookAway = async (): Promise<void> => {
  await sidebarPanel("Terminals").click()
  await terminalTab("Checkout review").click()
  await sidebarPanel("Inbox").click()
}

// What the Inbox demo holds once it has settled and the person has looked away from its first
// terminal: the 12 that wait, the preview ask that landed, and the demo agents' done reports.
// Whether the page has focus when it opens (so whether the preview ask is held) is up to the
// browser, so a count is only asserted after looking away, never before.
const settledRows = 15

const rows = () =>
  page.getByRole("list", { name: "Messages from your agents" }).getByRole("listitem")
const row = (subject: RegExp | string) =>
  page
    .getByRole("list", { name: "Messages from your agents" })
    .getByRole("button", { name: typeof subject === "string" ? new RegExp(subject) : subject })
const sheet = (title: string) => page.getByRole("dialog", { name: title })
const confirmation = () => page.getByRole("status").filter({ hasText: /\w/ })
// A row of an open sheet's numbered menu, by its words.
const answer = (open: ReturnType<typeof sheet>, name: RegExp | string) =>
  open.getByRole("menuitem", { name })
afterEach(() => {
  history.replaceState(null, "", "/")
})

describe("The Inbox on the rail", () => {
  it("counts what isn't an update", async () => {
    await openWorkspace(inbox)
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    await terminalTab("Checkout review").click()

    await expect.element(sidebarPanel("Inbox")).toHaveAccessibleName("Inbox, 12 waiting")
  })
})

describe("The agents demo's Inbox", () => {
  it("lists what its agents wait on, and an answer there moves the agent on", async () => {
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    await expect.poll(() => tabDescription("Checkout review") ?? "").toContain("Needs permission")
    await sidebarPanel("Inbox").click()
    await expect.element(row("Approve the plan?").first()).toBeVisible()
    await expect.element(row("Which approach should I take?")).toBeVisible()

    await row("Run pnpm test").click()
    await answer(sheet("Checkout review"), "Allow").click()

    await expect.element(confirmation()).toMatchTextContent("Allowed @crow's command.")
    await sidebarPanel("Terminals").click()
    await expect.poll(() => tabDescription("Checkout review") ?? "").not.toContain("Needs")
  })
})

describe("The Inbox's list", () => {
  it("lists one row for each item, trouble that stopped an agent first", async () => {
    await openInbox()
    await lookAway()

    await expect.element(rows()).toHaveLength(settledRows)
    await expect
      .element(rows().first())
      .toMatchTextContent(/Seems stuck: the same failure 3 times[\s\S]*7m[\s\S]*api-service/)
  })

  it("says how long an agent has waited only for one that stopped", async () => {
    await openInbox()

    await expect.element(rows().filter({ hasText: "Run pnpm add" })).toMatchTextContent("6m")
    await expect
      .element(rows().filter({ hasText: "vercel login" }))
      .not.toMatchTextContent(/\d+m\b/)
  })

  it("marks a long item with its reading time and a limit with when it resumes", async () => {
    await openInbox()

    await expect.element(rows().filter({ hasText: "webhooks" })).toMatchTextContent("1 min read")
    await expect
      .element(rows().filter({ hasText: "limit" }))
      .toMatchTextContent(/Resumes at \d\d:\d\d/)
  })
})

describe("An item's sheet", () => {
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
      await page.getByRole("region", { name: "focus view" }).click({ position: { x: 600, y: 700 } })

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

    it("moves to another item when another row is pressed, and with j and k", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await expect.element(sheet("Checkout review")).toBeVisible()

      await row("Which date library").click()
      await expect.element(sheet("Tests")).toBeVisible()
      await expect.element(sheet("Checkout review")).not.toBeInTheDocument()

      // One row up the list, past the permission for the edit.
      await userEvent.keyboard("k")
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

      // Past the head's two buttons, Tab reaches the menu, on Allow.
      await userEvent.tab()
      await userEvent.tab()
      await userEvent.tab()
      await expect.element(answer(open, "Allow")).toHaveFocus()
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
      await row("Heads-up").click()
      row("Heads-up").element().focus()
      await userEvent.tab()
      await userEvent.tab()
      await userEvent.tab()

      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument()
      await expect.element(row("Heads-up")).not.toHaveFocus()
    })

    it("follows its row in the tab order, and gives focus back to it", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      row("Run pnpm add").element().focus()
      await userEvent.tab()
      await expect.element(answer(sheet("Checkout review"), "Allow")).toHaveFocus()

      await userEvent.tab({ shift: true })
      await expect
        .element(sheet("Checkout review").getByRole("button", { name: "Close" }))
        .toHaveFocus()
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
      await answer(sheet("Checkout review"), "Allow").click()

      // The most urgent that remains: trouble that stopped an agent.
      await expect.element(sheet("Runtime")).toBeVisible()
      await expect.element(confirmation()).toMatchTextContent("Allowed @crow's command.")
      // The backend has dropped it; the row stays where it was until the sheet closes.
      await expect.poll(() => row("Run pnpm add").query()).not.toBeNull()
      await userEvent.keyboard("{Escape}")
      await expect.element(row("Run pnpm add")).not.toBeInTheDocument()
    })

    it("answers at once on a number pressed on its row", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      await userEvent.keyboard("1")

      await expect.element(confirmation()).toMatchTextContent("Allowed @crow's command.")
    })
  })

  context("when denying a command", () => {
    it("takes the person's words in place of its row, and sends them with Codex's own option for words", async () => {
      await openInbox()
      await row("Run pnpm add").click()
      const open = sheet("Checkout review")
      await answer(open, "Deny, with your words").click()
      await userEvent.type(
        open.getByRole("textbox", { name: /what Codex should do instead/i }),
        "Use npm.",
      )
      await userEvent.keyboard("{Enter}")

      await expect
        .element(confirmation())
        .toMatchTextContent("Denied @crow's command, with your words.")
    })
  })

  context("when sending a plan back", () => {
    it("takes the person's words in place of its row, named as Novadeck names it", async () => {
      await openInbox("/?demo=agents")
      // storefront's plan waits on the terminal the demo opens on, which may hold it back.
      await lookAway()
      await row(/Approve the plan\?.*storefront/).click()
      const open = page.getByRole("dialog")
      await answer(open, "Send it back, with your words").click()
      await userEvent.type(
        open.getByRole("textbox", { name: /what Claude should do instead/i }),
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
        .toMatchTextContent(
          "Novadeck can't answer this prompt from here. Answer it in the terminal.",
        )
      await expect.element(answer(open, "Allow")).not.toBeInTheDocument()
      await answer(open, "Go to terminal").click()

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
      await answer(open, /Our own retries/).click()
      await expect.element(answer(open, /Our own retries/)).toMatchTextContent("↵ again to send it")
      await expectStaysAbsent(confirmation())
      await answer(open, /Our own retries/).click()

      await expect.element(confirmation()).toMatchTextContent("Reply queued for @fox.")
    })

    it("keeps a reply it has not sent as a draft on the row", async () => {
      await openInbox()
      await row("How should failed payment webhooks retry").click()
      const open = sheet("Dev server")
      await answer(open, "Reply in your own words").click()
      await userEvent.type(open.getByRole("textbox", { name: /Reply to Codex/ }), "Let me think")
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
      await answer(open, /Our own retries/).click()
      await answer(open, /Our own retries/).click()
      await expect.element(open.getByRole("alert")).toMatchTextContent("Try again")
      await expectStaysAbsent(confirmation())
      await answer(open, /Our own retries/).click()
      await answer(open, /Our own retries/).click()
      await expect.element(confirmation()).toMatchTextContent("Reply queued for @fox.")
    })

    it("says a stale ask is no longer available, keeping the words", async () => {
      await openInbox(`${inbox}&inboxAnswer=stale`)
      await lookAway()
      await row("Should the preview show test or sample products").click()
      const open = sheet("Checkout implementation")
      const box = open.getByRole("textbox", { name: "Reply to Claude" })
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
      await userEvent.type(
        open.getByRole("textbox", { name: "Reply to Claude" }),
        "Sample products.",
      )
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
    it("strips the recommended mark and tags it as the agent's pick", async () => {
      await openInbox()
      await row("Which date library").click()
      const open = sheet("Tests")

      // A question of one pick is a menu of radios, the picked one marked.
      await expect.element(open.getByRole("menuitemradio", { name: /^date-fns/ })).toBeVisible()
      await expect.element(open.getByText("(Recommended)")).not.toBeInTheDocument()
      await expect.element(open.getByText("its pick")).toBeVisible()
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
      await answer(open, /^Release/).click()

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
      await answer(open, "Nudge it in your own words").click()
      await userEvent.type(
        open.getByRole("textbox", { name: /should try/ }),
        "Read the test first.",
      )
      await userEvent.keyboard("{Enter}")

      await expect.element(confirmation()).toMatchTextContent("Nudged @kite with your words.")
    })
  })

  context("when an agent hits a limit", () => {
    it("offers only the auto-resume switch, which stays on the item", async () => {
      await openInbox()
      await row("Hit Claude's 5-hour limit").click()
      const open = sheet("Build")
      const resume = open.getByRole("menuitemcheckbox", { name: /Resume automatically at/ })

      await expect.element(resume).toBeChecked()
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
      await userEvent.type(
        open.getByRole("textbox", { name: "Reply to Claude" }),
        "Sample products.",
      )
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
      await answer(open, "I've logged in").click()

      await expect.element(confirmation()).toMatchTextContent(/^Told @\w+ it's done\.$/)
    })
  })

  context("when an agent reports it is done", () => {
    it("shows its report, and marks it read", async () => {
      await openInbox()
      await row("Search index rebuilt").click()
      const open = page.getByRole("dialog")

      await expect.element(open).toMatchTextContent(/^Update/)
      await expect.element(open).toMatchTextContent("Rebuilt the index for all 412 pages")
      await answer(open, "Mark read").click()

      await expect.element(confirmation()).toMatchTextContent(/^Marked @\w+'s update read\.$/)
    })
  })
})

describe("Marking updates read", () => {
  it("reads every update and leaves what waits on the person", async () => {
    await openInbox()
    await lookAway()
    // Its late arrivals are in before the reading.
    await expect.element(rows()).toHaveLength(settledRows)
    await page.getByRole("button", { name: "Mark all read" }).click()

    // The updates read, what waits on the person (12, with the preview ask) stays.
    await expect.element(rows()).toHaveLength(12)
    await expect
      .element(page.getByRole("button", { name: "Mark all read" }))
      .not.toBeInTheDocument()
  })
})

describe("Dismissing an ask", () => {
  const dismissButton = (subject: string) =>
    page.getByRole("button", { name: new RegExp(`^Dismiss: .*${subject}`) })

  it("settles the row in place: it counts no more, stays struck through, and opens nothing", async () => {
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
    const settled = rows().filter({ hasText: "webhooks" })
    await expect.element(settled).toMatchTextContent("Dismissed")
    await expect.element(settled).toHaveAttribute("data-settled", "dismissed")
    await expect.element(dismissButton("webhooks")).not.toBeInTheDocument()
    await row("webhooks").click({ force: true })
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument()
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

  it("goes below the updates when the panel is opened again, and Clear removes it", async () => {
    await openInbox()
    await lookAway()
    await expect.element(rows()).toHaveLength(settledRows)
    await rows().filter({ hasText: "webhooks" }).hover()
    await dismissButton("webhooks").click()
    const order = (): string[] =>
      Array.from(document.querySelectorAll("[data-inbox-row]")).map(
        (each) => each.textContent ?? "",
      )
    expect(order().findIndex((each) => each.includes("webhooks"))).toBeLessThan(settledRows - 1)

    await sidebarPanel("Terminals").click()
    await sidebarPanel("Inbox").click()
    await expect
      .poll(() => order().findIndex((each) => each.includes("webhooks")))
      .toBe(settledRows - 1)
    await expect.element(rows().last()).toHaveAttribute("data-settled-start", "true")

    await page.getByRole("button", { name: "Clear settled" }).click()
    await expect.element(rows()).toHaveLength(settledRows - 1)
    await expect
      .element(page.getByRole("button", { name: "Clear settled" }))
      .not.toBeInTheDocument()
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
