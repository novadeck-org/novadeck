import { describe as context, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import { openWorkspace, sidebar, sidebarPanel } from "./support/workspace"

// The agents demo: docs-site's agent asks a question, and a moment after it other
// projects finish, while the person looks at storefront.
const agents = "/?demo=agents"
const bell = () => page.getByRole("radio", { name: /^Notifications, \d+ waiting$/ })
const enterZen = () => page.getByRole("button", { name: "Enter Zen mode" })
const zenBell = () =>
  page
    .getByRole("group", { name: "Zen controls" })
    .getByRole("button", { name: /^Notifications, \d+ waiting$/ })

const skipIntro = async (): Promise<void> => {
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
}

describe("The notification bell", () => {
  context("when something waits on the person", () => {
    it("counts it on the rail, in the bell's name", async () => {
      await openWorkspace(agents)
      await skipIntro()

      await expect.element(bell()).toBeVisible()
      await expect.element(bell()).toHaveAccessibleName(/^Notifications, [1-9]\d* waiting$/)
    })
  })

  context("when nothing waits", () => {
    it("is a plain bell, with no count in its name", async () => {
      await openWorkspace()

      await expect.element(sidebarPanel("Notifications")).toHaveAccessibleName("Notifications")
      await expect.element(bell()).not.toBeInTheDocument()
    })
  })

  context("when opening a link to the panel", () => {
    it("shows the Notifications sidebar", async () => {
      await openWorkspace(`${agents}&panel=notifications`)
      await skipIntro()

      await expect.element(sidebar()).toHaveAccessibleName("Notifications")
      await expect.element(sidebarPanel("Notifications")).toBeChecked()
    })
  })

  context("when going Back and Forward between panels", () => {
    it("restores the panel each step showed", async () => {
      await openWorkspace(agents)
      await skipIntro()
      await sidebarPanel("Notifications").click()
      await expect.element(sidebarPanel("Notifications")).toBeChecked()
      await sidebarPanel("Sessions").click()
      await expect.element(sidebarPanel("Sessions")).toBeChecked()

      history.back()
      await expect.element(sidebarPanel("Notifications")).toBeChecked()

      history.back()
      await expect.element(sidebarPanel("Notifications")).not.toBeChecked()

      history.forward()
      history.forward()
      await expect.element(sidebarPanel("Sessions")).toBeChecked()
    })
  })

  context("when in Zen", () => {
    it("has no bell until something waits", async () => {
      await openWorkspace()
      await enterZen().click()

      await expect.element(page.getByRole("group", { name: "Zen controls" })).toBeVisible()
      await expect.element(zenBell()).not.toBeInTheDocument()
    })

    it("opens the panel from the bell and hands focus to the rail", async () => {
      await openWorkspace(agents)
      await skipIntro()
      await enterZen().click()
      await expect.element(zenBell()).toBeVisible()

      await zenBell().click()

      await expect.element(sidebarPanel("Notifications")).toBeChecked()
      await expect.element(enterZen()).toBeVisible()
      await expect.poll(() => document.activeElement?.id).toBe("notifications-toggle")
    })
  })
})
