import { demoInboxIds } from "@novadeck/demo/inbox-fixtures"
import { beforeEach } from "vitest"
import { page, userEvent } from "vitest/browser"

import { forgetHostWindow, hostWindow } from "../support/backend"
import { preferencesDialog } from "../support/keyboard"
import { expectStaysAbsent, openWorkspace, sidebarPanel } from "../support/workspace"
import { context, describe, expect, it } from "../test"

// The Inbox's toasts: a new item that needs the person rings as a toast while the app has
// their focus, and as the OS notification while it hasn't. The spec host (`&host=on`) is a
// desktop-like one: it reports the window's focus, which the spec moves, and keeps the
// notifications it was asked to show. The person looks at storefront's first terminal, which
// is where the preview ask (the demo's) comes from.
const route = (extra = "") =>
  `/projects/storefront/sessions/initial/focus?terminal=storefront-initial-01&host=on${extra}`

// The demo's items that need the person, from terminals other than the one looked at.
const asks = [
  demoInboxIds.webhook,
  demoInboxIds.login,
  demoInboxIds.codexPermission,
  demoInboxIds.stuck,
]

// The grace a new item waits before it rings is 2 s; a toast is waited for past it.
const rings = { timeout: 8_000 }

const toasts = (): Element[] => [...document.querySelectorAll(".toast")]
const toastTexts = (): string[] => toasts().map((each) => each.textContent ?? "")
// The pill counting the rest: "+1 more" at rest, "1 more in the Inbox" once the pointer is
// over the stack and it fans out.
const more = () => page.getByRole("button", { name: /^\+\d+ more$/ })
const inboxRow = (subject: RegExp | string) =>
  page.getByRole("list", { name: "Messages from your agents" }).getByRole("button", {
    name: typeof subject === "string" ? new RegExp(subject) : subject,
  })

const skipIntro = async (): Promise<void> => {
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
}

const open = async (extra?: string): Promise<void> => {
  await openWorkspace(route(extra))
  await skipIntro()
}

const nothingToasts = (): Promise<void> =>
  expectStaysAbsent({ shown: () => toasts().length > 0, name: "a toast" }, { ms: 5_000 })

beforeEach(forgetHostWindow)

