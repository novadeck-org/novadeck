import { afterEach, vi } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { escapeFrom, pressShortcut, newTerminalName } from "../support/keyboard"
import {
  currentSessionName,
  emptyWorkspace,
  expectCurrentSession,
  listedProjects,
  newSessionName,
  pressNewSession,
  run,
  savedSession,
  savedSessions,
  switchProject,
  workspaceSwitcher,
} from "../support/sessions"
import {
  chooseView,
  clickInto,
  commandInput,
  draftOf,
  expectSelected,
  expectStaysAbsent,
  isMac,
  labelled,
  openWorkspace,
  press,
  sidebar,
  sidebarPanel,
  terminal,
  terminalLine,
  terminalsShow,
  terminalsText,
  terminalTab,
  terminalText,
  typeInto,
  view,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

const switchMenu = (): Locator => page.getByRole("dialog", { name: "Switch workspace" })

describe("projects", () => {
  context("when opening the Switch workspace menu", () => {
    it("lists every project and marks the current one", async () => {
      await openWorkspace()

      await workspaceSwitcher().click()

      const menu = switchMenu()
      await expect
        .element(menu.getByRole("button", { name: /^storefront / }))
        .toHaveAttribute("aria-current", "true")
      await expect
        .element(menu.getByRole("button", { name: /^api-service / }))
        .not.toHaveAttribute("aria-current")
    })

    it("opens under its button and gives the focus back to it on Escape", async () => {
      await openWorkspace()
      const trigger = workspaceSwitcher()

      await trigger.click()

      const menu = switchMenu()
      await expect.element(menu).toBeVisible()
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true")
      const button = trigger.element().getBoundingClientRect()
      await expect
        .poll(() => menu.element().getBoundingClientRect().top)
        .toBeGreaterThanOrEqual(button.bottom)
      expect(Math.abs(menu.element().getBoundingClientRect().left - button.left)).toBeLessThan(2)

      await escapeFrom(menu)

      await expect.element(menu).not.toBeInTheDocument()
      await expect.element(trigger).toHaveFocus()
    })
  })

  context("when pinning projects", () => {
    // The demo's projects after its first two, as the switcher lists them.
    const others = ["docs-site", "mobile-app", "design-system", "infra", "dotfiles"]
    const row = (name: string): Locator =>
      switchMenu().getByRole("button", { name: new RegExp(`^${name} `) })

    it("moves a pinned project to a Pinned group at the top, and back on unpin", async () => {
      await openWorkspace()
      await workspaceSwitcher().click()
      await expect
        .element(switchMenu().getByText("Pinned", { exact: true }))
        .not.toBeInTheDocument()
      expect(listedProjects()).toEqual(["storefront", "api-service", ...others])

      await switchMenu().getByRole("button", { name: "Pin api-service" }).click()

      await expect.element(switchMenu().getByText("Pinned", { exact: true })).toBeVisible()
      expect(listedProjects()).toEqual(["api-service", "storefront", ...others])

      await switchMenu().getByRole("button", { name: "Unpin api-service" }).click()

      await expect
        .element(switchMenu().getByText("Pinned", { exact: true }))
        .not.toBeInTheDocument()
    })

    it("moves the focused project with Alt and the arrows, keeping the focus on it", async () => {
      await openWorkspace()
      await workspaceSwitcher().click()
      const storefront = switchMenu().getByRole("button", { name: /^storefront / })
      storefront.element().focus()

      await press("{Alt>}{ArrowDown}{/Alt}")

      await expect.poll(listedProjects).toEqual(["api-service", "storefront", ...others])
      await expect.element(switchMenu().getByRole("button", { name: /^storefront / })).toHaveFocus()

      await press("{Alt>}{ArrowUp}{/Alt}")

      await expect.poll(listedProjects).toEqual(["storefront", "api-service", ...others])
      await expect.element(switchMenu().getByRole("button", { name: /^storefront / })).toHaveFocus()
    })

    it("keeps the moved project's focus when the popover's initial autofocus arrives later", async () => {
      await openWorkspace()
      const scheduled: FrameRequestCallback[] = []
      const frame = window.requestAnimationFrame.bind(window)
      // Exercise the installed Ark popover's deferred focus action after the person has
      // already interacted, without delaying unrelated layout or pointer frames.
      const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        if (new Error().stack?.includes("setInitialFocus")) {
          scheduled.push(callback)
          return frame(() => {})
        }
        return frame(callback)
      })
      try {
        await workspaceSwitcher().click()
        const storefront = switchMenu().getByRole("button", { name: /^storefront / })
        storefront.element().focus()
        await press("{Alt>}{ArrowDown}{/Alt}")
        await expect.poll(listedProjects).toEqual(["api-service", "storefront", ...others])
        await expect.element(storefront).toHaveFocus()
        expect(scheduled.length).toBeGreaterThan(0)
        for (const callback of scheduled) callback(performance.now())
        await expect.element(storefront).toHaveFocus()
      } finally {
        frames.mockRestore()
      }
    })

    it("pins the top project with Alt and Up when nothing is pinned", async () => {
      await openWorkspace()
      await workspaceSwitcher().click()
      switchMenu()
        .getByRole("button", { name: /^storefront / })
        .element()
        .focus()

      await press("{Alt>}{ArrowUp}{/Alt}")

      await expect
        .element(switchMenu().getByRole("button", { name: "Unpin storefront" }))
        .toBeVisible()
    })

    it("pins and unpins in place when Alt and an arrow cross the rule", async () => {
      await openWorkspace()
      await workspaceSwitcher().click()
      await switchMenu().getByRole("button", { name: "Pin api-service" }).click()
      row("storefront").element().focus()

      await press("{Alt>}{ArrowUp}{/Alt}")

      await expect
        .element(switchMenu().getByRole("button", { name: "Unpin storefront" }))
        .toBeVisible()
      await expect.poll(listedProjects).toEqual(["api-service", "storefront", ...others])
      await expect.element(row("storefront")).toHaveFocus()

      await press("{Alt>}{ArrowDown}{/Alt}")

      await expect
        .element(switchMenu().getByRole("button", { name: "Pin storefront" }))
        .toBeVisible()
      await expect.poll(listedProjects).toEqual(["api-service", "storefront", ...others])
      await expect.element(row("storefront")).toHaveFocus()
    })

    it("pins a project dragged above the rule and keeps the menu open", async () => {
      await openWorkspace()
      await workspaceSwitcher().click()
      await switchMenu().getByRole("button", { name: "Pin api-service" }).click()
      const { height } = row("api-service").element().getBoundingClientRect()

      await userEvent.dragAndDrop(row("storefront"), row("api-service"), {
        targetPosition: { x: 40, y: height / 4 },
        steps: 20,
      })

      await expect.poll(listedProjects).toEqual(["storefront", "api-service", ...others])
      await expect
        .element(switchMenu().getByRole("button", { name: "Unpin storefront" }))
        .toBeInTheDocument()
      await expect.element(switchMenu()).toBeVisible()
    })

    it("keeps the focus in the menu, on the dragged project, after a drag", async () => {
      await openWorkspace()
      await workspaceSwitcher().click()
      await switchMenu().getByRole("button", { name: "Pin api-service" }).click()
      const { height } = row("api-service").element().getBoundingClientRect()

      await userEvent.dragAndDrop(row("storefront"), row("api-service"), {
        targetPosition: { x: 40, y: height / 4 },
        steps: 20,
      })

      await expect.element(row("storefront")).toHaveFocus()
    })
  })

  context("when switching to another project", () => {
    it("shows that project's terminals", async () => {
      await openWorkspace()
      await expect
        .poll(() => terminalText("Checkout implementation"))
        .toContain("~/projects/storefront")

      await switchProject("api-service")

      await expect
        .poll(() => terminalText("Checkout implementation"))
        .toContain("~/projects/api-service")
      await expect.poll(terminalsText).not.toContain("~/projects/storefront")
    })

    it("keeps each project's terminals, output, and selection separate", async () => {
      await openWorkspace()
      await terminalTab("Checkout review").click()
      await run("Checkout review", "echo storefront history")
      await sidebar()
        .getByRole("button", { name: labelled("Close ", "Build") })
        .click()
      await expect.element(terminalTab("Build")).not.toBeInTheDocument()

      await switchProject("api-service")

      await expect.element(terminalTab("Build")).toBeVisible()
      await expectSelected("Checkout implementation")
      await expectStaysAbsent(terminalLine("storefront history"))

      await switchProject("storefront")

      await expect.element(terminalTab("Build")).not.toBeInTheDocument()
      await expectSelected("Checkout review")
      await expect.poll(() => terminalsShow("storefront history")).toBe(true)
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
      await expect.element(sidebar()).toHaveAccessibleName("Terminal sessions")
      await expect.element(sidebarPanel("Terminals")).toBeChecked()
      await expect.element(sidebar().getByRole("button", { name: "New terminal" })).toHaveFocus()
      await sidebarPanel("Sessions").click()
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
    it("creates an empty session and opens the Terminals sidebar", async () => {
      await openWorkspace()
      await sidebarPanel("Terminals").click()
      await expect.element(sidebar()).not.toBeInTheDocument()
      await clickInto("Checkout implementation")

      await pressNewSession()

      await expect.element(emptyWorkspace()).toBeVisible()
      await expect.element(sidebarPanel("Terminals")).toBeChecked()
      await expect.element(sidebar()).toHaveAccessibleName("Terminal sessions")
      await expect.element(sidebar().getByRole("button", { name: "New terminal" })).toHaveFocus()
      await sidebarPanel("Sessions").click()
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
      await terminalTab("Checkout review").click()
      await run("Checkout review", "echo saved output")
      await typeInto("Checkout review", "echo unfinished")
      await sidebarPanel("Sessions").click()
      const original = await currentSessionName()
      await page.getByRole("button", { name: "New session" }).click()
      await expect.element(emptyWorkspace()).toBeVisible()
      await sidebarPanel("Sessions").click()

      await savedSession(original).click()

      await expect.element(terminal("Checkout review")).toBeVisible()
      await expect.poll(() => draftOf("Checkout review")).toBe("echo unfinished")
      await expect.poll(() => terminalsShow("saved output")).toBe(true)
      await expectCurrentSession(original)
    })

    it("keeps a new session's terminals apart from the original session", async () => {
      await openWorkspace()
      await sidebarPanel("Sessions").click()
      const original = await currentSessionName()
      await page.getByRole("button", { name: "New session" }).click()
      await expect.element(emptyWorkspace()).toBeVisible()
      await sidebar().getByRole("button", { name: "New terminal" }).click()
      await expect.element(commandInput(newTerminalName)).toHaveFocus()
      await typeInto(newTerminalName, "new draft")

      await sidebarPanel("Sessions").click()
      const fresh = await newSessionName(original)
      await savedSession(original).click()
      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await expectStaysAbsent(terminal(newTerminalName))
      await expect
        .element(savedSession(fresh).getByText("1 terminal", { exact: true }))
        .toBeVisible()

      await savedSession(fresh).click()
      await expect.poll(() => draftOf(newTerminalName)).toBe("new draft")
    })

    it("restores the terminal and view each session last had selected", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await terminalTab("Tests").click()
      await sidebarPanel("Sessions").click()
      const original = await currentSessionName()
      await page.getByRole("button", { name: "New session" }).click()
      await expect.element(emptyWorkspace()).toBeVisible()
      await sidebarPanel("Sessions").click()
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
      await sidebarPanel("Sessions").click()
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
      await sidebarPanel("Terminals").click()
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
    it("keeps the sidebar closed so the new terminal is visible and focused", async () => {
      await phone()
      await openWorkspace()
      await clickInto("Checkout implementation")

      await pressShortcut("newTerminal")

      await expect.element(terminal(newTerminalName)).toBeVisible()
      await expectStaysAbsent(sidebar())
      await expect.element(commandInput(newTerminalName)).toHaveFocus()
    })
  })

  context("when a toggle on the drawer's rail is moved with Alt and the arrows", () => {
    it("keeps the focus on the toggle, not the drawer's close button", async () => {
      await phone()
      await openWorkspace()
      await sidebarPanel("Terminals").click()
      const drawer = page.getByRole("dialog", { name: "Terminal sessions" })
      await expect.element(drawer).toBeVisible()
      const toggles = drawer.getByRole("radio")
      const place = () =>
        toggles.elements().findIndex((toggle) => toggle.id === "mobile-terminals-toggle")
      expect(place()).toBe(0)

      toggles.first().element().focus()
      await press("{Alt>}{ArrowDown}{/Alt}")

      await expect.poll(place).toBe(1)
      // The drawer's focus trap answers the button's move a moment later.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(document.activeElement?.id).toBe("mobile-terminals-toggle")
    })
  })

  context("when opening a sidebar panel on a phone", () => {
    it("shows the panel as a drawer that closes once a terminal is chosen", async () => {
      await phone()
      await openWorkspace()

      await sidebarPanel("Terminals").click()

      const drawer = page.getByRole("dialog", { name: "Terminal sessions" })
      await expect.element(drawer).toBeVisible()

      await drawer.getByRole("button", { name: labelled("Select ", "Runtime") }).click()

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

      const terminals = page.getByRole("dialog", { name: "Terminal sessions" })
      await expect.element(terminals).toBeVisible()
      await expect.element(terminals.getByRole("button", { name: "New terminal" })).toHaveFocus()
      await escapeFrom(terminals)
      await expect.element(terminals).not.toBeInTheDocument()
      await pressShortcut("sessions")
      await expect.element(drawer).toBeVisible()
      const fresh = await newSessionName(original)
      await expect.poll(() => savedSessions().getByRole("listitem").elements()).toHaveLength(2)
      await expect
        .element(savedSession(fresh).getByText("0 terminals", { exact: true }))
        .toBeVisible()
    })
  })
})
