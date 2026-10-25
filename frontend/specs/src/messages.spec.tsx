import { describe as context, describe, expect, it } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import {
  bubbles,
  conversationRow,
  conversationRows,
  messageItems,
  messagesButton,
  namedBy,
  openConversation,
  openMessages,
  openMessagesDemo,
  pauseSwitch,
  tabMenu,
} from "./support/messages"
import { confirmClose, sidebarRenameField, tabAction } from "./support/terminals"
import {
  expectStaysAbsent,
  recordChanges,
  tabDescription,
  terminalTab,
  tooltipOf,
} from "./support/workspace"

const textOf = (locator: Locator) => locator.element().textContent

const description = tabDescription

describe("Messages waiting for an agent", () => {
  it("count in its terminal's tab's description, and only those still on their way to it", async () => {
    await openMessagesDemo()
    // Codex has one message being delivered and one queued; what it sent doesn't count.
    await expect
      .poll(() => description("Checkout review"))
      .toBe(
        "Needs you: pnpm test --filter checkout, 2 messages waiting, 2 subagents: 2 explorer. Led by @moth",
      )
    // The dev server's message is gone, never waiting.
    expect(description("Dev server")).toBeNull()
  })

  it("count what waits, with no release asked while no thread is held", async () => {
    await openMessagesDemo()
    await expect
      .poll(() => description("Checkout implementation"))
      .toBe("Needs you: Where should the empty cart link?, 1 message waiting. Leads @crow")
  })
})

