import { demoInboxIds } from "@novadeck/demo/inbox/fixtures"
import { beforeEach, describe as context, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import { forgetHostWindow, hostWindow } from "./support/backend"
import { expectStaysAbsent, openWorkspace, sidebarPanel, terminalTab } from "./support/workspace"

// The landing rule: what an agent says from the terminal the person is looking at doesn't
// reach the Inbox, the bell or a toast until they look away. The spec host (`&host=on`) starts
// with an empty Inbox the spec fills.
const storefront =
  "/projects/storefront/sessions/initial/focus?terminal=storefront-initial-01&host=on"
const docs = "/projects/docs-site/sessions/initial/focus?terminal=docs-site-initial-02&host=on"

const bell = () => page.getByRole("radio", { name: /^Inbox, \d+ waiting$/ })
const inboxRow = (subject: RegExp | string) =>
  page.getByRole("list", { name: "Messages from your agents" }).getByRole("button", {
    name: typeof subject === "string" ? new RegExp(subject) : subject,
  })

const open = async (route: string): Promise<void> => {
  await openWorkspace(route)
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
}

// The grace a new item waits before it rings is 2 s; waiting past it shows nothing rang.
const nothingLands = (): Promise<void> =>
  expectStaysAbsent(
    {
      shown: () => bell().query() !== null || document.querySelector(".toast") !== null,
      name: "a bell or toast",
    },
    { ms: 3_000 },
  )

beforeEach(forgetHostWindow)

describe("The landing rule", () => {
  context("when an agent asks from the terminal the person looks at", () => {
    it("lands in the Inbox only once they select another terminal", async () => {
      await open(storefront)

      hostWindow.arrive(demoInboxIds.preview)

      await nothingLands()
      await sidebarPanel("Inbox").click()
      await expect.element(inboxRow("Should the preview show")).not.toBeInTheDocument()
      await sidebarPanel("Terminals").click()
      await terminalTab("Checkout review").click()

      await expect.element(bell()).toHaveAccessibleName("Inbox, 1 waiting")
      await sidebarPanel("Inbox").click()
      await expect.element(inboxRow("Should the preview show")).toBeVisible()
    })
  })

  context("when the person looked at the terminal long enough to see its ask", () => {
    it("lands quietly: on the bell, with no toast", async () => {
      await open(storefront)

      hostWindow.arrive(demoInboxIds.preview)
      await nothingLands()
      await terminalTab("Checkout review").click()

      await expect.element(bell()).toHaveAccessibleName("Inbox, 1 waiting")
      await expectStaysAbsent(
        { shown: () => document.querySelector(".toast") !== null, name: "a toast" },
        { ms: 3_000 },
      )
    })
  })

  // The report arrives and the person looks away in one task, so no dwell can pass between
  // them however slow the runner is.
  context("when the person looks away from a done report before the dwell is over", () => {
    it("leaves it unread and lands it", async () => {
      await open(docs)
      const away = page
        .getByRole("button", { name: /^Select / })
        .first()
        .element() as HTMLElement

      hostWindow.arrive(demoInboxIds.done)
      away.click()

      await expectStaysAbsent(
        { shown: () => !hostWindow.itemIds().includes(demoInboxIds.done), name: "a read" },
        { ms: 2_500 },
      )
      await sidebarPanel("Inbox").click()
      await expect.element(inboxRow("Search index rebuilt")).toBeVisible()
    })
  })

  context("when the person looks away from an ask before the dwell is over", () => {
    it("lands it as any other, and it rings", async () => {
      await open(storefront)
      const away = terminalTab("Checkout review").element() as HTMLElement

      hostWindow.arrive(demoInboxIds.preview)
      away.click()

      await expect.element(bell()).toHaveAccessibleName("Inbox, 1 waiting")
      // Not quiet: it rings its toast after the grace a new item waits.
      await expect
        .poll(() => document.querySelectorAll(".toast").length, { timeout: 8_000 })
        .toBe(1)
    })
  })

  context("when an agent reports it is done to the terminal the person looks at", () => {
    it("reads it by being seen, so it never lands, however they look away", async () => {
      await open(docs)

      hostWindow.arrive(demoInboxIds.done)
      // It isn't read by the arrival itself, only once the person has looked at the terminal
      // for a moment; then the backend has it read, and it was never a row.
      expect(hostWindow.itemIds()).toContain(demoInboxIds.done)
      await expect
        .poll(() => hostWindow.itemIds(), { timeout: 5_000 })
        .not.toContain(demoInboxIds.done)

      await page
        .getByRole("button", { name: /^Select / })
        .first()
        .click()
      await sidebarPanel("Inbox").click()
      await expect.element(inboxRow("Search index rebuilt")).not.toBeInTheDocument()
      await expectStaysAbsent(
        {
          shown: () => inboxRow("Search index rebuilt").query() !== null,
          name: "the report's row",
        },
        { ms: 1_500 },
      )
    })
  })
})
