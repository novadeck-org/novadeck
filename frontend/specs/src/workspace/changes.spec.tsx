import { page } from "vitest/browser"

import { taskbarIcons } from "../support/companions"
import { expectSelected, openWorkspace, sidebar, sidebarPanel } from "../support/workspace"
import { context, describe, expect, it } from "../test"

// The plain demo's storefront has six works, each a tracked worktree: Checkout implementation
// and Tests unread, in conflict with each other (and the first with main); read ones with no
// owner, Build's, Checkout review's (its agent is working in it) and a second of Build's just
// made, which differs from nothing.
const storefront = "/projects/storefront/sessions/initial/focus?panel=changes"
// Its dotfiles project has none.
const dotfiles = "/projects/dotfiles/sessions/initial/focus?panel=changes"
const showcase = "/projects/studio/sessions/initial/focus?demo=showcase&panel=changes"

const list = () => page.getByRole("list", { name: "Changes" })
const rows = () => list().getByRole("button", { name: /^(?!Close the )/ })
const row = (title: string, branch = "") =>
  list().getByRole("button", { name: new RegExp(`^${title}, ${branch}`) })
const labels = () =>
  rows()
    .elements()
    .map((element) => element.getAttribute("aria-label"))
const itemOf = (title: string, branch = "") =>
  list()
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: new RegExp(`^${title}, ${branch}`) }) })
const cross = (title: string, branch: string) =>
  itemOf(title, branch).getByRole("button", { name: /^Close the / })
const dialog = () => page.getByRole("alertdialog", { name: "Close this worktree?" })

describe("The Changes panel", () => {
  context("when the backend reports works", () => {
    it("has a rail button and counts the project's works", async () => {
      await openWorkspace(storefront)

      await expect.element(sidebarPanel("Changes")).toBeChecked()
      await expect.element(sidebar()).toHaveAccessibleName("Changes")
      await expect.element(page.getByRole("heading", { name: "Changes 6" })).toBeVisible()
    })

    it("lists them first come, first served, the unread above the read", async () => {
      await openWorkspace(storefront)

      await expect.element(rows().first()).toBeVisible()
      expect(labels()).toEqual([
        "Checkout implementation, agent/checkout-implementation, 4 files changed, 310 lines added, 56 removed unread, conflicts with main, Tests",
        "Tests, agent/tests, 2 files changed, 85 lines added, 18 removed unread, conflicts with Checkout implementation",
        "No owner, agent/promo-banner, 1 file changed",
        "Build, agent/build, 2 files changed",
        "Checkout review, agent/checkout-review, 1 file changed",
        "Build, agent/build-cache, 0 files changed",
      ])
      // The line the Inbox draws above its updates comes before the first read work.
      await expect.element(itemOf("No owner")).toHaveAttribute("data-read-start", "true")
    })

    it("shows the unread lines top right, and nothing once read", async () => {
      await openWorkspace(storefront)

      await expect.element(itemOf("Tests").getByText("+85")).toBeVisible()
      await expect
        .element(itemOf("Build", "agent/build,").getByText(/^\+\d/))
        .not.toBeInTheDocument()
    })

    it("marks a work in conflict, and names what it conflicts with", async () => {
      await openWorkspace(storefront)

      await expect.element(itemOf("Tests")).toHaveAttribute("data-conflict", "true")
      await expect.element(itemOf("Build", "agent/build,")).not.toHaveAttribute("data-conflict")
    })
  })

  context("when a row is picked", () => {
    it("selects its terminal and unfolds its files under the row", async () => {
      await openWorkspace(storefront)
      await expect.element(page.getByTitle("src/cart/Cart.test.tsx")).not.toBeVisible()

      await row("Tests").click()

      await sidebarPanel("Terminals").click()
      await expectSelected("Tests")
      await sidebarPanel("Changes").click()
      await expect.element(itemOf("Tests")).toHaveAttribute("data-selected", "true")
      await expect.element(page.getByTitle("src/cart/Cart.test.tsx")).toBeVisible()
      await expect
        .element(itemOf("Tests").getByTitle("src/checkout/Checkout.test.tsx"))
        .toBeVisible()
    })

    it("reads the work: its lines go and it moves below the line", async () => {
      await openWorkspace(storefront)

      await row("Tests").click()

      await expect.element(itemOf("Tests")).toHaveAttribute("data-read", "true")
      await expect.element(itemOf("Tests").getByText("+85")).not.toBeInTheDocument()
      expect(labels().map((label) => label!.split(",")[0])).toEqual([
        "Checkout implementation",
        "No owner",
        "Build",
        "Checkout review",
        "Tests",
        "Build",
      ])
    })

    it("opens the work as a changes item on the terminal's bar where the backend can show it", async () => {
      await openWorkspace(showcase)

      await row("Build Studio").click()

      await expect
        .poll(() => taskbarIcons("Build Studio").some((label) => label.startsWith("Changes")))
        .toBe(true)
    })
  })

  context("when a row's × is used", () => {
    it("asks before closing a worktree that differs from main, saying what is kept", async () => {
      await openWorkspace(storefront)

      await cross("Tests", "agent/tests").click()

      await expect.element(dialog()).toBeVisible()
      await expect
        .element(dialog().getByText("Committed work stays on the branch agent/tests."))
        .toBeVisible()
      await expect.element(dialog().getByText(/Ignored files, such as .env/)).toBeVisible()
      await dialog().getByRole("button", { name: "Keep it" }).click()
      await expect.element(dialog()).not.toBeInTheDocument()
      await expect.element(row("Tests")).toBeVisible()
    })

    it("closes it once confirmed, and the count drops", async () => {
      await openWorkspace(storefront)

      await cross("Tests", "agent/tests").click()
      await dialog().getByRole("button", { name: "Close worktree" }).click()

      await expect.element(row("Tests")).not.toBeInTheDocument()
      await expect.element(page.getByRole("heading", { name: "Changes 5" })).toBeVisible()
    })

    it("closes a worktree that differs from nothing at once", async () => {
      await openWorkspace(storefront)

      await cross("Build", "agent/build-cache").click()

      await expect.element(dialog()).not.toBeInTheDocument()
      await expect.element(row("Build", "agent/build-cache")).not.toBeInTheDocument()
    })

    it("waits while the owner's agent is working in the worktree", async () => {
      await openWorkspace(storefront)

      await expect
        .element(cross("Checkout review", "agent/checkout-review"))
        .toHaveAttribute("aria-disabled", "true")
      await cross("Checkout review", "agent/checkout-review").click({ force: true })
      await expect.element(dialog()).not.toBeInTheDocument()
      await expect.element(row("Checkout review")).toBeVisible()
    })

    it("closes a worktree with no owner too", async () => {
      await openWorkspace(storefront)

      await expect.element(itemOf("No owner")).toBeVisible()
      await cross("No owner", "agent/promo-banner").click()
      await dialog().getByRole("button", { name: "Close worktree" }).click()

      await expect.element(itemOf("No owner")).not.toBeInTheDocument()
    })
  })

  context("when the project has no worktree", () => {
    it("says what shows up here, and, with agent worktrees off, where to turn them on", async () => {
      await openWorkspace(dotfiles)

      await expect.element(page.getByText("No worktrees")).toBeVisible()
      await expect
        .element(page.getByText(/When an agent opens or takes a git worktree, it shows up here/))
        .toBeVisible()
      await expect.element(page.getByText(/Turn on Agent worktrees in Preferences/)).toBeVisible()
    })
  })
})
