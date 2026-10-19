import { describe as context, describe, expect, it } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import {
  messageItems,
  messagesButton,
  namedBy,
  openMessages,
  openMessagesDemo,
  pauseSwitch,
  tabMenu,
  thread,
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
      .toBe("Needs permission, 2 messages waiting, 2 subagents: 2 explorer, led by @moth")
    // The dev server's message is gone, never waiting.
    expect(description("Dev server")).toBeNull()
  })

  it("say a release is needed when their thread is held", async () => {
    await openMessagesDemo()
    await expect
      .poll(() => description("Checkout implementation"))
      .toBe("Plan ready for review, 1 message waiting, held until you release it, leads @crow")
  })
})

describe("A terminal's messages", () => {
  it("list its threads, latest first, each message with its direction, time, text and state", async () => {
    await openMessagesDemo()
    const pane = await openMessages("Checkout implementation")
    const threads = pane.getByRole("region", { name: /^Thread with / })
    await expect
      .poll(() => threads.elements().map((each) => each.getAttribute("aria-label")))
      .toEqual([
        "Thread with Checkout review (@crow)",
        "Thread with Tests (@owl)",
        "Thread with Dev server (@fox)",
      ])
    const review = messageItems(thread(pane, "Checkout review", "crow"))
    await expect.poll(() => review.elements().length).toBe(4)
    // The demo stamps its messages minutes back, so just after midnight they carry a date.
    await expect
      .poll(() => textOf(review.nth(0)))
      .toMatch(/^Sent to @crow(?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d\d.*Delivered/)
    await expect.poll(() => textOf(review.nth(1))).toMatch(/From @crow/)
    await expect.poll(() => textOf(review.nth(2))).toMatch(/Delivering/)
    await expect.poll(() => textOf(review.nth(3))).toMatch(/Waiting/)
    await expect
      .poll(() => textOf(messageItems(thread(pane, "Dev server", "fox")).first()))
      .toMatch(/Not delivered/)
  })

  it("shows the agents' text as they wrote it, never formatted", async () => {
    await openMessagesDemo()
    const pane = await openMessages("Checkout implementation")
    const written = messageItems(thread(pane, "Checkout review", "crow")).nth(3)
    await expect
      .element(
        written.getByText(
          "tests/checkout/retry.test.ts covers it now; see `maxTries` and the **cap**.",
        ),
      )
      .toBeVisible()
    await expect.element(written.getByRole("strong")).not.toBeInTheDocument()
    await expect.element(written.getByRole("code")).not.toBeInTheDocument()
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
    await expect.element(pane.getByRole("region", { name: "Thread with @fox" })).toBeVisible()
  })

  it("dates a message that isn't from today", async () => {
    await openMessagesDemo()
    const pane = await openMessages("Checkout implementation")
    await expect
      .poll(() => textOf(messageItems(thread(pane, "Dev server", "fox")).first()))
      .toMatch(/Sent to @fox[A-Z][a-z]{2} \d+, \d\d:\d\d/)
  })

  context("in a thread held after going back and forth", () => {
    it("lets the person release it, and the tab and thread follow", async () => {
      await openMessagesDemo()
      const pane = await openMessages("Checkout implementation")
      const tests = thread(pane, "Tests", "owl")
      await expect.poll(() => textOf(messageItems(tests).last())).toMatch(/Held for release/)
      await tests.getByRole("button", { name: "Release the thread with Tests" }).click()
      await expect.poll(() => textOf(messageItems(tests).last())).toMatch(/Waiting/)
      // The button goes, and focus with it to the thread.
      await expect.element(tests.getByRole("heading", { name: "Tests" })).toHaveFocus()
      await expect.element(tests.getByRole("button", { name: /^Release/ })).not.toBeInTheDocument()
      await expect
        .poll(() => description("Checkout implementation"))
        .toBe("Plan ready for review, 1 message waiting, leads @crow")
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
    // Codex's queued message is held; the one already being delivered goes on.
    const items = messageItems(thread(pane, "Checkout implementation", "moth"))
    await expect.poll(() => textOf(items.nth(3))).toMatch(/Held while paused/)
    await expect.poll(() => textOf(items.nth(2))).toMatch(/Delivering/)
    await expect
      .poll(() => description("Checkout review"))
      .toBe(
        "Needs permission, 2 messages waiting, held while messaging is paused, 2 subagents: 2 explorer, led by @moth",
      )
    await pause.click()
    await expect.poll(() => textOf(items.nth(3))).toMatch(/Waiting/)
    await expect.element(pane.getByText(/Messaging is paused/)).not.toBeInTheDocument()
    await expect
      .poll(() => description("Checkout review"))
      .toBe("Needs permission, 2 messages waiting, 2 subagents: 2 explorer, led by @moth")
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

// What a tab is in the selected terminal's team, as its tab marks it.
const teamMark = (name: string) =>
  terminalTab(name).element().closest("[data-terminal-tab-id]")?.getAttribute("data-team") ?? null

describe("A team in the sidebar", () => {
  it("marks the lead and its worker while the lead is selected, and wires them on the rail", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    await expect.poll(() => teamMark("Checkout review")).toBe("worker")
    expect(teamMark("Checkout implementation")).toBe("lead")
    expect(teamMark("Dev server")).toBeNull()
    await expect.poll(() => document.querySelectorAll(".team-wire-tap").length).toBe(1)
    expect(document.querySelectorAll(".team-wire-cursor")).toHaveLength(1)
  })

  it("marks the same team while its worker is selected", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout review").click()
    await expect.poll(() => teamMark("Checkout implementation")).toBe("lead")
    expect(teamMark("Checkout review")).toBe("worker")
  })

  it("marks nothing while a terminal in no team is selected", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    await expect.poll(() => document.querySelectorAll(".team-wire-segment").length).toBe(0)
    expect(teamMark("Checkout implementation")).toBeNull()
    expect(teamMark("Checkout review")).toBeNull()
  })

  it("is gone, and stays gone, once a terminal in no team is clicked from it", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    await expect.poll(() => document.querySelectorAll(".team-wire-segment").length).toBe(1)
    await terminalTab("Dev server").click()
    await expect.poll(() => document.querySelectorAll(".team-wire-segment").length).toBe(0)
    // Past any measuring a press on the list set going.
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(document.querySelectorAll(".team-wire-segment")).toHaveLength(0)
  })

  it("says in each member's description who leads it and whom it leads, selected or not", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    const worker = textOf(terminalTab("Checkout review").getByText(/^@[a-z]+$/))
    await expect.poll(() => description("Checkout review")).toMatch(/, led by @moth$/)
    expect(description("Checkout implementation")).toMatch(new RegExp(`leads ${worker}$`))
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