describe("The Inbox's toasts", () => {
  context("while the app has the person's focus", () => {
    it("rings a new item that needs them after a grace, and sends no OS notice", async () => {
      await open()

      hostWindow.arrive(demoInboxIds.webhook)
      // Not at once: the person or the agent may settle it in the grace.
      await expectStaysAbsent({ shown: () => toasts().length > 0, name: "a toast" }, { ms: 1_000 })

      await expect.poll(toastTexts, rings).toHaveLength(1)
      expect(toastTexts()[0]).toMatch(/asks you/)
      expect(toastTexts()[0]).toMatch(/api-service/)
      expect(hostWindow.notices()).toEqual([])
    })

    it("closes at its ×, leaving the item in the Inbox", async () => {
      await open()
      hostWindow.arrive(demoInboxIds.webhook)
      await expect.poll(toastTexts, rings).toHaveLength(1)

      // The × takes presses only once the toast is hovered (or focused), and after it landed.
      await userEvent.hover(page.elementLocator(toasts()[0]!))
      await new Promise((resolve) => setTimeout(resolve, 600))
      await page.elementLocator(toasts()[0]!.querySelector(".toast-close")!).click()

      await expect.poll(toastTexts).toHaveLength(0)
      await sidebarPanel("Inbox").click()
      await expect.element(inboxRow(/Webhook|retry|webhook/i).first()).toBeVisible()
    })

    it("opens the item in the Inbox at a click", async () => {
      await open()
      hostWindow.arrive(demoInboxIds.webhook)
      await expect.poll(toastTexts, rings).toHaveLength(1)
      // A click as a toast lands is ignored (for 400 ms), as one meant for what was under it.
      await new Promise((resolve) => setTimeout(resolve, 600))

      await userEvent.click(page.elementLocator(document.querySelector('.toast[data-rank="0"]')!))

      await expect.element(sidebarPanel("Inbox")).toBeChecked()
      await expect.element(page.getByRole("dialog", { name: /\S/ })).toBeVisible()
      await expect.poll(toastTexts).toHaveLength(0)
    })

    it("shows three of four and counts the rest in a pill, which opens the Inbox", async () => {
      await open()

      hostWindow.arrive(...asks)

      await expect.poll(toastTexts, rings).toHaveLength(4)
      expect(toasts().filter((each) => !each.hasAttribute("data-beyond"))).toHaveLength(3)
      await expect.element(more()).toHaveTextContent("+1 more")

      // Reached by keyboard: the pointer over the stack spreads it out, and the pill it
      // leaves for another place is not one a jump of the pointer can be sure to meet.
      more().element().focus()
      // Presses are ignored for a moment after a toast lands or moves in the stack.
      await new Promise((resolve) => setTimeout(resolve, 600))
      await expect
        .element(page.getByRole("button", { name: "1 more in the Inbox" }))
        .toBeInTheDocument()
      await userEvent.keyboard("{Enter}")

      await expect.element(sidebarPanel("Inbox")).toBeChecked()
      await expect.poll(toastTexts).toHaveLength(0)
    })

    it("takes a toast away when its item is answered elsewhere", async () => {
      await open()
      hostWindow.arrive(demoInboxIds.webhook, demoInboxIds.login)
      await expect.poll(toastTexts, rings).toHaveLength(2)

      hostWindow.withdraw(demoInboxIds.login)

      // After its own grace, as the item may come back.
      await expect.poll(toastTexts, rings).toHaveLength(1)
      expect(toastTexts()[0]).toMatch(/api-service/)
    })

    it("rings nothing for an update, which needs no one", async () => {
      await open()

      hostWindow.arrive(demoInboxIds.told)

      await nothingToasts()
      expect(hostWindow.notices()).toEqual([])
    })

    it("rings nothing for the terminal the person has selected", async () => {
      await open()

      hostWindow.arrive(demoInboxIds.preview)

      await nothingToasts()
      expect(hostWindow.notices()).toEqual([])
    })

    it("rings nothing while the Inbox panel is open", async () => {
      await open()
      await sidebarPanel("Inbox").click()
      await expect.element(sidebarPanel("Inbox")).toBeChecked()

      hostWindow.arrive(demoInboxIds.webhook)

      await nothingToasts()
    })

    it("holds one while Preferences is open, and rings it once closed", async () => {
      await open()
      await page.getByRole("button", { name: "Workspace preferences" }).click()
      await expect.element(preferencesDialog()).toBeVisible()

      hostWindow.arrive(demoInboxIds.webhook)
      await nothingToasts()
      await userEvent.keyboard("{Escape}")

      await expect.poll(toastTexts, rings).toHaveLength(1)
    })
  })

  context("while the app is in the background", () => {
    it("pings through the OS instead, and shows no toast", async () => {
      await open()
      hostWindow.focus(false)

      hostWindow.arrive(demoInboxIds.webhook)

      await expect.poll(hostWindow.notices, rings).toHaveLength(1)
      expect(hostWindow.notices()[0]).toMatch(/asks you/)
      await nothingToasts()
    })
  })

  context("when the person doesn't want to be notified", () => {
    it("rings no toast, and no OS notice", async () => {
      await open()
      await page.getByRole("button", { name: "Workspace preferences" }).click()
      const toggle = preferencesDialog().getByRole("switch", {
        name: "Notify when an agent needs you",
      })
      await toggle.click()
      await expect.element(toggle).toHaveAttribute("aria-checked", "false")
      await userEvent.keyboard("{Escape}")
      await expect.element(preferencesDialog()).not.toBeInTheDocument()

      hostWindow.arrive(demoInboxIds.webhook)

      await nothingToasts()
      expect(hostWindow.notices()).toEqual([])
    })
  })
})
