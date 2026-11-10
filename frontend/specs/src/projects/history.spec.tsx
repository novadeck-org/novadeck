import { page, userEvent } from "vitest/browser"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

import { closeConfirmation, confirmClose, tabAction } from "../support/terminals"
import {
  openWorkspace,
  sidebarPanel,
  terminal,
  terminalTab,
  terminalTabNames,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// The agents demo keeps closed terminals: the storefront's rows, one for each state, and what
// the person closes here. Restoring takes the row away a moment after, as the runner confirms.
const agents = "/?demo=agents"

const closed = () => page.getByRole("list", { name: "Closed terminals" })
const find = () => page.getByRole("searchbox", { name: "Find a closed terminal" })
const openHistory = async () => {
  await openWorkspace(agents)
  await sidebarPanel("History").click()
  await expect.element(closed()).toBeVisible()
}

describe("The History panel", () => {
  context("where the backend keeps closed terminals", () => {
    it("has a rail toggle after Sessions, and lists the project's rows with a count", async () => {
      await openHistory()
      const toggles = page
        .getByRole("radiogroup", { name: "Sidebar actions" })
        .getByRole("radio")
        .elements()
        .map((each) => each.getAttribute("aria-label"))
      expect(toggles.indexOf("History")).toBe(toggles.indexOf("Sessions") + 1)
      await expect.element(page.getByRole("button", { name: "Restore Coupon codes" })).toBeVisible()
      await expect.element(page.getByRole("heading", { name: /^History 14$/ })).toBeVisible()
    })

    it("names a plain terminal's folder after its title", async () => {
      await openHistory()
      const row = closed().getByRole("button", { name: "Restore pnpm dev" })
      await expect.poll(() => row.element().textContent).toMatch(/^pnpm dev.*web$/)
    })

    it("shows a row's summary under its title, without the handle it had", async () => {
      await openHistory()
      const row = closed().getByRole("button", { name: "Restore Coupon codes" })
      await expect
        .poll(() => row.element().textContent)
        .toMatch(/^Coupon codes.*Coupon codes in the cart and at checkout$/)
      expect(row.element().textContent).not.toMatch(/@wren/)
      expect(row.element().querySelector("mark")).toBeNull()
    })
  })

  context("when searching", () => {
    it("finds a row by its title, with the matches over the total as the count", async () => {
      await openHistory()
      await find().fill("tax")
      await expect.element(page.getByRole("button", { name: "Restore Tax rounding" })).toBeVisible()
      await expect
        .element(page.getByRole("button", { name: "Restore Coupon codes" }))
        .not.toBeInTheDocument()
      await expect.element(page.getByRole("heading", { name: /^History 1\/14$/ })).toBeVisible()
    })

    it("finds a row by its handle, typed with its @", async () => {
      await openHistory()
      await find().fill("@pike")
      await expect.element(page.getByRole("button", { name: "Restore Tax rounding" })).toBeVisible()
    })

    it("lights a search's match in the summary", async () => {
      await openHistory()
      await find().fill("webhook")
      const row = page.getByRole("button", { name: "Restore Payment retries" })
      await expect.poll(() => row.element().textContent).toMatch(/Stripe webhook retries/)
      expect(row.element().querySelector("mark")?.textContent).toBe("webhook")
    })

    it("says what it looked for when nothing matches", async () => {
      await openHistory()
      await find().fill("vat invoices")
      await expect
        .element(page.getByText("No closed terminal matches “vat invoices”."))
        .toBeVisible()
    })

    it("has no search box in a project with nothing closed", async () => {
      await openWorkspace(agents)
      await sidebarPanel("History").click()
      await page.getByRole("button", { name: "Switch workspace", exact: true }).click()
      await page
        .getByRole("dialog", { name: "Switch workspace" })
        .getByRole("button", { name: /^docs-site / })
        .click()
      await expect
        .element(page.getByText("Terminals you close show up here, so you can bring them back."))
        .toBeVisible()
      await expect.element(find()).not.toBeInTheDocument()
    })
  })

  context("when a row can't be restored", () => {
    it("says why without a tooltip, to assistive technology, and takes no click", async () => {
      await openHistory()
      const gone = closed().getByRole("button", { name: "Product filters, unavailable" })
      await expect.element(gone).toHaveAttribute("aria-disabled", "true")
      await expect
        .element(gone)
        .toHaveAccessibleDescription(/Claude Code no longer has this conversation/)
      await expect
        .element(closed().getByRole("button", { name: "Image CDN, unavailable" }))
        .toHaveAccessibleDescription(/folder it ran in is gone/)
      // A person's click lands on it and does nothing.
      ;(gone.element() as HTMLElement).click()
      await expect.element(gone).toBeVisible()
    })

    it("offers to connect a disconnected agent, reachable by keyboard, in Preferences", async () => {
      await openHistory()
      const row = closed().getByRole("button", { name: "Release notes, not connected" })
      await expect.element(row).toHaveAttribute("aria-disabled", "true")
      await expect.element(row).toHaveAccessibleDescription(/Connect Codex to restore this/)
      const plug = page.getByRole("button", { name: "Connect Codex in Preferences" })
      plug.element().focus()
      await expect.element(plug).toHaveFocus()
      await userEvent.keyboard("{Enter}")
      await expect.element(page.getByRole("dialog", { name: /Preferences/ })).toBeVisible()
      // At that agent's own switch, in the Agents section.
      await expect.element(page.getByRole("switch", { name: "Codex" })).toHaveFocus()
    })

    it("says an agent that isn't installed can't be connected, and offers nothing", async () => {
      await openHistory()
      const row = closed().getByRole("button", { name: "Receipt emails, not connected" })
      await expect.element(row).toHaveAccessibleDescription(/Antigravity isn't installed/)
      await expect
        .element(page.getByRole("button", { name: /Connect Antigravity/ }))
        .not.toBeInTheDocument()
    })

    it("goes to the terminal that holds an open conversation", async () => {
      await openWorkspace(agents)
      await sidebarPanel("History").click()
      await closed()
        .getByRole("button", { name: /^Show Shipping rates, open as @fox/ })
        .click()
      // @fox is the second terminal, "Dev server".
      await expect.element(terminal("Dev server")).toBeVisible()
    })
  })

  context("when restoring", () => {
    it("adds a new terminal beside the session's, selected, and the row leaves once restored", async () => {
      await openHistory()
      await closed().getByRole("button", { name: "Restore Coupon codes" }).click()
      await expect.element(terminal("Coupon codes")).toBeVisible()
      // The sidebar stays on History, and the row shows it is restoring, inert, until it goes.
      await expect.element(sidebarPanel("History")).toBeChecked()
      await expect
        .element(closed().getByRole("button", { name: "Restore Coupon codes" }))
        .not.toBeInTheDocument()
      await expect.element(page.getByRole("heading", { name: /^History 13$/ })).toBeVisible()
    })

    it("lists the restored terminal at the top of the Terminals list", async () => {
      await openHistory()
      await closed().getByRole("button", { name: "Restore Coupon codes" }).click()
      await expect.element(terminal("Coupon codes")).toBeVisible()
      await sidebarPanel("Terminals").click()
      await expect.poll(() => terminalTabNames()[0]).toBe("Coupon codes")
    })
  })

  context("when a row is clicked twice at once", () => {
    it("restores it once", async () => {
      await openHistory()
      const row = closed().getByRole("button", { name: "Restore Coupon codes" })
      const button = row.element() as HTMLElement
      button.click()
      button.click()
      await expect.element(terminal("Coupon codes")).toBeVisible()
      await expect.element(page.getByRole("heading", { name: /^History 13$/ })).toBeVisible()
      // However long the runner takes, one terminal was made from the row.
      await sleep(300)
      // The footer counts six terminals and the one restored, not two.
      await expect.poll(() => document.body.textContent).toMatch(/7 terminals/)
      expect(document.body.textContent).not.toMatch(/8 terminals/)
    })
  })

  context("when closing a terminal", () => {
    it("asks for a program that runs, and keeps what is closed in History", async () => {
      await openWorkspace(agents)
      await tabAction("Close Dev server").click()
      await expect.element(closeConfirmation()).toBeVisible()
      await confirmClose()
      await expect.element(terminalTab("Dev server")).not.toBeInTheDocument()
      await sidebarPanel("History").click()
      await expect
        .element(closed().getByRole("button", { name: "Restore Dev server" }))
        .toBeVisible()
    })

    it("flares a dot on the History toggle for a moment, and names what landed", async () => {
      await openWorkspace(agents)
      const toggle = page.getByRole("radio", { name: "History" })
      await tabAction("Close Dev server").click()
      await confirmClose()
      await expect.poll(() => toggle.element().querySelector(".history-dot")).not.toBeNull()
      await expect
        .element(
          page.getByRole("status").filter({ hasText: "Dev server closed. It’s in History." }),
        )
        .toBeInTheDocument()
      // The dot leaves once its flare has played; nothing stays until History is seen.
      await expect
        .poll(() => toggle.element().querySelector(".history-dot"), { timeout: 4_000 })
        .toBeNull()
    })

    it("says on its × where a closed terminal goes", async () => {
      await openWorkspace(agents)
      await tabAction("Close Dev server").hover()
      await expect.element(page.getByText("Close · stays in History")).toBeVisible()
    })

    it("asks for an agent mid-turn, in words about its turn", async () => {
      await openWorkspace(agents)
      await tabAction("Close Checkout implementation").click()
      await expect
        .poll(() => closeConfirmation().element().textContent)
        .toMatch(/working on a turn/)
    })
  })
})
