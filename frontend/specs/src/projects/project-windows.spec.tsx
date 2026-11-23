import { page, userEvent } from "vitest/browser"

import { projectWindows } from "../support/backend"
import { workspaceSwitcher } from "../support/sessions"
import { expectStaysAbsent, openWorkspace } from "../support/workspace"
import { context, describe, expect, it } from "../test"

// The demo's projects, as a person leaves them, in an app that opens windows.
const open = async (kind: "on" | "extra" = "on"): Promise<void> => {
  await openWorkspace(`/?windows=${kind}`)
}

const marks = (): HTMLElement[] =>
  page.getByRole("img", { name: "Shown in another window" }).elements() as HTMLElement[]

describe("project windows in the header", () => {
  context("when another window shows a project", () => {
    it("marks it in the switcher, and in the pins bar when it is pinned", async () => {
      localStorage.setItem(
        "novadeck.project-arrangement",
        JSON.stringify({ order: ["docs-site"], pinned: ["docs-site"] }),
      )
      await open()
      projectWindows.pretend(["docs-site"])

      await expect.element(page.getByRole("group", { name: "Pinned projects" })).toBeVisible()
      await expect
        .element(
          page
            .getByRole("group", { name: "Pinned projects" })
            .getByRole("img", { name: "Shown in another window" }),
        )
        .toBeVisible()
      await workspaceSwitcher().click()
      await expect
        .element(
          page
            .getByRole("dialog", { name: "Switch workspace" })
            .getByRole("img", { name: "Shown in another window" }),
        )
        .toBeVisible()
    })

    it("shows it here when the person picks it, the mark staying as a hint", async () => {
      await open()
      projectWindows.pretend(["docs-site"])
      await workspaceSwitcher().click()
      await page
        .getByRole("dialog", { name: "Switch workspace" })
        .getByRole("button", { name: /^docs-site/ })
        .click()

      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
      await workspaceSwitcher().click()
      await expect
        .element(
          page
            .getByRole("dialog", { name: "Switch workspace" })
            .getByRole("button", { name: /^docs-site/ })
            .getByRole("img", { name: "Shown in another window" }),
        )
        .toBeVisible()
      expect(marks()).toHaveLength(1)
    })
  })

  context("when the person right-clicks a project", () => {
    it("offers Open in new window, and shows the project in another window", async () => {
      await open()
      await workspaceSwitcher().click()
      await userEvent.click(
        page
          .getByRole("dialog", { name: "Switch workspace" })
          .getByRole("button", { name: /^docs-site/ }),
        { button: "right" } as never,
      )
      await page.getByRole("menuitem", { name: "Open in new window" }).click()
      await expect
        .element(
          page
            .getByRole("dialog", { name: "Switch workspace" })
            .getByRole("button", { name: /^docs-site/ })
            .getByRole("img", { name: "Shown in another window" }),
        )
        .toBeVisible()
    })
  })

  context("in an app that opens no windows, as a browser", () => {
    it("has no project menu to open one, and marks nothing", async () => {
      await openWorkspace("/")
      await workspaceSwitcher().click()
      const row = page
        .getByRole("dialog", { name: "Switch workspace" })
        .getByRole("button", { name: /^docs-site/ })
      await expect.element(row).toBeVisible()
      await userEvent.click(row, { button: "right" } as never)
      await expectStaysAbsent(page.getByRole("menu", { name: "docs-site actions" }))
      await expectStaysAbsent(page.getByRole("img", { name: "Shown in another window" }))
    })
  })

  context("when another window sends this one to a project", () => {
    it("shows that project", async () => {
      await open()
      projectWindows.send("docs-site")
      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
    })
  })

  context("when the window is not the app's first", () => {
    it("leaves the welcome dialog to the first window", async () => {
      await openWorkspace("/?demo=welcome&windows=extra")
      await expectStaysAbsent(page.getByRole("dialog", { name: "Welcome to Novadeck" }))
    })

    it("shows the welcome dialog in the first", async () => {
      await openWorkspace("/?demo=welcome&windows=on")
      await expect.element(page.getByRole("dialog", { name: "Welcome to Novadeck" })).toBeVisible()
    })
  })
})
