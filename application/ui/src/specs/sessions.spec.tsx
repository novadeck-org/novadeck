import { afterEach, describe as context, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import {
  currentSessionName,
  emptyWorkspace,
  expectCurrentSession,
  newSessionName,
  pressNewSession,
  run,
  savedSession,
  savedSessions,
  switchProject,
  workspaceSwitcher,
} from "./support/sessions"
import {
  chooseView,
  commandInput,
  expectSelected,
  expectStaysAbsent,
  isMac,
  openWorkspace,
  press,
  sidebar,
  sidebarPanel,
  terminal,
  terminalTab,
  view,
} from "./support/workspace"

describe("projects", () => {
  context("when opening the Switch workspace menu", () => {
    it("lists every project and marks the current one", async () => {
      await openWorkspace()

      await workspaceSwitcher().click()

      const menu = page.getByRole("dialog", { name: "Switch workspace" })
      await expect
        .element(menu.getByRole("button", { name: /^storefront / }))
        .toHaveAttribute("aria-current", "true")
      await expect
        .element(menu.getByRole("button", { name: /^api-service / }))
        .not.toHaveAttribute("aria-current")
    })
  })

  context("when switching to another project", () => {
    it("shows that project's terminals", async () => {
      await openWorkspace()
      await expect
        .element(terminal("Checkout implementation").getByText("~/projects/storefront"))
        .toBeVisible()

      await switchProject("api-service")

      await expect
        .element(terminal("Checkout implementation").getByText("~/projects/api-service"))
        .toBeVisible()
      await expect.element(page.getByText("~/projects/storefront")).not.toBeInTheDocument()
    })

    it("keeps each project's terminals, output, and selection separate", async () => {
      await openWorkspace()
      await terminalTab("Runtime").click()
      await run(commandInput("Runtime"), "echo storefront history")
      await sidebar().getByRole("button", { name: "Close Build" }).click()
      await expect.element(terminalTab("Build")).not.toBeInTheDocument()

      await switchProject("api-service")

      await expect.element(terminalTab("Build")).toBeVisible()
      await expectSelected("Checkout implementation")
      await expectStaysAbsent(page.getByText("storefront history", { exact: true }))

      await switchProject("storefront")

      await expect.element(terminalTab("Build")).not.toBeInTheDocument()
      await expectSelected("Runtime")
      await expect.element(page.getByText("storefront history", { exact: true })).toBeVisible()
    })
  })
})

describe("sessions sidebar", () => {
  context("when opening the Sessions panel", () => {
    it("lists the project's saved sessions with their terminal counts", async () => {
      await openWorkspace()

      await sidebarPanel("Sessions").click()

      await expect.element(sidebar()).toHaveAccessibleName("Workspace sessions")
      await expect
        .element(savedSessions().getByRole("listitem").getByText("6 terminals", { exact: true }))
        .toBeVisible()
      // The sample workspace has one session, and it is the one shown.
      await expect
        .element(savedSessions().getByRole("button"))
        .toHaveAttribute("aria-current", "true")
      await expect.element(terminalTab("Runtime")).not.toBeInTheDocument()
    })
  })

  context("when choosing New session", () => {
    it("creates and selects an empty session in the current project", async () => {
      await openWorkspace()
      await sidebarPanel("Sessions").click()
      const original = await currentSessionName()

      await page.getByRole("button", { name: "New session" }).click()

      await expect.element(emptyWorkspace()).toBeVisible()
      const fresh = await newSessionName(original)
      await expect.poll(() => savedSessions().getByRole("listitem").elements()).toHaveLength(2)
      await expect
        .element(savedSession(fresh).getByText("0 terminals", { exact: true }))
        .toBeVisible()
      await expect
        .element(savedSession(original).getByText("6 terminals", { exact: true }))
        .toBeVisible()
      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")
    })
  })

  context("when pressing the new-session shortcut", () => {
    it("creates an empty session and opens the Sessions sidebar", async () => {
      await openWorkspace()
      await sidebarPanel("Terminals").click()
      await expect.element(sidebar()).not.toBeInTheDocument()
      await commandInput("Checkout implementation").click()

      await pressNewSession()

      await expect.element(emptyWorkspace()).toBeVisible()
      await expect.element(sidebarPanel("Sessions")).toBeChecked()
      await expect.element(sidebar()).toHaveAccessibleName("Workspace sessions")
      await expect.poll(() => savedSessions().getByRole("listitem").elements()).toHaveLength(2)
      await expect
        .element(savedSessions().getByRole("button").getByText("0 terminals", { exact: true }))
        .toBeVisible()
      await expect
        .element(savedSessions().getByRole("button").filter({ hasText: "0 terminals" }))
        .toHaveAttribute("aria-current", "true")
    })

    it("shows the shortcut on the New session control", async () => {
      await openWorkspace()

      await sidebarPanel("Sessions").click()

      await expect
        .element(
          page
            .getByRole("button", { name: "New session" })
            .getByText(isMac() ? "⌘ Shift N" : "Ctrl Shift N", { exact: true }),
        )
        .toBeVisible()
    })
  })

  context("when selecting a saved session", () => {
    it("switches back to its terminals with their output and drafts", async () => {
      await openWorkspace()
      await terminalTab("Runtime").click()
      await run(commandInput("Runtime"), "echo saved output")
      await commandInput("Runtime").fill("echo unfinished")
      await sidebarPanel("Sessions").click()
      const original = await currentSessionName()
      await page.getByRole("button", { name: "New session" }).click()
      await expect.element(emptyWorkspace()).toBeVisible()

      await savedSession(original).click()

      await expect.element(terminal("Runtime")).toBeVisible()
      await expect.element(commandInput("Runtime")).toHaveValue("echo unfinished")
      await expect.element(page.getByText("saved output", { exact: true })).toBeVisible()
      await expectCurrentSession(original)
    })

    it("keeps a new session's terminals apart from the original session", async () => {
      await openWorkspace()
      await sidebarPanel("Sessions").click()
      const original = await currentSessionName()
      await page.getByRole("button", { name: "New session" }).click()
      await expect.element(emptyWorkspace()).toBeVisible()
      const fresh = await newSessionName(original)
      await page.getByRole("button", { name: "New terminal" }).click()
      await press("{Escape}")
      await commandInput("Terminal 01").fill("new draft")

      await sidebarPanel("Sessions").click()
      await savedSession(original).click()
      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await expectStaysAbsent(terminal("Terminal 01"))
      await expect
        .element(savedSession(fresh).getByText("1 terminal", { exact: true }))
        .toBeVisible()

      await savedSession(fresh).click()
      await expect.element(commandInput("Terminal 01")).toHaveValue("new draft")
    })

    it("restores the terminal and view each session last had selected", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await terminalTab("Tests").click()
      await sidebarPanel("Sessions").click()
      const original = await currentSessionName()
      await page.getByRole("button", { name: "New session" }).click()
      await expect.element(emptyWorkspace()).toBeVisible()
      const fresh = await newSessionName(original)
      await chooseView("Canvas")

      await savedSession(original).click()

      await expect.element(view("Grid")).toBeChecked()
      await sidebarPanel("Terminals").click()
      await expectSelected("Tests")

      await sidebarPanel("Sessions").click()
      await savedSession(fresh).click()

      await expect.element(view("Canvas")).toBeChecked()
      await expect.element(emptyWorkspace()).toBeVisible()
    })
  })

  context("when switching projects after creating a session", () => {
    it("lists only that project's sessions and returns to the last active one", async () => {
      await openWorkspace()
      await sidebarPanel("Sessions").click()
      const original = await currentSessionName()
      await page.getByRole("button", { name: "New session" }).click()
      await expect.element(emptyWorkspace()).toBeVisible()
      const fresh = await newSessionName(original)

      await switchProject("api-service")

      await expect.poll(() => savedSessions().getByRole("listitem").elements()).toHaveLength(1)
      await expectStaysAbsent(savedSession(fresh))
      await expect.element(terminal("Checkout implementation")).toBeVisible()

      await switchProject("storefront")

      await expectCurrentSession(fresh)
      await expect.element(savedSession(original)).toBeVisible()
      await expect.element(emptyWorkspace()).toBeVisible()
    })
  })

  context("when choosing Browse sessions in an empty session", () => {
    it("opens the Sessions sidebar", async () => {
      await openWorkspace()
      await pressNewSession()
      await expect.element(emptyWorkspace()).toBeVisible()
      await sidebarPanel("Sessions").click()
      await expect.element(sidebar()).not.toBeInTheDocument()

      await page.getByRole("button", { name: "Browse sessions" }).click()

      await expect.element(sidebar()).toHaveAccessibleName("Workspace sessions")
      await expect.element(sidebarPanel("Sessions")).toBeChecked()
    })
  })
})

