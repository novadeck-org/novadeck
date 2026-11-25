import { page, userEvent } from "vitest/browser"

import { worktreeHeadsTo } from "../support/backend"
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

// The panel's rows stand in one list, newest first.
const list = () => page.getByRole("region", { name: /^Worktrees( \d+)?$/ })
const rows = () =>
  list()
    .getByRole("listitem")
    .getByRole("button", { name: /^(?!Close the |Open #)/ })
// A row's accessible label starts with its title (its branch where it has none) and says
// `branch into target` further on.
const named = (title: string, branch = "") =>
  new RegExp(`^${title}, .*${branch === "" ? "[^,]*" : branch} into `)
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
// Presses a row's trash button, which comes in under the pointer.
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

    it("lists them flat, newest first, and says where each stands and goes", async () => {
      await openWorkspace(storefront)

      await expect.element(rows().first()).toBeVisible()
      expect(labels()).toEqual([
        "Cache the build between runs, nothing in it yet, agent/build-cache into main, @raven",
        "Tests, #814, open pull request, 3 of 4 checks passed, 1 failed; changes requested, checks failed, agent/tests into main, Conflicts with Checkout implementation, @owl",
        "Checkout implementation, #812, draft pull request, no review asked for, agent/checkout-implementation into main, Conflicts with main, Tests, @moth",
        "Checkout review, #816, open pull request, 2 of 4 checks passed, 1 running, 1 waiting; approval missing, files changing, agent/checkout-review into main, @crow",
        "Build, #818, open pull request, 4 of 4 checks passed; approved, agent/build into main, Checks passed: yours to merge, @raven",
        "agent/promo-banner, #801, closed pull request, pull request closed, agent/promo-banner into main, no agent",
        "Lint fixes for the build, #809, merged pull request, landed in main, agent/build-lint into main, @raven",
      ])
    })

    it("lists another project's works once that project is open, and names no project", async () => {
      await openWorkspace(apiService)

      await expect.element(page.getByRole("heading", { name: "Worktrees 2" })).toBeVisible()
      expect(labels()).toEqual([
        "Tests, agent/tests into main, @owl",
        "Checkout implementation, agent/checkout-implementation into main, @moth",
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

    it("marks a merged work landed, and one just made empty", async () => {
      await openWorkspace(storefront)

      await expect
        .element(itemOf("Lint fixes for the build"))
        .toHaveAttribute("data-state", "landed")
      await expect
        .element(itemOf("Cache the build between runs"))
        .toHaveAttribute("data-state", "empty")
    })

    it("marks a work in conflict with !, and one whose checks passed with ?", async () => {
      await openWorkspace(storefront)

      await expect.element(itemOf("Tests", "agent/tests")).toHaveAttribute("data-need", "unblock")
      await expect.element(itemOf("Build", "agent/build")).toHaveAttribute("data-need", "ask")
      await expect.element(itemOf("Checkout review")).not.toHaveAttribute("data-need")
    })
  })

  context("when a worktree heads to another's branch", () => {
    const listed = () =>
      [...document.querySelectorAll<HTMLElement>("[data-worktrees-row]")].map((each) =>
        each.dataset.worktreesRow!.split("/").at(-2),
      )
    const gutter = () => document.querySelector<HTMLElement>("[data-team-wire-gutter]")
    // A row by its worktree's folder, found though folded out of the list.
    const byFolder = (folder: string) =>
      [...document.querySelectorAll<HTMLElement>("[data-worktrees-row]")].find(
        (each) => each.dataset.worktreesRow!.split("/").at(-2) === folder,
      )

    it("hangs it under that one on the team wire, lit while either is selected", async () => {
      await openWorkspace(storefront)
      await expect.element(rows().first()).toBeVisible()
      worktreeHeadsTo("agent/build", "agent/tests")

      await expect
        .poll(listed)
        .toEqual([
          "agent-build-cache",
          "agent-tests",
          "agent-build",
          "agent-checkout-implementation",
          "agent-checkout-review",
          "agent-promo-banner",
          "agent-build-lint",
        ])
      await expect.element(itemOf("Build", "agent/build")).toHaveAttribute("data-team-level", "1")
      await expect
        .element(row("Build", "agent/build"))
        .toHaveAccessibleName(/agent\/build into agent\/tests/)
      await expect.poll(() => document.querySelectorAll(".team-wire-shape").length).toBe(1)

      await row("Build", "agent/build").click()
      await expect.element(itemOf("Tests", "agent/tests")).toHaveAttribute("data-team", "lead")
      await expect
        .poll(() => document.querySelectorAll(".team-wire-shape[data-lit]").length)
        .toBe(1)
    })

    it("folds it into that one's row from the gutter beside it, and back", async () => {
      await openWorkspace(storefront)
      await expect.element(rows().first()).toBeVisible()
      worktreeHeadsTo("agent/build", "agent/tests")
      await row("Cache the build between runs").click()
      await expect.poll(gutter).not.toBeNull()

      await userEvent.hover(gutter()!)
      await userEvent.click(gutter()!)

      await expect.poll(() => byFolder("agent-build")?.dataset.teamFold).toBe("away")
      const folded = byFolder("agent-tests")?.querySelector("[data-team-fold-row]")
      expect(folded?.textContent).toContain("Build")
      await userEvent.click(gutter()!)
      await expect.poll(() => byFolder("agent-build")?.dataset.teamFold).not.toBe("away")
    })
  })

  context("when a row is picked", () => {
    it("selects its terminal", async () => {
      await openWorkspace(storefront)

      await row("Tests").click()

      await sidebarPanel("Terminals").click()
      await expectSelected("Tests")
      await sidebarPanel("Worktrees").click()
      await expect.element(itemOf("Tests")).toHaveAttribute("data-selected", "true")
    })

    it("keeps the clicked worktree selected among its owner's others", async () => {
      await openWorkspace(storefront)

      await row("Cache the build between runs").click()

      await expect
        .element(itemOf("Cache the build between runs"))
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

      await pressTrash("Cache the build between runs", "agent/build-cache")

      await expect.element(dialog()).not.toBeInTheDocument()
      await expect.element(row("Cache the build between runs")).not.toBeInTheDocument()
    })

    it("waits while the owner's agent is working in the worktree", async () => {
      await openWorkspace(storefront)

      await expect
        .element(trash("Checkout review", "agent/checkout-review"))
        .toHaveAttribute("aria-disabled", "true")
      // On the button, in place under the pointer: forced, as a click waits for an aria-disabled
      // button to take one.
      await row("Checkout review", "agent/checkout-review").hover()
      await trash("Checkout review", "agent/checkout-review").click({ force: true })
      await expect.element(dialog()).not.toBeInTheDocument()
      await expect.element(row("Checkout review")).toBeVisible()
    })

    it("closes a safe worktree with no owner at once, its trash at full strength", async () => {
      await openWorkspace(storefront)

      await expect.element(itemOf("agent/promo-banner")).toHaveAttribute("data-safe", "true")
      await row("agent/promo-banner").hover()
      const button = trash("agent/promo-banner", "agent/promo-banner").element()
      await expect.poll(() => getComputedStyle(button).opacity).toBe("1")
      await trash("agent/promo-banner", "agent/promo-banner").click()

      await expect.element(itemOf("agent/promo-banner")).not.toBeInTheDocument()
      await expect.element(dialog()).not.toBeInTheDocument()
    })

    it("trashes every safe worktree from the header after one confirm, and keeps the rest", async () => {
      await openWorkspace(storefront)

      await page.getByRole("button", { name: "Trash 2 safe worktrees" }).click()
      const sweep = page.getByRole("alertdialog", { name: /Trash 2 worktrees\?/ })
      await expect.element(sweep.getByText("agent/promo-banner")).toBeVisible()
      await expect
        .element(sweep.getByText("Lint fixes for the build (agent/build-lint)"))
        .toBeVisible()
      await sweep.getByRole("button", { name: "Trash them" }).click()

      await expect.element(itemOf("agent/promo-banner")).not.toBeInTheDocument()
      await expect.element(itemOf("Lint fixes for the build")).not.toBeInTheDocument()
      await expect.element(page.getByRole("heading", { name: "Worktrees 5" })).toBeVisible()
    })
  })
})