describe("A terminal's messages", () => {
  it("list its conversations, the person's letters first while they wait, then latest first", async () => {
    await openMessagesDemo()
    const pane = await openMessages("Checkout implementation")
    const rows = conversationRows(pane)
    await expect
      .poll(() => rows.elements().map((each) => each.getAttribute("aria-label")))
      .toEqual([
        "You, asks you",
        expect.stringMatching(/^Checkout review, @crow, last at /),
        expect.stringMatching(/^Tests, @owl, last at /),
        expect.stringMatching(/^Build, @raven, last at /),
        expect.stringMatching(/^Runtime, @kite, last at /),
        "Dev server, @fox, not delivered",
      ])
    // Its last message describes it.
    await expect
      .element(conversationRow(pane, "Build, @raven"))
      .toHaveAccessibleDescription(/^@raven: The bundle grew 41 kB/)
    // A row's corner says one thing: what asks of the person, what was lost, or the time.
    await expect.element(conversationRow(pane, "You")).toMatchTextContent(/Asks you$/)
    await expect
      .element(conversationRow(pane, "Dev server, @fox"))
      .toMatchTextContent(/Not delivered$/)
    await expect
      .element(conversationRow(pane, "Build, @raven"))
      .toMatchTextContent(/@raven: The bundle grew 41 kB/)
  })

  it("reads one as a chat, saying where a message is only while it's on its way or lost", async () => {
    await openMessagesDemo()
    const pane = await openMessages("Checkout implementation")
    const chat = await openConversation(pane, "Checkout review, @crow")
    await expect.poll(() => bubbles(chat).length).toBe(4)
    await expect
      .poll(() => bubbles(chat).map((each) => each.getAttribute("data-side")))
      .toEqual(["out", "in", "out", "out"])
    await expect.poll(() => bubbles(chat)[0]!.textContent).toMatch(/^@moth: Can you review/)
    await expect.poll(() => bubbles(chat)[1]!.textContent).toMatch(/^@crow: Looking now/)
    await expect.poll(() => bubbles(chat)[2]!.textContent).toMatch(/Delivering$/)
    await expect.poll(() => bubbles(chat)[3]!.textContent).toMatch(/Waiting$/)
    // Back to the list, onto the row it came from.
    await pane.getByRole("button", { name: "All conversations" }).click()
    await expect.element(conversationRow(pane, "Checkout review, @crow")).toHaveFocus()
  })

  it("shows the agents' text as they wrote it, never formatted", async () => {
    await openMessagesDemo()
    const pane = await openMessages("Checkout implementation")
    const chat = await openConversation(pane, "Checkout review, @crow")
    const written = chat.getByText(
      "tests/checkout/retry.test.ts covers it now; see `maxTries` and the **cap**.",
    )
    await expect.element(written).toBeVisible()
    await expect.element(chat.getByRole("strong")).not.toBeInTheDocument()
    await expect.element(chat.getByRole("code")).not.toBeInTheDocument()
  })

  it("stay off the taskbar of an agent that has had none", async () => {
    await openMessagesDemo("/projects/api-service/sessions/initial/focus")
    await terminalTab("Checkout implementation").click()
    await expectStaysAbsent(messagesButton("Checkout implementation"))
    expect(messagesButton("Checkout implementation").query()).toBeNull()
  })

  it("names a peer that's gone from the session by its handle alone", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    await tabAction("Close Dev server").click()
    await confirmClose()
    const pane = await openMessages("Checkout implementation")
    await expect.element(conversationRow(pane, "@fox")).toBeVisible()
  })

  it("dates a message that isn't from today", async () => {
    await openMessagesDemo()
    const pane = await openMessages("Checkout implementation")
    const chat = await openConversation(pane, "Dev server, @fox")
    await expect
      .poll(() => textOf(messageItems(chat).first()))
      .toMatch(/^[A-Z][a-z]{2} \d+, \d\d:\d\d/)
  })

  context("in a thread that goes round and round", () => {
    it("folds the repeated rounds to a line until the person asks for them, with no hold to release", async () => {
      await openMessagesDemo()
      const pane = await openMessages("Checkout implementation")
      const chat = await openConversation(pane, "Tests, @owl")
      const fold = chat.getByRole("button", { name: /4 more rounds like this/ })
      await expect.element(fold).toBeVisible()
      await expect.poll(() => bubbles(chat).length).toBe(5)
      await fold.click()
      await expect.poll(() => bubbles(chat).length).toBe(13)
      await expect.element(pane.getByRole("button", { name: /^Release/ })).not.toBeInTheDocument()
    })
  })

  context("with the person's letters", () => {
    it("labels them in plain words, quotes the question a reply answers, and offers Answer", async () => {
      await openMessagesDemo()
      const pane = await openMessages("Checkout implementation")
      const chat = await openConversation(pane, "You")
      await expect.element(pane).toMatchTextContent("1 question waits for you")
      await expect.element(chat).toMatchTextContent("Asked you · answered")
      // Opening its terminal looks at it, which reads the tell the agent left there.
      await expect.element(chat).toMatchTextContent("Told you")
      await expect.element(chat).toMatchTextContent("Asks you")
      await expect
        .poll(
          () => bubbles(chat).find((each) => each.getAttribute("data-side") === "out")?.textContent,
        )
        .toMatch(/Should the order summary show tax.*After shipping, same as the cart\./)
      await chat.getByRole("button", { name: "Answer: Where should the empty cart link?" }).click()
      await expect
        .element(page.getByRole("heading", { name: "Where should the empty cart link?" }))
        .toBeVisible()
    })
  })
})

describe("Pausing messaging", () => {
  it("holds waiting messages between agents, says so in the pane and on the tabs, and resumes", async () => {
    await openMessagesDemo()
    const pane = await openMessages("Checkout review")
    const pause = pauseSwitch(pane)
    await expect.element(pause).toHaveAttribute("aria-checked", "false")
    // On its way, it takes no clicks, and keeps focus. The demo's runner hears it in less
    // time than a poll may take to look, so how it went is checked once it's there.
    const onItsWay = recordChanges(pause, "aria-disabled", (element) => ({
      disabled: element.getAttribute("aria-disabled"),
      focused: element === document.activeElement,
    }))
    await pause.click()
    await expect.element(pause).toHaveAttribute("aria-checked", "true")
    await expect.element(pause).not.toHaveAttribute("aria-disabled")
    await expect.element(pause).toHaveFocus()
    expect(onItsWay()).toContainEqual({ disabled: "true", focused: true })
    await expect.poll(() => textOf(pane.getByRole("status"))).toMatch(/Messaging is paused/)
    // Codex's queued message is held, which the chat says only as waiting; the one already
    // being delivered goes on.
    const chat = await openConversation(pane, "Checkout implementation, @moth")
    await expect.poll(() => bubbles(chat)[3]?.textContent).toMatch(/Waiting$/)
    await expect.poll(() => bubbles(chat)[2]?.textContent).toMatch(/Delivering$/)
    await expect
      .poll(() => description("Checkout review"))
      .toBe(
        "Needs you: pnpm test --filter checkout, 2 messages waiting, held while messaging is paused, 2 subagents: 2 explorer. Led by @moth",
      )
    await pause.click()
    await expect.element(pane.getByText(/Messaging is paused/)).not.toBeInTheDocument()
    await expect
      .poll(() => description("Checkout review"))
      .toBe(
        "Needs you: pnpm test --filter checkout, 2 messages waiting, 2 subagents: 2 explorer. Led by @moth",
      )
  })
})

