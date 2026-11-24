import { demoInboxIds } from "@novadeck/demo/inbox/fixtures"
import { page } from "vitest/browser"

import { agentWorks, desktopWindow } from "../support/backend"
import { expectStaysAbsent, openWorkspace, sidebarPanel, terminalTab } from "../support/workspace"
import { context, describe, expect, it } from "../test"

// The landing rule: what an agent says from the terminal the person is looking at lands in
// the Inbox and on the bell at once, quietly: no toast, as they see it happen there. The spec's
// desktop-like app (`&desktop=on`) starts with an empty Inbox the spec fills.
const storefront =
  "/projects/storefront/sessions/initial/focus?terminal=storefront-initial-01&desktop=on"
const docs = "/projects/docs-site/sessions/initial/focus?terminal=docs-site-initial-02&desktop=on"

const bell = () => page.getByRole("radio", { name: /^Inbox, \d+ waiting$/ })
// A row's own button, by its words: not the buttons beside it that name it too (Dismiss,
// Snooze, Unsnooze).
const inboxRow = (subject: RegExp | string) => {
  const words = typeof subject === "string" ? new RegExp(subject) : subject
  return page.getByRole("list", { name: "Messages from your agents" }).getByRole("button", {
    name: new RegExp(`^(?!(?:Dismiss|Snooze|Unsnooze): ).*(?:${words.source})`, words.flags),
  })
}

const open = async (route: string): Promise<void> => {
  await openWorkspace(route)
}

// The grace a new entry waits before it rings is 2 s; waiting past it shows no toast rang.
const noToast = (): Promise<void> =>
  expectStaysAbsent(
    { shown: () => document.querySelector(".toast") !== null, name: "a toast" },
    { ms: 3_000 },
  )

describe("The landing rule", () => {
  context("when an agent asks from the terminal the person looks at", () => {
    it("lands in the Inbox and on the bell at once, with no toast, even once they look away", async () => {
      await open(storefront)

      desktopWindow.arrive(demoInboxIds.preview)

      await expect.element(bell()).toHaveAccessibleName("Inbox, 1 waiting")
      await sidebarPanel("Inbox").click()
      await expect.element(inboxRow("Should the preview show")).toBeVisible()
      await sidebarPanel("Terminals").click()
      await terminalTab("Checkout review").click()
      await noToast()
    })
  })

  context(
    "when an agent asks from the terminal the person looks at, and has yet to write its words",
    () => {
      it("lists it at once but counts it only once the agent's words follow, with no toast", async () => {
        await open(storefront)
        agentWorks("storefront-initial-01")

        desktopWindow.arrive(demoInboxIds.preview)

        await expectStaysAbsent(
          { shown: () => bell().query() !== null, name: "the bell" },
          { ms: 1_000 },
        )
        await sidebarPanel("Inbox").click()
        await expect.element(inboxRow("Should the preview show")).toBeVisible()
        agentWorks("storefront-initial-01", Date.now() + 1)

        await expect.element(bell()).toHaveAccessibleName("Inbox, 1 waiting")
        await noToast()
      })
    },
  )

  context("when an agent asks from a terminal the person isn't looking at", () => {
    it("lands it and rings", async () => {
      await open(storefront)
      await terminalTab("Checkout review").click()

      desktopWindow.arrive(demoInboxIds.preview)

      await expect.element(bell()).toHaveAccessibleName("Inbox, 1 waiting")
      // It rings its toast after the grace a new entry waits.
      await expect
        .poll(() => document.querySelectorAll(".toast").length, { timeout: 8_000 })
        .toBe(1)
    })
  })

  context("when an agent reports it is done to the terminal the person looks at", () => {
    it("lands quietly and stays unread until they have seen it in the Inbox and left", async () => {
      await open(docs)

      desktopWindow.arrive(demoInboxIds.done)
      // Looking at its terminal reads nothing, however long.
      await expectStaysAbsent(
        { shown: () => !desktopWindow.openEntryIds().includes(demoInboxIds.done), name: "a read" },
        { ms: 2_500 },
      )

      // Nor does seeing its row in the list, while they look at it: it stays as it came.
      await sidebarPanel("Inbox").click()
      await expect.element(inboxRow("Search index rebuilt")).toBeVisible()
      await expectStaysAbsent(
        { shown: () => !desktopWindow.openEntryIds().includes(demoInboxIds.done), name: "a read" },
        { ms: 2_500 },
      )
      await expect.element(inboxRow("Search index rebuilt")).not.toHaveAccessibleName(/read$/)

      // Leaving the list reads what they saw there: back in it, the row is history.
      await sidebarPanel("Terminals").click()
      await expect.poll(() => desktopWindow.openEntryIds()).not.toContain(demoInboxIds.done)
      await sidebarPanel("Inbox").click()
      await expect.element(inboxRow("Search index rebuilt")).toHaveAccessibleName(/read$/)
      await expect.element(bell()).not.toBeInTheDocument()
    })
  })

  context("when the person leaves the Inbox before an update's row was in sight a moment", () => {
    it("leaves it unread", async () => {
      await open(docs)
      await sidebarPanel("Inbox").click()

      // The report arrives and the person leaves in one task, so no dwell can pass between
      // them however slow the runner is.
      const terminals = sidebarPanel("Terminals").element() as HTMLElement
      desktopWindow.arrive(demoInboxIds.done)
      terminals.click()

      await expectStaysAbsent(
        { shown: () => !desktopWindow.openEntryIds().includes(demoInboxIds.done), name: "a read" },
        { ms: 2_500 },
      )
    })
  })
})
