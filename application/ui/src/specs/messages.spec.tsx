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
import { expectStaysAbsent, recordChanges, tabDescription, terminalTab } from "./support/workspace"

const textOf = (locator: Locator) => locator.element().textContent

const description = tabDescription

describe("Messages waiting for an agent", () => {
  it("count in its terminal's tab's description, and only those still on their way to it", async () => {
    await openMessagesDemo()
    // Codex has one message being delivered and one queued; what it sent doesn't count.
    await expect
      .poll(() => description("Checkout review"))
      .toBe("Needs permission, 2 messages waiting, 2 subagents: 2 explorer")
    // The dev server's message is gone, never waiting.
    expect(description("Dev server")).toBeNull()
  })

  it("say a release is needed when their thread is held", async () => {
    await openMessagesDemo()
    await expect
      .poll(() => description("Checkout implementation"))
      .toBe("Plan ready for review, 1 message waiting, held until you release it")
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
        "Thread with Checkout review (t4)",
        "Thread with Tests (t3)",
        "Thread with Dev server (t2)",
      ])
    const review = messageItems(thread(pane, "Checkout review", "t4"))
    await expect.poll(() => review.elements().length).toBe(4)
    // The demo stamps its messages minutes back, so just after midnight they carry a date.
    await expect
      .poll(() => textOf(review.nth(0)))
      .toMatch(/^Sent to t4(?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d\d.*Delivered/)
    await expect.poll(() => textOf(review.nth(1))).toMatch(/From t4/)
    await expect.poll(() => textOf(review.nth(2))).toMatch(/Delivering/)
    await expect.poll(() => textOf(review.nth(3))).toMatch(/Waiting/)
    await expect
      .poll(() => textOf(messageItems(thread(pane, "Dev server", "t2")).first()))
      .toMatch(/Not delivered/)
  })

  it("shows the agents' text as they wrote it, never formatted", async () => {
    await openMessagesDemo()
    const pane = await openMessages("Checkout implementation")
    const written = messageItems(thread(pane, "Checkout review", "t4")).nth(3)
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
    await expect.element(pane.getByRole("region", { name: "Thread with t2" })).toBeVisible()
  })

  it("dates a message that isn't from today", async () => {
    await openMessagesDemo()
    const pane = await openMessages("Checkout implementation")
    await expect
      .poll(() => textOf(messageItems(thread(pane, "Dev server", "t2")).first()))
      .toMatch(/Sent to t2[A-Z][a-z]{2} \d+, \d\d:\d\d/)
  })

  context("in a thread held after going back and forth", () => {
    it("lets the person release it, and the tab and thread follow", async () => {
      await openMessagesDemo()
      const pane = await openMessages("Checkout implementation")
      const tests = thread(pane, "Tests", "t3")
      await expect.poll(() => textOf(messageItems(tests).last())).toMatch(/Held for release/)
      await tests.getByRole("button", { name: "Release the thread with Tests" }).click()
      await expect.poll(() => textOf(messageItems(tests).last())).toMatch(/Waiting/)
      // The button goes, and focus with it to the thread.
      await expect.element(tests.getByRole("heading", { name: "Tests" })).toHaveFocus()
      await expect.element(tests.getByRole("button", { name: /^Release/ })).not.toBeInTheDocument()
      await expect
        .poll(() => description("Checkout implementation"))
        .toBe("Plan ready for review, 1 message waiting")
    })
  })
})

describe("Pausing messaging", () => {
  it("holds every waiting message, says so in the pane and on the tabs, and resumes", async () => {
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
    const items = messageItems(thread(pane, "Checkout implementation", "t1"))
    await expect.poll(() => textOf(items.nth(3))).toMatch(/Held while paused/)
    await expect.poll(() => textOf(items.nth(2))).toMatch(/Delivering/)
    await expect
      .poll(() => description("Checkout review"))
      .toBe(
        "Needs permission, 2 messages waiting, held while messaging is paused, 2 subagents: 2 explorer",
      )
    await pause.click()
    await expect.poll(() => textOf(items.nth(3))).toMatch(/Waiting/)
    await expect.element(pane.getByRole("status")).not.toBeInTheDocument()
    await expect
      .poll(() => description("Checkout review"))
      .toBe("Needs permission, 2 messages waiting, 2 subagents: 2 explorer")
  })
})

describe("Who named a terminal", () => {
  it("shows in its tab's menu", async () => {
    await openMessagesDemo()
    expect(await namedBy("Checkout implementation")).toBe("Named by you")
    expect(await namedBy("Checkout review")).toBe("Named by the agent in t1")
    expect(await namedBy("Tests")).toBe("Named after its first prompt")
  })

  it("can be handed back to Novadeck from the tab's menu when the person named it", async () => {
    await openMessagesDemo()
    const menu = await tabMenu("Checkout implementation")
    await menu.getByRole("menuitem", { name: "Reset to automatic" }).click()
    await expect.element(terminalTab("Checkout flow")).toBeVisible()
    expect(await namedBy("Checkout flow")).toBe("Named by the agent in t1")
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
    await expectStaysAbsent(page.getByRole("menu", { name: "Checkout review actions" }))
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
      .element(page.getByRole("menu", { name: "Checkout review actions" }))
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
  it("says which terminal leads it, by handle and name", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout review").click()
    await expect.element(page.getByText("led by t1 · Checkout implementation")).toBeVisible()
    expect(page.getByText(/^led by t3/).elements()).toHaveLength(0)
  })

  it("stops saying so once its lead's terminal is closed", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    await tabAction("Close Checkout implementation").click()
    await confirmClose()
    await terminalTab("Checkout review").click()
    await expect.element(page.getByRole("heading", { name: "Checkout review" })).toBeVisible()
    await expectStaysAbsent(page.getByText(/^led by t1/))
  })
})
