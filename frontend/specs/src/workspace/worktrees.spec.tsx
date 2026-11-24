import { page } from "vitest/browser"

import { taskbarIcons } from "../support/companions"
import { workspaceSwitcher } from "../support/sessions"
import { expectSelected, openWorkspace, sidebar, sidebarPanel } from "../support/workspace"
import { context, describe, expect, it } from "../test"

// The plain demo's storefront has seven works, each a tracked worktree: Checkout implementation
// and Tests in conflict with each other (and the first with main); ones with no owner, Build's,
// Checkout review's (its agent is working in it), a second of Build's just made, which differs
// from nothing, and a third whose work was merged. The panel lists only the open project's works,
// so those of api-service (two), docs-site and design-system stay out of it.
const storefront = "/projects/storefront/sessions/initial/focus?panel=worktrees"
const apiService = "/projects/api-service/sessions/initial/focus?panel=worktrees"
const showcase = "/projects/studio/sessions/initial/focus?demo=showcase&panel=worktrees"

// The panel's rows stand in a list per group (Needs you, In progress, In review, Done).
const list = () => page.getByRole("region", { name: /^Worktrees( \d+)?$/ })
const rows = () =>
  list()
    .getByRole("listitem")
    .getByRole("button", { name: /^(?!Close the |Preview )/ })
// A row's accessible label starts as `Title, @handle, branch,` (no handle where it has none).
const named = (title: string, branch = "") =>
  new RegExp(`^${title}, (?:@[\\w-]+, )?${branch === "" ? "[^,]*" : branch},`)
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
const trash = (title: string, branch: string) =>
  itemOf(title, branch).getByRole("button", { name: /^Close the / })
// Presses a row's trash button, which slides in under the pointer: the row first (a safe row's
// shows at rest).
const pressTrash = async (title: string, branch: string): Promise<void> => {
  await row(title, branch).hover()
  await trash(title, branch).click()
}
const dialog = () => page.getByRole("alertdialog", { name: "Close this worktree?" })

describe("The Worktrees panel", () => {
  context("when the backend reports works", () => {
    it("has a rail button and counts the open project's works", async () => {
      await openWorkspace(storefront)

      await expect.element(sidebarPanel("Worktrees")).toBeChecked()
      await expect.element(sidebar()).toHaveAccessibleName("Worktrees")
      await expect.element(page.getByRole("heading", { name: "Worktrees 7" })).toBeVisible()
    })

    it("lists them by what's next (Needs you, In progress, In review, Done), newest first in each, and says where each stands", async () => {
      await openWorkspace(storefront)

      await expect.element(rows().first()).toBeVisible()
      expect(labels()).toEqual([
        "Tests, @owl, agent/tests, 2 files changed, 85 lines added, 18 removed, conflicts with Checkout implementation, CI failing, ready for review, 1 commit not pushed",
        "Checkout implementation, @moth, agent/checkout-implementation, 5 files changed, 324 lines added, 56 removed, conflicts with main, Tests, draft, no CI, 3 commits not pushed",
        "Build, @raven, agent/build-cache, 0 files changed, no PR yet",
        "Checkout review, @crow, agent/checkout-review, 1 file changed, 6 lines added, 2 removed, working, ready for review, CI running",
        "Build, @raven, agent/build, 2 files changed, 11 lines added, 5 removed, ready for review, CI passed",
        "No owner, agent/promo-banner, 1 file changed, 18 lines added, 2 removed, PR closed, safe to trash",
        "Build, @raven, agent/build-lint, 0 files changed, merged, safe to trash",
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

      await expect.element(page.getByRole("heading", { name: "Worktrees 2" })).toBeVisible()
      expect(labels()).toEqual([
        "Tests, @owl, agent/tests, 1 file changed, 47 lines added, 5 removed, no PR yet",
        "Checkout implementation, @moth, agent/checkout-implementation, 2 files changed, 92 lines added, 11 removed, no PR yet",
      ])
      await expect.element(list().getByText("api-service")).not.toBeInTheDocument()
    })

    it("switches its list with the project, while it shows", async () => {
      await openWorkspace(storefront)
      await expect.element(page.getByRole("heading", { name: "Worktrees 7" })).toBeVisible()

      await workspaceSwitcher().click()
      await page
        .getByRole("dialog", { name: "Switch workspace" })
        .getByRole("button", { name: /^api-service / })
        .click()

      await expect.element(page.getByRole("heading", { name: "Worktrees 2" })).toBeVisible()
      await expect.element(row("Tests", "agent/tests")).toBeVisible()
      await expect.element(row("Build")).not.toBeInTheDocument()
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
      await sidebarPanel("Worktrees").click()
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

  context("when a row's trash button is used", () => {
    it("asks before closing a worktree that differs from main, saying what is kept", async () => {
      await openWorkspace(storefront)

      await pressTrash("Tests", "agent/tests")

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

      await pressTrash("Tests", "agent/tests")
      await dialog().getByRole("button", { name: "Close worktree" }).click()

      await expect.element(row("Tests")).not.toBeInTheDocument()
      await expect.element(page.getByRole("heading", { name: "Worktrees 6" })).toBeVisible()
    })

    it("closes a worktree that differs from nothing at once", async () => {
      await openWorkspace(storefront)

      await pressTrash("Build", "agent/build-cache")

      await expect.element(dialog()).not.toBeInTheDocument()
      await expect.element(row("Build", "agent/build-cache")).not.toBeInTheDocument()
    })

    it("waits while the owner's agent is working in the worktree", async () => {
      await openWorkspace(storefront)

      await expect
        .element(trash("Checkout review", "agent/checkout-review"))
        .toHaveAttribute("aria-disabled", "true")
      // On the button, slid in under the pointer: forced, as a click waits for an aria-disabled
      // button to take one.
      await row("Checkout review", "agent/checkout-review").hover()
      await trash("Checkout review", "agent/checkout-review").click({ force: true })
      await expect.element(dialog()).not.toBeInTheDocument()
      await expect.element(row("Checkout review")).toBeVisible()
    })

    it("closes a safe worktree with no owner at once, its trash button shown at rest", async () => {
      await openWorkspace(storefront)

      await expect.element(itemOf("No owner")).toBeVisible()
      await expect.element(itemOf("No owner")).toHaveAttribute("data-safe", "true")
      // In its place with the pointer elsewhere, not slid out as an unsafe row's is.
      await page.getByRole("heading", { name: /^Worktrees/ }).hover()
      const button = trash("No owner", "agent/promo-banner").element()
      await expect.poll(() => getComputedStyle(button).transform).toBe("none")
      await trash("No owner", "agent/promo-banner").click()

      await expect.element(itemOf("No owner")).not.toBeInTheDocument()
      await expect.element(dialog()).not.toBeInTheDocument()
    })

    it("trashes every safe worktree after one confirm, and keeps the rest", async () => {
      await openWorkspace(storefront)

      await list().getByRole("button", { name: "Trash 2 safe" }).click()
      const sweep = page.getByRole("alertdialog", { name: /Trash 2 worktrees\?/ })
      await expect.element(sweep.getByText("No owner (agent/promo-banner)")).toBeVisible()
      await expect.element(sweep.getByText("Build (agent/build-lint)")).toBeVisible()
      await sweep.getByRole("button", { name: "Trash them" }).click()

      await expect.element(itemOf("No owner")).not.toBeInTheDocument()
      await expect.element(itemOf("Build", "agent/build-lint")).not.toBeInTheDocument()
      await expect.element(page.getByRole("heading", { name: "Worktrees 5" })).toBeVisible()
    })
  })
})