describe("Who named a terminal", () => {
  it("shows in its tab's menu", async () => {
    await openMessagesDemo()
    expect(await namedBy("Checkout implementation")).toBe("Named by you")
    expect(await namedBy("Checkout review")).toBe("Named by the agent in @moth")
    expect(await namedBy("Tests")).toBe("Named by Murmur")
  })

  it("can be handed back to Novadeck from the tab's menu when the person named it", async () => {
    await openMessagesDemo()
    const menu = await tabMenu("Checkout implementation")
    await menu.getByRole("menuitem", { name: "Reset to automatic" }).click()
    await expect.element(terminalTab("Checkout flow")).toBeVisible()
    expect(await namedBy("Checkout flow")).toBe("Named by the agent in @moth")
    // A name Novadeck gave has nothing to hand back.
    const automatic = await tabMenu("Checkout flow")
    await expect.element(automatic.getByRole("menuitem", { name: "Rename" })).toBeVisible()
    await expectStaysAbsent(automatic.getByRole("menuitem", { name: "Reset to automatic" }))
  })

  it("leaves a rename in progress alone when the person right-clicks in its field", async () => {
    await openMessagesDemo()
    await tabAction("Rename Checkout review").click()
    const field = sidebarRenameField("Checkout review")
    await expect.element(field).toHaveFocus()
    await userEvent.keyboard("Half")
    await field.click({ button: "right" })
    await expectStaysAbsent(page.getByRole("menu", { name: /^Checkout review, @[a-z]+ actions$/ }))
    await expect.element(field).toHaveFocus()
    await expect.element(field).toHaveValue("Half")
    await expect.element(terminalTab("Half")).not.toBeInTheDocument()
  })

  it("leaves a rename in progress alone when the person long-presses its field", async () => {
    await openMessagesDemo()
    await tabAction("Rename Checkout review").click()
    const field = sidebarRenameField("Checkout review")
    await expect.element(field).toHaveFocus()
    await userEvent.keyboard("Draft")
    // A touch held on the field, as a long-press starts.
    const box = field.element().getBoundingClientRect()
    field.element().dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "touch",
        isPrimary: true,
        clientX: box.x + 5,
        clientY: box.y + 5,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await expect
      .element(page.getByRole("menu", { name: /^Checkout review, @[a-z]+ actions$/ }))
      .not.toBeInTheDocument()
    await expect.element(field).toHaveValue("Draft")
  })

  it("keeps the tab itself through a rename", async () => {
    await openMessagesDemo()
    const before = terminalTab("Checkout review").element().closest("[data-terminal-tab-id]")
    await tabAction("Rename Checkout review").click()
    await expect.element(sidebarRenameField("Checkout review")).toHaveFocus()
    await userEvent.keyboard("Review{Enter}")
    await expect.element(terminalTab("Review")).toBeVisible()
    expect(terminalTab("Review").element().closest("[data-terminal-tab-id]")).toBe(before)
  })

  it("is the person's once they rename it", async () => {
    await openMessagesDemo()
    const menu = await tabMenu("Checkout review")
    await expect
      .element(menu.getByRole("menuitem", { name: "Reset to automatic" }))
      .not.toBeInTheDocument()
    await menu.getByRole("menuitem", { name: "Rename" }).click()
    // The menu closes and hands focus to the tab's name field.
    await expect.element(sidebarRenameField("Checkout review")).toHaveFocus()
    await userEvent.keyboard("Review{Enter}")
    expect(await namedBy("Review")).toBe("Named by you")
  })
})