// A real viewport resize; it persists across tests in this file, so each test restores it.
const phone = (): Promise<void> => page.viewport(390, 800)

describe("narrow screens", () => {
  afterEach(async () => {
    await page.viewport(1440, 900)
  })

  context("when the workspace opens on a phone", () => {
    it("shows the terminal with the sidebar closed", async () => {
      await phone()
      await openWorkspace()

      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await expectStaysAbsent(sidebar())
      await expect.element(sidebarPanel("Terminals")).not.toBeChecked()
    })

    it("keeps the header actions on screen", async () => {
      await phone()
      await openWorkspace()

      const actions = [
        workspaceSwitcher(),
        view("Focus"),
        view("Grid"),
        view("Canvas"),
        page.getByRole("button", { name: "Enter Zen mode" }),
        page.getByRole("button", { name: "Find a terminal" }),
        page.getByRole("button", { name: "Workspace preferences" }),
      ]
      for (const action of actions) {
        // oxlint-disable-next-line no-await-in-loop -- Checks each header action in turn.
        await expect.element(action).toBeVisible()
      }
      for (const action of actions) {
        const box = action.element().getBoundingClientRect()
        expect(box.left).toBeGreaterThanOrEqual(0)
        expect(box.right).toBeLessThanOrEqual(window.innerWidth)
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    })
  })

  context("when pressing the new-terminal shortcut on a phone", () => {
    it("keeps the sidebar closed so the new terminal and its name editor are visible", async () => {
      await phone()
      await openWorkspace()
      await commandInput("Checkout implementation").click()
      const modifier = isMac() ? "Meta" : "Control"

      await press(`{${modifier}>}{Shift>}T{/Shift}{/${modifier}}`)

      await expect.element(terminal("Terminal 07")).toBeVisible()
      await expectStaysAbsent(sidebar())
      await expect
        .element(terminal("Terminal 07").getByRole("textbox", { name: "Rename Terminal 07" }))
        .toHaveFocus()
    })
  })

  context("when opening a sidebar panel on a phone", () => {
    it("shows the panel as a drawer that closes once a terminal is chosen", async () => {
      await phone()
      await openWorkspace()

      await sidebarPanel("Terminals").click()

      const drawer = page.getByRole("dialog", { name: "Terminal sessions" })
      await expect.element(drawer).toBeVisible()

      await drawer.getByRole("button", { name: "Select Runtime", exact: true }).click()

      await expect.element(drawer).not.toBeInTheDocument()
      await expect.element(terminal("Runtime")).toBeVisible()
    })

    it("lists saved sessions and creates new ones in the Sessions drawer", async () => {
      await phone()
      await openWorkspace()

      await sidebarPanel("Sessions").click()

      const drawer = page.getByRole("dialog", { name: "Workspace sessions" })
      await expect.element(drawer.getByRole("list", { name: "Saved sessions" })).toBeVisible()
      const original = await currentSessionName()

      await drawer.getByRole("button", { name: "New session" }).click()

      const fresh = await newSessionName(original)
      await expect.poll(() => savedSessions().getByRole("listitem").elements()).toHaveLength(2)
      await expect
        .element(savedSession(fresh).getByText("0 terminals", { exact: true }))
        .toBeVisible()
    })
  })
})
