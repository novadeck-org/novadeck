import { page } from "vitest/browser"

import { taskbarIcons } from "../support/companions"
import { expectSelected, openWorkspace, sidebar, sidebarPanel } from "../support/workspace"
import { context, describe, expect, it } from "../test"

// The plain demo's storefront has seven works, each a tracked worktree: Checkout implementation
// and Tests in conflict with each other (and the first with main); ones with no owner, Build's,
// Checkout review's (its agent is working in it), a second of Build's just made, which differs
// from nothing, and a third whose work was merged. The panel lists only the open project's works,
// so those of api-service (two), docs-site and design-system stay out of it.
const storefront = "/projects/storefront/sessions/initial/focus?panel=changes"
const apiService = "/projects/api-service/sessions/initial/focus?panel=changes"
const showcase = "/projects/studio/sessions/initial/focus?demo=showcase&panel=changes"

const list = () => page.getByRole("list", { name: "Changes" })
const rows = () => list().getByRole("button", { name: /^(?!Close the |Preview )/ })
// A row's accessible label starts as `Title, branch,`.
const named = (title: string, branch = "") =>
  new RegExp(`^${title}, ${branch === "" ? "[^,]*" : branch},`)
const row = (title: string, branch = "") =>
  list().getByRole("button", { name: named(title, branch) })
const labels = () =>
  rows()
    .elements()
    .map((element) => element.getAttribute("aria-label"))
const itemOf = (title: string, branch = "") =>
  list()
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: named(title, branch) }) })
const cross = (title: string, branch: string) =>
  itemOf(title, branch).getByRole("button", { name: /^Close the / })
const dialog = () => page.getByRole("alertdialog", { name: "Close this worktree?" })

describe("The Changes panel", () => {
  context("when the backend reports works", () => {
    it("has a rail button and counts the open project's works", async () => {
      await openWorkspace(storefront)

      await expect.element(sidebarPanel("Changes")).toBeChecked()
      await expect.element(sidebar()).toHaveAccessibleName("Changes")
      await expect.element(page.getByRole("heading", { name: "Changes 7" })).toBeVisible()
    })

    it("lists them first come, first served, whatever has been read", async () => {
      await openWorkspace(storefront)

      await expect.element(rows().first()).toBeVisible()
      expect(labels()).toEqual([
        "Build, agent/build-lint, 0 files changed, merged",
        "No owner, agent/promo-banner, 1 file changed, 18 lines added, 2 removed",
        "Build, agent/build, 2 files changed, 11 lines added, 5 removed",
        "Checkout review, agent/checkout-review, 1 file changed, 6 lines added, 2 removed",
        "Checkout implementation, agent/checkout-implementation, 5 files changed, 324 lines added, 56 removed, conflicts with main, Tests",
        "Tests, agent/tests, 2 files changed, 85 lines added, 18 removed, conflicts with Checkout implementation",
        "Build, agent/build-cache, 0 files changed",
      ])
    })

    it("shows the total lines top right, and nothing for a worktree that differs from nothing", async () => {
      await openWorkspace(storefront)

      await expect.element(itemOf("Tests", "agent/tests").getByText("+85")).toBeVisible()
      await expect.element(itemOf("Build", "agent/build").getByText("+11")).toBeVisible()
      await expect
        .element(itemOf("Build", "agent/build-cache").getByText(/^\+\d/))
        .not.toBeInTheDocument()
    })

    it("marks a merged work, and not one just made", async () => {
      await openWorkspace(storefront)

      await expect
        .element(itemOf("Build", "agent/build-lint"))
        .toHaveAttribute("data-merged", "true")
      await expect.element(itemOf("Build", "agent/build-cache")).not.toHaveAttribute("data-merged")
    })

    it("lists another project's works once that project is open, and names no project", async () => {
      await openWorkspace(apiService)

      await expect.element(page.getByRole("heading", { name: "Changes 2" })).toBeVisible()
      expect(labels()).toEqual([
        "Checkout implementation, agent/checkout-implementation, 2 files changed, 92 lines added, 11 removed",
        "Tests, agent/tests, 1 file changed, 47 lines added, 5 removed",
      ])
      await expect.element(list().getByText("api-service")).not.toBeInTheDocument()
    })

    it("marks a work in conflict, and names what it conflicts with", async () => {
      await openWorkspace(storefront)

      await expect.element(itemOf("Tests", "agent/tests")).toHaveAttribute("data-conflict", "true")
      await expect.element(itemOf("Build", "agent/build")).not.toHaveAttribute("data-conflict")
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

    it("keeps the clicked worktree selected among its owner's others", async () => {
      await openWorkspace(storefront)

      await row("Build", "agent/build-cache").click()

      await expect
        .element(itemOf("Build", "agent/build-cache"))
        .toHaveAttribute("data-selected", "true")
      await expect.element(itemOf("Build", "agent/build")).toHaveAttribute("data-selected", "false")
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
      await expect.element(page.getByRole("heading", { name: "Changes 6" })).toBeVisible()
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
})
