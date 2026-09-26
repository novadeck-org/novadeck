import { describe as context, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import {
  currentRoute,
  emptyWorkspace,
  pressNewSession,
  run,
  switchProject,
  visit,
  workspaceSwitcher,
} from "./support/sessions"
import {
  chooseView,
  commandInput,
  expectSelected,
  expectStaysAbsent,
  openWorkspace,
  reloadWorkspace,
  sidebar,
  sidebarPanel,
  terminal,
  terminalTab,
  view,
} from "./support/workspace"

const home = "/projects/storefront/sessions/initial/focus?terminal=01"
const apiCanvas = "/projects/api-service/sessions/initial/canvas?terminal=02"

const preferences = () => page.getByRole("dialog", { name: "Preferences" })
const search = () => page.getByRole("dialog", { name: "Find a terminal" })

describe("deep links", () => {
  context("when opening a link to a project, session, view, and terminal", () => {
    it("shows that project in that view with that terminal selected", async () => {
      await openWorkspace(apiCanvas)

      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      await expect.element(view("Canvas")).toBeChecked()
      await expectSelected("Dev server")
      await expect
        .element(terminal("Checkout implementation").getByText("~/projects/api-service"))
        .toBeInTheDocument()
    })

    it("opens the Sessions sidebar when the link names it", async () => {
      await openWorkspace(`${apiCanvas}&panel=sessions`)

      await expect.element(sidebar()).toHaveAccessibleName("Workspace sessions")
      await expect.element(sidebarPanel("Sessions")).toBeChecked()
    })

    it("keeps showing the linked destination after a reload", async () => {
      await openWorkspace(apiCanvas)

      await reloadWorkspace()

      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      await expect.element(view("Canvas")).toBeChecked()
      await expectSelected("Dev server")
      expect(currentRoute()).toBe(apiCanvas)
    })
  })

  context("when opening a link to a dialog", () => {
    it("opens search", async () => {
      await openWorkspace(`${home}&dialog=search`)

      await expect.element(search()).toBeVisible()
    })

    it("opens Preferences on the requested section", async () => {
      await openWorkspace(`${apiCanvas}&dialog=preferences&section=shortcuts`)

      await expect.element(preferences()).toBeVisible()
      await expect
        .element(preferences().getByRole("tab", { name: "Shortcuts" }))
        .toHaveAttribute("aria-selected", "true")
    })

    it("returns to the linked workspace when the dialog closes", async () => {
      await openWorkspace(`${apiCanvas}&dialog=preferences&section=shortcuts`)

      await page.getByRole("button", { name: "Close preferences" }).click()

      await expect.element(preferences()).not.toBeInTheDocument()
      await expect.element(view("Canvas")).toBeChecked()
      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      await expect.poll(currentRoute).toBe(apiCanvas)
    })
  })

  context("when a link cannot be followed", () => {
    it("replaces an unknown route with the default workspace", async () => {
      await openWorkspace("/unknown/path")

      await expect.element(view("Focus")).toBeChecked()
      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await expect.poll(currentRoute).toBe(home)
    })

    it("falls back from a missing project, session, terminal, and dialog", async () => {
      await openWorkspace("/projects/missing/sessions/expired/grid?terminal=missing&dialog=invalid")

      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")
      await expect.element(view("Grid")).toBeChecked()
      await expectSelected("Checkout implementation")
      await expectStaysAbsent(page.getByRole("dialog"))
      await expect.poll(currentRoute).toBe(home.replace("focus", "grid"))
    })

    it("falls back from a link to a disabled view", async () => {
      await openWorkspace()
      await page.getByRole("button", { name: "Workspace preferences" }).click()
      await preferences().getByText("Canvas", { exact: true }).click()
      await expect
        .element(preferences().getByRole("checkbox", { name: "Canvas" }))
        .not.toBeChecked()
      await page.getByRole("button", { name: "Close preferences" }).click()
      await expect.element(view("Canvas")).not.toBeInTheDocument()

      visit(home.replace("focus", "canvas"))

      await expect.poll(currentRoute).toBe(home)
      await expect.element(view("Focus")).toBeChecked()
    })

    it("falls back from a session that expired on reload", async () => {
      await openWorkspace()
      await pressNewSession()
      await expect.element(emptyWorkspace()).toBeVisible()
      expect(currentRoute()).not.toContain("/sessions/initial/")

      await reloadWorkspace()

      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await expect.poll(currentRoute).toContain("/projects/storefront/sessions/initial/")
    })

    it("does not bring back a closed terminal", async () => {
      await openWorkspace()
      await terminalTab("Runtime").click()
      await terminal("Runtime").getByRole("button", { name: "Close Runtime" }).click()
      await expect.element(terminalTab("Runtime")).not.toBeInTheDocument()

      visit(home.replace("terminal=01", "terminal=05"))

      await expect.poll(currentRoute).toBe(home.replace("terminal=01", "terminal=06"))
      await expectStaysAbsent(terminalTab("Runtime"))
    })
  })
})

describe("browser history", () => {
  context("when going Back and Forward through terminal and view changes", () => {
    it("restores each step without discarding drafts", async () => {
      await openWorkspace(home)
      await commandInput("Checkout implementation").fill("unfinished")
      await terminalTab("Runtime").click()
      await expect.element(terminal("Runtime")).toBeVisible()
      await chooseView("Grid")

      history.back()
      await expect.element(view("Focus")).toBeChecked()
      await expect.element(terminal("Runtime")).toBeVisible()

      history.back()
      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await expect.element(commandInput("Checkout implementation")).toHaveValue("unfinished")

      history.forward()
      await expect.element(terminal("Runtime")).toBeVisible()
      history.forward()
      await expect.element(view("Grid")).toBeChecked()
      await expectSelected("Runtime")
    })
  })

  context("when going Back from a new session", () => {
    it("returns to the previous session with its output and drafts", async () => {
      await openWorkspace(home)
      await run(commandInput("Checkout implementation"), "echo kept output")
      await commandInput("Checkout implementation").fill("kept draft")
      await pressNewSession()
      await expect.element(emptyWorkspace()).toBeVisible()

      history.back()

      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await expect.element(page.getByText("kept output", { exact: true })).toBeVisible()
      await expect.element(commandInput("Checkout implementation")).toHaveValue("kept draft")

      history.forward()

      await expect.element(emptyWorkspace()).toBeVisible()
    })
  })

  context("when going Back across projects", () => {
    it("returns to the previous project", async () => {
      await openWorkspace(home)
      await switchProject("api-service")

      history.back()

      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")
    })
  })

  context("when going Back to a terminal that was closed", () => {
    it("does not bring it back", async () => {
      await openWorkspace(home)
      await terminalTab("Runtime").click()
      await terminal("Runtime").getByRole("button", { name: "Close Runtime" }).click()
      await expect.element(terminalTab("Runtime")).not.toBeInTheDocument()
      await expect.element(terminal("Build")).toBeVisible()

      history.back()

      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await expectStaysAbsent(terminalTab("Runtime"))
    })
  })

  context("when going Back and Forward through dialogs", () => {
    it("closes and reopens Preferences and its sections", async () => {
      await openWorkspace(home)
      await page.getByRole("button", { name: "Workspace preferences" }).click()
      await preferences().getByRole("tab", { name: "Shortcuts" }).click()
      await expect
        .element(preferences().getByRole("tab", { name: "Shortcuts" }))
        .toHaveAttribute("aria-selected", "true")

      history.back()
      await expect
        .element(preferences().getByRole("tab", { name: "General" }))
        .toHaveAttribute("aria-selected", "true")

      history.back()
      await expect.element(preferences()).not.toBeInTheDocument()

      history.forward()
      await expect.element(preferences()).toBeVisible()
    })

    it("does not reopen a dialog that was closed in the app", async () => {
      await openWorkspace(home)
      await switchProject("api-service")
      await page.getByRole("button", { name: "Workspace preferences" }).click()
      await expect.element(preferences()).toBeVisible()
      await page.getByRole("button", { name: "Close preferences" }).click()
      await expect.element(preferences()).not.toBeInTheDocument()

      history.back()

      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")
      await expectStaysAbsent(preferences())
    })
  })
})
