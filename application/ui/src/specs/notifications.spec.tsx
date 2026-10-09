import { afterEach, describe as context, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import { currentRoute, pressNewSession, workspaceSwitcher } from "./support/sessions"
import {
  terminal,
  notification,
  notifications,
  openWorkspace,
  sidebarPanel,
} from "./support/workspace"

// The agents demo: docs-site's agent asks a question, and a moment after it opens
// design-system's finishes, done, and infra's fails, while the person looks at storefront.
const openNotifications = async (): Promise<void> => {
  await openWorkspace("/?demo=agents")
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
  await sidebarPanel("Notifications").click()
}

const markAllRead = () => page.getByRole("button", { name: "Mark all read" })

describe("The notification center", () => {
  context("when no agent asks for the person", () => {
    it("says so", async () => {
      await openWorkspace()
      await sidebarPanel("Notifications").click()

      await expect.element(page.getByText("Nothing needs you.")).toBeVisible()
      await expect.element(markAllRead()).not.toBeInTheDocument()
    })
  })

  context("when an agent in another project asks a question", () => {
    it("lists it with where it is, and shows it on a click", async () => {
      await openNotifications()
      const row = notification("docs-site")

      // The row names its kind and where it is; what it asks in full is for its tooltip.
      await expect.element(row.getByText(/^Question · docs-site · /)).toBeVisible()
      await expect
        .element(row.getByRole("button", { name: /^Go to / }))
        .toHaveAccessibleDescription(/^Asks a question\. docs-site · /)
      await row.getByRole("button", { name: /^Go to / }).click()

      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
      await expect.element(terminal("Checkout implementation")).toBeVisible()
      // It waits until its agent is answered, however often it is looked at.
      await expect.element(notification("docs-site")).toBeVisible()
    })
  })

  context("when an agent finishes elsewhere", () => {
    it("lists a done and a failed finish, each until the person looks at it", async () => {
      await openNotifications()
      const done = notification("design-system")
      const failed = notification("infra")

      await expect
        .element(done.getByText(/^Done · design-system · /), { timeout: 10_000 })
        .toBeVisible()
      await expect
        .element(failed.getByText(/^Failed · infra · /), { timeout: 10_000 })
        .toBeVisible()
      await expect
        .element(failed.getByRole("button", { name: /^Go to / }))
        .toHaveAccessibleDescription(/^Stopped with an error/)
      await done.getByRole("button", { name: /^Go to / }).click()

      await expect.element(workspaceSwitcher()).toHaveTextContent("design-system")
      await expect.element(done).not.toBeInTheDocument()
      await expect.element(failed).toBeVisible()
    })

    it("clears one when dismissed, and keeps the rest", async () => {
      await openNotifications()
      const done = notification("design-system")
      await expect.element(done, { timeout: 10_000 }).toBeVisible()
      await expect.element(notification("infra"), { timeout: 10_000 }).toBeVisible()

      await done.getByRole("button", { name: /^Mark .* read$/ }).click()

      await expect.element(done).not.toBeInTheDocument()
      await expect.element(notification("infra")).toBeVisible()
      await expect.element(notification("docs-site")).toBeVisible()
    })

    it("clears every finish at once, and keeps the requests", async () => {
      await openNotifications()
      await expect.element(notification("design-system"), { timeout: 10_000 }).toBeVisible()
      await expect.element(notification("infra"), { timeout: 10_000 }).toBeVisible()

      await markAllRead().click()

      await expect.element(notification("design-system")).not.toBeInTheDocument()
      await expect.element(notification("infra")).not.toBeInTheDocument()
      await expect.element(markAllRead()).not.toBeInTheDocument()
      await expect.element(notification("docs-site")).toBeVisible()
    })

    it("leaves focus on the next row once one is dismissed, for the keyboard to go on", async () => {
      await openNotifications()
      const done = notification("design-system")
      await expect.element(done, { timeout: 10_000 }).toBeVisible()
      await expect.element(notification("infra"), { timeout: 10_000 }).toBeVisible()

      const dismiss = done.getByRole("button", { name: /^Mark .* read$/ })
      dismiss.element().focus()
      await expect.element(dismiss).toHaveFocus()
      await done.getByRole("button", { name: /^Mark .* read$/ }).click()

      await expect.element(done).not.toBeInTheDocument()
      await expect
        .element(notification("infra").getByRole("button", { name: /^Go to / }))
        .toHaveFocus()
    })

    it("leaves focus on the first request once all are marked read", async () => {
      await openNotifications()
      await expect.element(notification("design-system"), { timeout: 10_000 }).toBeVisible()
      await expect.element(notification("infra"), { timeout: 10_000 }).toBeVisible()

      await markAllRead().click()

      await expect.element(markAllRead()).not.toBeInTheDocument()
      await expect
        .element(
          notifications()
            .first()
            .getByRole("button", { name: /^Go to / }),
        )
        .toHaveFocus()
    })
  })

  context("when an agent left a reply", () => {
    it("describes it to a screen reader, beside the status and where", async () => {
      await openNotifications()
      const done = notification("design-system")
      await expect.element(done, { timeout: 10_000 }).toBeVisible()

      const reply = done.element().querySelector(".notification-reply")?.textContent
      expect(reply).toBeTruthy()
      await expect
        .element(done.getByRole("button", { name: /^Go to / }))
        .toHaveAttribute("aria-description", expect.stringContaining(`. ${reply}`))
    })
  })

  context("on a phone, where the sidebar is a drawer", () => {
    afterEach(async () => {
      await page.viewport(1440, 900)
    })

    it("leaves focus on the first request once all are marked read", async () => {
      await page.viewport(390, 800)
      await openWorkspace("/?demo=agents")
      const skip = page.getByRole("button", { name: "Skip for now" })
      if (await skip.query()) await skip.click()
      await sidebarPanel("Notifications").click()
      await expect.element(notification("design-system"), { timeout: 10_000 }).toBeVisible()
      await expect.element(notification("infra"), { timeout: 10_000 }).toBeVisible()

      await markAllRead().click()

      await expect.element(markAllRead()).not.toBeInTheDocument()
      await expect
        .element(
          notifications()
            .first()
            .getByRole("button", { name: /^Go to / }),
        )
        .toHaveFocus()
    })
  })

  context("when a request waits in another session of the same project", () => {
    it("shows that session", async () => {
      await openNotifications()
      await notification("docs-site")
        .getByRole("button", { name: /^Go to / })
        .click()
      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
      const asked = currentRoute().match(/\/sessions\/([^/]+)/)![1]
      await pressNewSession()
      await expect.poll(currentRoute).not.toContain(`/sessions/${asked}`)
      await sidebarPanel("Notifications").click()

      await notification("docs-site")
        .getByRole("button", { name: /^Go to / })
        .click()

      await expect.poll(currentRoute).toContain(`/sessions/${asked}`)
      await expect.element(terminal("Checkout implementation")).toBeVisible()
    })
  })

  context("when a request waits on the person", () => {
    it("has no way to dismiss it", async () => {
      await openNotifications()
      const row = notification("docs-site")

      await expect.element(row).toBeVisible()
      await expect.element(row.getByRole("button", { name: /^Mark / })).not.toBeInTheDocument()
      // Its one button shows it, and nothing marks it read.
      expect(row.getByRole("button").elements()).toHaveLength(1)
    })
  })
})