describe("A terminal an agent opened", () => {
  it("says which terminal leads it by handle, and its name on hover", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout review").click()
    const lead = page.getByText("led by @moth", { exact: true })
    await expect.element(lead).toBeVisible()
    // Its tab keeps its own handle, which its lead names it by.
    await expect.element(terminalTab("Checkout review").getByText(/^@[a-z]+$/)).toBeVisible()
    expect(await tooltipOf(lead)).toBe("Directed by the agent in @moth · Checkout implementation")
    expect(page.getByText(/^led by @owl/).elements()).toHaveLength(0)
  })

  it("stops saying so once its lead's terminal is closed", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    await tabAction("Close Checkout implementation").click()
    await confirmClose()
    await terminalTab("Checkout review").click()
    await expect.element(page.getByRole("heading", { name: "Checkout review" })).toBeVisible()
    await expectStaysAbsent(page.getByText(/^led by @moth/))
  })
})

describe("A terminal that leads others", () => {
  it("says how many it leads, and whom on hover", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    const leads = page.getByText("leads 1", { exact: true })
    await expect.element(leads).toBeVisible()
    expect(await tooltipOf(leads)).toBe("Directs the agents in @crow")
  })

  it("is said only in the lead's own window", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout review").click()
    await expect.element(page.getByText("led by @moth", { exact: true })).toBeVisible()
    const windows = [...document.querySelectorAll("[data-terminal-leads]")].map(
      (leads) =>
        leads.closest(".terminal-window")?.querySelector("[data-terminal-name]")?.textContent,
    )
    expect(new Set(windows)).toEqual(new Set(["Checkout implementation"]))
  })
})

// What a tab is in the selected terminal's team, as its tab marks it.
const teamMark = (name: string) =>
  terminalTab(name).element().closest("[data-terminal-tab-id]")?.getAttribute("data-team") ?? null

// The teams' wires on the rail, resting and lit.
const resting = () => document.querySelectorAll(".team-wire-shape:not([data-lit])").length
const lit = () => document.querySelectorAll(".team-wire-shape[data-lit]").length

describe("A team in the sidebar", () => {
  it("marks the lead and its worker while the lead is selected, and wires them on the rail", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    await expect.poll(() => teamMark("Checkout review")).toBe("worker")
    expect(teamMark("Checkout implementation")).toBe("lead")
    expect(teamMark("Dev server")).toBeNull()
    await expect.poll(() => document.querySelectorAll(".team-wire-tap").length).toBe(1)
    expect(document.querySelectorAll(".team-wire-cursor")).toHaveLength(1)
    await expect.poll(lit).toBe(1)
    expect(resting()).toBe(0)
  })

  it("marks the same team while its worker is selected", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout review").click()
    await expect.poll(() => teamMark("Checkout implementation")).toBe("lead")
    expect(teamMark("Checkout review")).toBe("worker")
  })

  it("marks no tab while a terminal in no team is selected, and rests its wire", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    await expect.poll(resting).toBe(1)
    expect(lit()).toBe(0)
    expect(document.querySelectorAll(".team-wire-cursor")).toHaveLength(1)
    expect(teamMark("Checkout implementation")).toBeNull()
    expect(teamMark("Checkout review")).toBeNull()
  })

  it("rests, and stays at rest, once a terminal in no team is clicked from it", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    await expect.poll(lit).toBe(1)
    await terminalTab("Dev server").click()
    await expect.poll(lit).toBe(0)
    expect(resting()).toBe(1)
    // Past any measuring a press on the list set going.
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect([resting(), lit()]).toEqual([1, 0])
    expect(document.querySelectorAll(".team-wire-segment")).toHaveLength(1)
  })

  it("says in each member's description who leads it and whom it leads, selected or not", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    const worker = textOf(terminalTab("Checkout review").getByText(/^@[a-z]+$/))
    await expect.poll(() => description("Checkout review")).toMatch(/\. Led by @moth$/)
    expect(description("Checkout implementation")).toMatch(new RegExp(`Leads ${worker}$`))
    expect(description("Dev server")).toBeNull()
  })

  it("ends once the lead's terminal is closed", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    await tabAction("Close Checkout implementation").click()
    await confirmClose()
    await terminalTab("Checkout review").click()
    await expect.poll(() => teamMark("Checkout review")).toBeNull()
    expect(document.querySelectorAll(".team-wire-segment")).toHaveLength(0)
  })
})
