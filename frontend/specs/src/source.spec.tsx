import { describe as context, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import { openWorkspace, sidebarPanel } from "./support/workspace"

// The agents demo has a Source panel with the storefront's files; nobody is writing as it opens,
// so a row's marks and chips hold still.
const agents = "/?demo=agents"

const skipIntro = async (): Promise<void> => {
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
}

describe("The Source panel", () => {
  context("when the demo has a source to show", () => {
    it("opens from its toggle on the storefront's files, each with who changed it", async () => {
      await openWorkspace(agents)
      await skipIntro()

      await sidebarPanel("Source").click()

      await expect.element(page.getByRole("tree", { name: "Project files" })).toBeVisible()
      await expect
        .element(page.getByRole("treeitem", { name: /^Checkout\.tsx, modified, .*@crow/ }))
        .toHaveAccessibleName(/@moth/)
    })

    it("keeps one chip and a count on a row whose name has no room beside two", async () => {
      await openWorkspace(agents)
      await skipIntro()
      await sidebarPanel("Source").click()

      const select = page.getByRole("treeitem", { name: /^Checkout\.tsx,/ })
      await expect.element(select).toBeVisible()
      const row = select.element().closest(".source-row")!

      // Checkout.tsx was changed by two agents, and its row at the default width cannot hold
      // its name and two chips.
      expect(row.querySelectorAll(".source-chip")).toHaveLength(1)
      expect(row.querySelector(".source-more")?.textContent).toBe("+1")
    })
  })

  context("when the demo has no source", () => {
    it("has no Source toggle", async () => {
      await openWorkspace()

      await expect.element(sidebarPanel("Terminals")).toBeVisible()
      await expect.element(sidebarPanel("Source")).not.toBeInTheDocument()
    })
  })
})
