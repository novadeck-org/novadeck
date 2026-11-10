import { page } from "vitest/browser"

import { taskbarIcons } from "../support/companions"
import { expectSelected, openWorkspace, sidebar, sidebarPanel } from "../support/workspace"
import { context, describe, expect, it } from "../test"

// The plain demo's storefront has four works: Checkout implementation and Tests unread, in
// conflict with each other (and the first with main); Checkout review and Build read.
const storefront = "/projects/storefront/sessions/initial/focus?panel=changes"
// Its dotfiles project has none.
const dotfiles = "/projects/dotfiles/sessions/initial/focus?panel=changes"
const showcase = "/projects/studio/sessions/initial/focus?demo=showcase&panel=changes"

const list = () => page.getByRole("list", { name: "Changes" })
const rows = () => list().getByRole("button")
const row = (title: string) => list().getByRole("button", { name: new RegExp(`^${title},`) })
const labels = () =>
  rows()
    .elements()
    .map((element) => element.getAttribute("aria-label"))
const itemOf = (title: string) =>
  list()
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: new RegExp(`^${title},`) }) })

describe("The Changes panel", () => {
  context("when the backend reports works", () => {
    it("has a rail button and counts the project's works", async () => {
      await openWorkspace(storefront)

      await expect.element(sidebarPanel("Changes")).toBeChecked()
      await expect.element(sidebar()).toHaveAccessibleName("Changes")
      await expect.element(page.getByRole("heading", { name: "Changes 4" })).toBeVisible()
    })

    it("lists them first come, first served, the unread above the read", async () => {
      await openWorkspace(storefront)

      await expect.element(rows().first()).toBeVisible()
      expect(labels()).toEqual([
        "Checkout implementation, 4 files changed, conflicts with main, Tests",
        "Tests, 2 files changed, conflicts with Checkout implementation",
        "Build, 2 files changed",
        "Checkout review, 1 file changed",
      ])
      // The line the Inbox draws above its updates comes before the first read work.
      await expect.element(itemOf("Build")).toHaveAttribute("data-read-start", "true")
    })

    it("shows the unread lines top right, and nothing once read", async () => {
      await openWorkspace(storefront)

      await expect.element(itemOf("Tests").getByText("+85")).toBeVisible()
      await expect.element(itemOf("Build").getByText(/^\+\d/)).not.toBeInTheDocument()
    })

    it("marks a work in conflict, and names what it conflicts with", async () => {
      await openWorkspace(storefront)

      await expect.element(itemOf("Tests")).toHaveAttribute("data-conflict", "true")
      await expect.element(itemOf("Build")).not.toHaveAttribute("data-conflict")
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
        "Build",
        "Checkout review",
        "Tests",
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

  context("when the project has no work", () => {
    it("says nothing is unmerged", async () => {
      await openWorkspace(dotfiles)

      await expect.element(page.getByText("Nothing unmerged")).toBeVisible()
      await expect
        .element(
          page.getByText("When an agent here changes files, its work shows up in this list."),
        )
        .toBeVisible()
    })
  })
})
