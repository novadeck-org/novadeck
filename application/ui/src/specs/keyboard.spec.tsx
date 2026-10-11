import { afterEach, beforeEach, describe as context, describe, expect, it } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { clickBackground } from "./support/canvas"
import {
  expectFocusWithin,
  expectSearchReady,
  findDialog,
  newTerminalName,
  preferencesDialog,
  pressShortcut,
  recentOption,
  recentSwitcher,
  searchField,
  shortcut,
  terminalCount,
  viewRegion,
} from "./support/keyboard"
import { workspaceSwitcher } from "./support/sessions"
import { sidebarRenameField, tabAction } from "./support/terminals"
import {
  chooseView,
  commandInput,
  enterNavigateMode,
  expectNothingSelected,
  expectSelected,
  expectTypingIn,
  focusStage,
  focusViewChoice,
  focusTab,
  navigateChip,
  expectStaysAbsent,
  isMac,
  openWorkspace,
  press,
  reloadWorkspace,
  sidebar,
  sidebarPanel,
  terminal,
  terminalTab,
  view,
} from "./support/workspace"

const views = ["Focus", "Grid", "Canvas"] as const

const resizeHandle = (): Locator => page.getByRole("separator", { name: "Resize sidebar" })

const width = (locator: Locator): number => locator.element().getBoundingClientRect().width

describe("recent terminals", () => {
  context("when holding Ctrl and pressing Tab", () => {
    it("offers the previously used terminal and switches to it on release", async () => {
      await openWorkspace()
      await terminalTab("Dev server").click()
      await terminalTab("Runtime").click()

      await press("{Control>}{Tab}")
      await expect.element(recentOption("Dev server")).toHaveAttribute("aria-selected", "true")
      await expect.element(terminal("Runtime")).toBeVisible()

      await press("{/Control}")
      await expect.element(recentSwitcher()).not.toBeInTheDocument()
      await expect.element(terminal("Dev server")).toBeVisible()
      await expectSelected("Dev server")
    })

    it("moves further with each Tab and back with Shift+Tab while Ctrl is held", async () => {
      await openWorkspace()
      await terminalTab("Dev server").click()
      await terminalTab("Runtime").click()

      await press("{Control>}{Tab}{Tab}")
      await expect
        .element(recentOption("Checkout implementation"))
        .toHaveAttribute("aria-selected", "true")

      await press("{Shift>}{Tab}{/Shift}")
      await expect.element(recentOption("Dev server")).toHaveAttribute("aria-selected", "true")

      await press("{/Control}")
      await expectSelected("Dev server")
    })

    it("cycles the list with Up and Down while it is open", async () => {
      await openWorkspace()
      await terminalTab("Dev server").click()

      await press("{Control>}{Tab}")
      await expect
        .element(recentOption("Checkout implementation"))
        .toHaveAttribute("aria-selected", "true")

      await press("{ArrowDown}")
      await expect.element(recentOption("Tests")).toHaveAttribute("aria-selected", "true")
      await press("{ArrowUp}{ArrowUp}")
      await expect.element(recentOption("Dev server")).toHaveAttribute("aria-selected", "true")

      await press("{/Control}")
      await expectSelected("Dev server")
    })

    it("dismisses with Escape, keeping the selection and the sidebar", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await terminalTab("Dev server").click()

      await press("{Control>}{Tab}")
      await expect.element(recentSwitcher()).toBeVisible()
      await press("{Escape}")
      await expect.element(recentSwitcher()).not.toBeInTheDocument()
      await press("{/Control}")

      await expectSelected("Dev server")
      await expect.element(sidebar()).toBeVisible()
    })
  })

  context("when pressing Ctrl+Shift+Tab", () => {
    it("starts from the other end of the recent list", async () => {
      await openWorkspace()

      await press("{Control>}{Shift>}{Tab}{/Shift}")
      await expect.element(recentOption("Build")).toHaveAttribute("aria-selected", "true")

      await press("{/Control}")
      await expectSelected("Build")
    })
  })
})

describe("terminal switcher", () => {
  for (const name of views) {
    context(`when opened from the terminal icon in ${name}`, () => {
      it("switches with Down and Enter", async () => {
        await openWorkspace()
        await chooseView(name)

        await terminal("Checkout implementation")
          .getByRole("button", { name: "Switch terminal" })
          .click()
        await expectFocusWithin(recentSwitcher())
        await expect
          .element(recentOption("Checkout implementation"))
          .toHaveAttribute("aria-selected", "true")

        await press("{ArrowDown}")
        await expect.element(recentOption("Dev server")).toHaveAttribute("aria-selected", "true")
        await press("{Enter}")

        await expect.element(recentSwitcher()).not.toBeInTheDocument()
        await expectSelected("Dev server")
        await expect.element(view(name)).toBeChecked()
      })
    })
  }

  context("when choosing a terminal with the pointer", () => {
    it("switches to the chosen terminal", async () => {
      await openWorkspace()
      await terminal("Checkout implementation")
        .getByRole("button", { name: "Switch terminal" })
        .click()

      await recentOption("Tests").click()

      await expect.element(recentSwitcher()).not.toBeInTheDocument()
      await expect.element(terminal("Tests")).toBeVisible()
      await expectSelected("Tests")
    })
  })

  context("when pressing Escape", () => {
    it("closes without switching and returns focus to the icon", async () => {
      await openWorkspace()
      const trigger = terminal("Checkout implementation").getByRole("button", {
        name: "Switch terminal",
      })
      await trigger.click()
      await expectFocusWithin(recentSwitcher())
      await press("{ArrowDown}")
      await expect.element(recentOption("Dev server")).toHaveAttribute("aria-selected", "true")

      await press("{Escape}")

      await expect.element(recentSwitcher()).not.toBeInTheDocument()
      await expectSelected("Checkout implementation")
      await expect.element(trigger).toHaveFocus()
    })
  })
})

describe("Focus toggle", () => {
  for (const windowed of ["Grid", "Canvas"] as const) {
    context(`when pressing ${shortcut.focus().label} after using ${windowed}`, () => {
      it(`opens Focus and returns to ${windowed}`, async () => {
        await openWorkspace()
        await chooseView(windowed)
        await terminalTab("Dev server").click()

        await pressShortcut("focus")
        await expect.element(view("Focus")).toBeChecked()
        await expect.element(terminal("Dev server")).toBeVisible()

        await pressShortcut("focus")
        await expect.element(view(windowed)).toBeChecked()
        await expectSelected("Dev server")
      })
    })
  }

  context("when the app is reloaded in Focus after using Canvas", () => {
    it("still returns to Canvas", async () => {
      await openWorkspace()
      await chooseView("Canvas")
      await terminalTab("Checkout implementation").click()
      await pressShortcut("focus")
      await expect.element(view("Focus")).toBeChecked()

      await reloadWorkspace()
      await expect.element(view("Focus")).toBeChecked()
      await pressShortcut("focus")

      await expect.element(view("Canvas")).toBeChecked()
    })
  })

  context(`when pressing ${shortcut.focus().label} in a terminal input`, () => {
    it("toggles the view and keeps typing focus", async () => {
      await openWorkspace()
      await chooseView("Canvas")
      await commandInput("Checkout implementation").click()

      await pressShortcut("focus")
      await expect.element(view("Focus")).toBeChecked()
      await expect.element(commandInput("Checkout implementation")).toHaveFocus()

      await pressShortcut("focus")
      await expect.element(view("Canvas")).toBeChecked()
    })
  })
})

describe("new terminal shortcut", () => {
  context(`when pressing ${shortcut.newTerminal().label}`, () => {
    it("creates and shows a new terminal", async () => {
      await openWorkspace()
      await expect.element(terminalCount(6)).toBeVisible()

      await pressShortcut("newTerminal")

      await expect.element(terminalCount(7)).toBeVisible()
      await expect.element(terminal(newTerminalName)).toBeVisible()
      await expect.element(terminal("Checkout implementation")).not.toBeInTheDocument()
    })
  })

  context("when the sidebar is hidden", () => {
    it("opens the Terminals sidebar", async () => {
      await openWorkspace()
      await pressShortcut("terminals")
      await expect.element(sidebar()).not.toBeInTheDocument()

      await pressShortcut("newTerminal")

      await expect.element(sidebarPanel("Terminals")).toBeChecked()
      await expect.element(sidebar()).toBeVisible()
    })
  })

  context(`when pressing ${shortcut.newTerminal().label} in a terminal input`, () => {
    it("creates a terminal without typing into the input", async () => {
      await openWorkspace()
      await commandInput("Checkout implementation").click()

      await pressShortcut("newTerminal")

      await expect.element(terminal(newTerminalName)).toBeVisible()
      await expect.element(terminalCount(7)).toBeVisible()
    })
  })
})

describe("arrow navigation", () => {
  for (const name of views) {
    context(`when pressing Up and Down on a sidebar terminal tab in ${name}`, () => {
      it("selects terminals in sidebar order and wraps at either end", async () => {
        await openWorkspace()
        await chooseView(name)
        await focusTab("Checkout implementation")

        await press("{ArrowDown}")
        await expectSelected("Dev server")
        await expect.element(terminal("Dev server")).toBeVisible()
        await press("{ArrowUp}{ArrowUp}")
        await expectSelected("Build")
        await press("{ArrowDown}")
        await expectSelected("Checkout implementation")
      })
    })
  }

  context("when pressing Shift+Right while navigating", () => {
    it("cycles Focus, Grid, and Canvas and keeps the selection", async () => {
      await openWorkspace()
      await terminalTab("Tests").click()
      await enterNavigateMode()

      await press("{Shift>}{ArrowRight}{/Shift}")
      await expect.element(view("Grid")).toBeChecked()
      await press("{Shift>}{ArrowRight}{/Shift}")
      await expect.element(view("Canvas")).toBeChecked()
      await press("{Shift>}{ArrowRight}{/Shift}")
      await expect.element(view("Focus")).toBeChecked()

      await expect.element(terminal("Tests")).toBeVisible()
      await expectSelected("Tests")
    })
  })

  context("when pressing Shift+Left while navigating", () => {
    it("cycles backwards from Focus to Canvas and keeps the selection", async () => {
      await openWorkspace()
      await terminalTab("Tests").click()
      await enterNavigateMode()

      await press("{Shift>}{ArrowLeft}{/Shift}")
      await expect.element(view("Canvas")).toBeChecked()
      await press("{Shift>}{ArrowLeft}{/Shift}")
      await expect.element(view("Grid")).toBeChecked()

      await expectSelected("Tests")
    })
  })

  context("when pressing Shift+Right outside navigate mode", () => {
    it("does nothing on the stage", async () => {
      await openWorkspace()
      await terminalTab("Tests").click()
      await expect.element(commandInput("Tests")).toHaveFocus()
      await focusStage()

      await press("{Shift>}{ArrowRight}{/Shift}")

      await expectStaysAbsent(viewRegion("grid"))
      await expect.element(view("Focus")).toBeChecked()
    })
  })

  context("when pressing Left or Right on a sidebar terminal tab", () => {
    it("does nothing", async () => {
      await openWorkspace()
      await focusTab("Tests")

      await press("{ArrowRight}{ArrowLeft}")

      await expectStaysAbsent(viewRegion("grid"))
      await expect.element(view("Focus")).toBeChecked()
      await expectSelected("Tests")
    })
  })

  context("when pressing a plain arrow in Focus while navigating", () => {
    it("steps through sidebar order: Right and Down forward, Left and Up back", async () => {
      await openWorkspace()
      await expectSelected("Checkout implementation")
      await enterNavigateMode()

      await press("{ArrowRight}")
      await expectSelected("Dev server")
      await press("{ArrowDown}")
      await expectSelected("Tests")
      await press("{ArrowLeft}")
      await expectSelected("Dev server")
      await press("{ArrowUp}")
      await expectSelected("Checkout implementation")
      await press("{ArrowLeft}")
      await expectSelected("Build")
      await press("{ArrowDown}")
      await expectSelected("Checkout implementation")
      await expect.element(terminal("Checkout implementation")).toBeVisible()
    })
  })

  context("when a view is disabled in Preferences", () => {
    it("skips it", async () => {
      await openWorkspace()
      await pressShortcut("preferences")
      await preferencesDialog().getByRole("checkbox", { name: "Grid" }).click()
      await preferencesDialog().getByRole("button", { name: "Close preferences" }).click()
      await expect.element(preferencesDialog()).not.toBeInTheDocument()
      await enterNavigateMode()

      await press("{Shift>}{ArrowRight}{/Shift}")
      await expect.element(view("Canvas")).toBeChecked()
      await press("{Shift>}{ArrowRight}{/Shift}")
      await expect.element(view("Focus")).toBeChecked()
    })
  })
})

describe("navigate mode", () => {
  context(`when pressing Shift+Esc in a terminal's command input`, () => {
    it("starts navigating, and arrows then move the selection", async () => {
      await openWorkspace()
      await commandInput("Checkout implementation").click()
      await expect.element(commandInput("Checkout implementation")).toHaveFocus()
      await expect.element(navigateChip()).not.toBeInTheDocument()

      await press("{Shift>}{Escape}{/Shift}")

      await expect.element(navigateChip()).toBeVisible()
      await expect
        .element(page.getByRole("region", { name: "focus view" }))
        .toHaveAttribute("data-navigate", "true")
      await expect.element(commandInput("Checkout implementation")).not.toHaveFocus()
      await press("{ArrowDown}")
      await expectSelected("Dev server")
      await press("{ArrowDown}")
      await expectSelected("Tests")
    })
  })

  context("when a control takes keyboard focus while navigating", () => {
    it("stops navigating, so Enter presses the control", async () => {
      await openWorkspace()
      await enterNavigateMode()
      const enterZen = page.getByRole("button", { name: "Enter Zen mode" })
      enterZen.element().focus()
      await expect.element(navigateChip()).not.toBeInTheDocument()

      await press("{Enter}")

      await expect.element(page.getByRole("group", { name: "Zen controls" })).toBeVisible()
    })
  })

  for (const [key, name] of [
    ["{Enter}", "Enter"],
    ["{Escape}", "Esc"],
  ] as const) {
    context(`when pressing ${name} while navigating`, () => {
      it("goes back into the selected terminal", async () => {
        await openWorkspace()
        await enterNavigateMode()
        await press("{ArrowDown}")
        await expectSelected("Dev server")

        await press(key)

        await expectTypingIn("Dev server")
        await expectSelected("Dev server")
        await expect
          .element(page.getByRole("region", { name: "focus view" }))
          .not.toHaveAttribute("data-navigate", "true")
      })
    })
  }

  context("when typing while navigating", () => {
    it("types into the selected terminal and stops navigating", async () => {
      await openWorkspace()
      await enterNavigateMode()
      await press("{ArrowDown}")
      await expectSelected("Dev server")

      await press("ls")

      await expectTypingIn("Dev server")
      await expect.element(commandInput("Dev server")).toHaveValue("ls")
    })
  })

  context("when pressing a plain arrow on the stage outside navigate mode", () => {
    it("does nothing", async () => {
      await openWorkspace()
      await focusStage()
      await press("{ArrowUp}{ArrowLeft}")

      await expectSelected("Checkout implementation")
      await expect.element(navigateChip()).not.toBeInTheDocument()
    })
  })

  context("when clicking a terminal tab in the sidebar", () => {
    it("leaves keyboard focus in that terminal's input", async () => {
      await openWorkspace()

      await terminalTab("Dev server").click()

      await expectSelected("Dev server")
      await expect.element(commandInput("Dev server")).toHaveFocus()
    })
  })
})

describe("sidebar shortcuts", () => {
  context(`when pressing ${shortcut.sessions().label} and ${shortcut.terminals().label}`, () => {
    it("switches to the requested panel and hides it on a repeat press", async () => {
      await openWorkspace()
      await expect.element(sidebarPanel("Terminals")).toBeChecked()

      await pressShortcut("sessions")
      await expect.element(sidebarPanel("Sessions")).toBeChecked()
      await expect.element(sidebar()).toBeVisible()

      await pressShortcut("sessions")
      await expect.element(sidebar()).not.toBeInTheDocument()

      await pressShortcut("terminals")
      await expect.element(sidebarPanel("Terminals")).toBeChecked()
      await expect.element(terminalTab("Dev server")).toBeVisible()

      await pressShortcut("terminals")
      await expect.element(sidebar()).not.toBeInTheDocument()
    })

    it("works from a terminal input", async () => {
      await openWorkspace()
      await commandInput("Checkout implementation").click()

      await pressShortcut("sessions")

      await expect.element(sidebarPanel("Sessions")).toBeChecked()
      await expect.element(commandInput("Checkout implementation")).toHaveValue("")
    })
  })
})

describe("sidebar settings", () => {
  context("when the sidebar is hidden and the app is reloaded", () => {
    it("stays hidden", async () => {
      await openWorkspace()
      await pressShortcut("terminals")
      await expect.element(sidebar()).not.toBeInTheDocument()

      await reloadWorkspace()

      await expectStaysAbsent(sidebar())
      await pressShortcut("terminals")
      await expect.element(sidebar()).toBeVisible()
    })
  })

  context("when the sidebar is resized by dragging its edge", () => {
    it("follows the pointer and keeps its width after a reload", async () => {
      await openWorkspace()
      const before = width(sidebar())
      const edge = resizeHandle().element().getBoundingClientRect()
      const app = page.getByRole("main").element().getBoundingClientRect()
      const y = edge.top + edge.height / 2 - app.top
      const x = edge.left + edge.width / 2 - app.left

      await userEvent.dragAndDrop(page.getByRole("main"), page.getByRole("main"), {
        sourcePosition: { x, y },
        targetPosition: { x: x + 80, y },
      })

      await expect.poll(() => width(sidebar())).toBeGreaterThan(before + 60)
      const resized = width(sidebar())
      await expect
        .poll(() => Number(resizeHandle().element().getAttribute("aria-valuenow")))
        .toBeGreaterThan(before + 60)

      await reloadWorkspace()

      await expect.poll(() => width(sidebar())).toBeCloseTo(resized, 0)
    })
  })
})

describe("preferences shortcut", () => {
  context(`when pressing ${shortcut.preferences().label}`, () => {
    it("opens Preferences", async () => {
      await openWorkspace()

      await pressShortcut("preferences")

      await expect.element(preferencesDialog()).toBeVisible()
    })
  })
})

describe("workspace keys after choosing a view", () => {
  context(
    `when pressing ${shortcut.newTerminal().label} while the view choice has keyboard focus`,
    () => {
      it("creates a terminal", async () => {
        await openWorkspace()
        await chooseView("Grid")
        await focusViewChoice()

        await pressShortcut("newTerminal")

        await expect.element(terminalCount(7)).toBeVisible()
      })
    },
  )

  context(`when pressing ${shortcut.find().label} while the view choice has keyboard focus`, () => {
    it("opens search", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await focusViewChoice()

      await pressShortcut("find")

      await expect.element(findDialog()).toBeVisible()
    })
  })

  context(
    `when pressing ${shortcut.focus().label} while the view choice has keyboard focus`,
    () => {
      it("toggles Focus", async () => {
        await openWorkspace()
        await chooseView("Grid")
        await focusViewChoice()

        await pressShortcut("focus")

        await expect.element(view("Focus")).toBeChecked()
      })
    },
  )

  context("when pressing arrows while the view choice has keyboard focus", () => {
    it("moves one view at a time with Left and Right, and spatially with Up and Down", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await focusViewChoice()

      await press("{ArrowRight}")
      await expect.element(view("Canvas")).toBeChecked()
      await press("{ArrowLeft}")
      await expect.element(view("Grid")).toBeChecked()
      await press("{ArrowDown}")
      await expectSelected("Checkout review")
    })
  })

  context(
    `when pressing ${shortcut.terminals().label} while the view choice has keyboard focus`,
    () => {
      it("hides the sidebar", async () => {
        await openWorkspace()
        await chooseView("Grid")
        await focusViewChoice()
        await expect.element(sidebar()).toBeVisible()

        await pressShortcut("terminals")

        await expect.element(sidebar()).not.toBeInTheDocument()
      })
    },
  )
})

// ⌘ and the digit on a Mac, Ctrl+Shift and the digit elsewhere.
const pressDigit = (digit: number): Promise<void> =>
  press(isMac() ? `{Meta>}${digit}{/Meta}` : `{Control>}{Shift>}${digit}{/Shift}{/Control}`)
const pinInOrder = (): void =>
  localStorage.setItem(
    "novadeck.project-arrangement",
    JSON.stringify({
      order: ["docs-site", "api-service"],
      pinned: ["docs-site", "api-service"],
    }),
  )

const digitKeydown = (
  digit: number,
  init: KeyboardEventInit = {},
  target: Element = document.body,
): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", {
    // Shift turns a digit into its symbol, as US keys do.
    key: isMac() ? String(digit) : (")!@#$%^&*("[digit] ?? ""),
    code: `Digit${digit}`,
    ctrlKey: !isMac(),
    shiftKey: !isMac(),
    metaKey: isMac(),
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

describe("pinned project shortcuts", () => {
  context("when pressing the pin's number", () => {
    it("switches to that pinned project, in the order they are pinned", async () => {
      pinInOrder()
      await openWorkspace()
      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")

      await pressDigit(2)
      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")

      await pressDigit(1)
      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
    })

    it("works from a terminal input without typing the digit there", async () => {
      pinInOrder()
      await openWorkspace()
      const input = commandInput("Checkout implementation").element()
      await commandInput("Checkout implementation").click()

      // The key is ours, so it never reaches the terminal's own handlers.
      expect(digitKeydown(2, {}, input).defaultPrevented).toBe(true)
      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      await pressDigit(1)
      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
    })

    it("works from the open project switcher, and closes it", async () => {
      pinInOrder()
      await openWorkspace()
      await workspaceSwitcher().click()
      await expect.element(page.getByRole("dialog")).toBeVisible()

      await pressDigit(2)

      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument()
    })

    it("works from the terminal switcher, and closes it", async () => {
      pinInOrder()
      await openWorkspace()
      await terminal("Checkout implementation")
        .getByRole("button", { name: "Switch terminal" })
        .click()
      await expectFocusWithin(recentSwitcher())

      await pressDigit(2)

      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      await expect.element(recentSwitcher()).not.toBeInTheDocument()
    })

    // On macOS the pin's chord is ⌘ and a digit, so the Ctrl held for the switcher isn't
    // part of it there.
    it.skipIf(isMac())("works from the terminal switcher held open with Ctrl+Tab", async () => {
      pinInOrder()
      await openWorkspace()
      await press("{Control>}{Tab}")
      await expect.element(recentSwitcher()).toBeVisible()

      await press("{Shift>}2{/Shift}")

      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      await expect.element(recentSwitcher()).not.toBeInTheDocument()
      await press("{/Control}")
    })

    it("keeps the key from the terminal even when the pin is already the current project", async () => {
      pinInOrder()
      await openWorkspace()
      await pressDigit(1)
      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")

      expect(digitKeydown(1).defaultPrevented).toBe(true)
      expect(digitKeydown(1, { repeat: true }).defaultPrevented).toBe(true)
      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
    })

    it("does not switch again on a held key", async () => {
      pinInOrder()
      await openWorkspace()

      expect(digitKeydown(2).defaultPrevented).toBe(true)
      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      expect(digitKeydown(1, { repeat: true }).defaultPrevented).toBe(true)
      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
    })

    it("leaves the key to a tab's rename field", async () => {
      pinInOrder()
      await openWorkspace()
      await tabAction("Rename Dev server").click()
      await expect.element(sidebarRenameField("Dev server")).toHaveFocus()

      const event = digitKeydown(2, {}, sidebarRenameField("Dev server").element())

      expect(event.defaultPrevented).toBe(false)
      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")
    })

    it("leaves the project as it is behind a confirmation", async () => {
      pinInOrder()
      await openWorkspace()
      await workspaceSwitcher().click()
      await page.getByRole("button", { name: "Remove storefront" }).click({ force: true })
      const confirm = page.getByRole("alertdialog", { name: "Remove “storefront”?" })
      await expect.element(confirm).toBeVisible()

      await pressDigit(2)

      await expect.element(confirm).toBeVisible()
      // The workspace behind the confirmation is hidden from the accessibility tree.
      await expect
        .element(page.getByRole("button", { name: "Switch workspace", includeHidden: true }))
        .toHaveTextContent("storefront")
    })
  })

  context("when there is no such pin", () => {
    it("changes nothing and leaves the key, held or not, to the terminal", async () => {
      pinInOrder()
      await openWorkspace()
      await commandInput("Checkout implementation").click()
      const input = commandInput("Checkout implementation").element()

      expect(digitKeydown(3, {}, input).defaultPrevented).toBe(false)
      expect(digitKeydown(9, {}, input).defaultPrevented).toBe(false)
      expect(digitKeydown(3, { repeat: true }, input).defaultPrevented).toBe(false)

      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")
      await expect.element(commandInput("Checkout implementation")).toHaveFocus()
    })

    it("leaves every press and repeat alone when nothing is pinned", async () => {
      await openWorkspace()

      expect(digitKeydown(1).defaultPrevented).toBe(false)
      expect(digitKeydown(8, { repeat: true }).defaultPrevented).toBe(false)
      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")
    })
  })
})

describe("typing in a terminal", () => {
  context("when typing workspace keys into a command input", () => {
    it("types them instead of running workspace shortcuts", async () => {
      await openWorkspace()
      await commandInput("Checkout implementation").click()

      await press("tfb/")

      await expect.element(commandInput("Checkout implementation")).toHaveValue("tfb/")
      await expectStaysAbsent(terminal(newTerminalName))
      await expectStaysAbsent(findDialog())
      await expectStaysAbsent(viewRegion("grid"))
      await expect.element(view("Focus")).toBeChecked()
      await expect.element(sidebar()).toBeVisible()
      await expect.element(terminalCount(6)).toBeVisible()
    })
  })

  context("when typing single letters with focus outside a terminal", () => {
    it("does not run workspace actions", async () => {
      await openWorkspace()
      await terminalTab("Dev server").click()
      await expectSelected("Dev server")

      await press("tfzb/")

      await expect.element(terminalCount(6)).toBeVisible()
      await expectStaysAbsent(findDialog())
      await expectStaysAbsent(page.getByRole("group", { name: "Zen controls" }))
      await expect.element(page.getByRole("button", { name: "Enter Zen mode" })).toBeVisible()
      await expect.element(view("Focus")).toBeChecked()
      await expect.element(sidebar()).toBeVisible()
      await expectSelected("Dev server")
      await expect.element(commandInput("Dev server")).toHaveFocus()
      await expect.element(commandInput("Dev server")).toHaveValue("tfzb/")
    })
  })

  context("when typing with no terminal selected", () => {
    it("does nothing and keeps focus out of inputs", async () => {
      await openWorkspace()
      await chooseView("Canvas")
      await clickBackground({ x: 12, y: 12 })
      await expectNothingSelected()

      await press("abc")

      await expect.poll(() => document.activeElement instanceof HTMLInputElement).toBe(false)
      await expect.element(terminalCount(6)).toBeVisible()
      await expectNothingSelected()
    })
  })

  context("when typing while the Find dialog is open", () => {
    it("types into the search, not the terminal", async () => {
      await openWorkspace()
      await terminalTab("Dev server").click()
      await pressShortcut("find")
      await expectSearchReady()

      await press("xyz")

      await expect.element(searchField()).toHaveValue("xyz")
      await press("{Escape}")
      await expect.element(findDialog()).not.toBeInTheDocument()
      await expect.element(commandInput("Dev server")).toHaveValue("")
    })
  })

  context("when pressing Space with focus on a terminal tab", () => {
    it("does not move focus into the terminal", async () => {
      await openWorkspace()
      await terminalTab("Dev server").click()
      await terminalTab("Dev server").element().focus()
      await expect.element(terminalTab("Dev server")).toHaveFocus()

      await press(" ")

      await expect.element(commandInput("Dev server")).not.toHaveFocus()
      await expect.element(commandInput("Dev server")).toHaveValue("")
    })
  })

  context("when pressing arrows in a command input", () => {
    it("keeps the selection and the view", async () => {
      await openWorkspace()
      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await commandInput("Checkout implementation").click()

      await press("{ArrowDown}{ArrowRight}{Shift>}{ArrowRight}{/Shift}")

      await expectStaysAbsent(terminal("Dev server"))
      await expectStaysAbsent(viewRegion("grid"))
      await expectSelected("Checkout implementation")
      await expect.element(view("Focus")).toBeChecked()
      await expect.element(commandInput("Checkout implementation")).toHaveFocus()
    })
  })

  context("when pressing a modifier shortcut in a command input", () => {
    it("still runs it", async () => {
      await openWorkspace()
      await commandInput("Checkout implementation").click()

      await pressShortcut("find")

      await expect.element(findDialog()).toBeVisible()
    })
  })

  context("when a dialog is open", () => {
    it("leaves workspace keys to the dialog", async () => {
      await openWorkspace()
      await expect.element(terminalCount(6)).toBeVisible()
      await pressShortcut("preferences")
      await expectFocusWithin(preferencesDialog())

      await press("tf{ArrowRight}{Shift>}{ArrowRight}{/Shift}")
      await expect.element(preferencesDialog()).toBeVisible()
      await press("{Escape}")
      await expect.element(preferencesDialog()).not.toBeInTheDocument()

      await expectStaysAbsent(terminal(newTerminalName))
      await expectStaysAbsent(viewRegion("grid"))
      await expect.element(terminalCount(6)).toBeVisible()
      await expect.element(view("Focus")).toBeChecked()
    })
  })
})

// A microphone made of an oscillator, so the specs record without hardware or a permission
// prompt, with a count of the tracks still live: a released microphone has none.
const fakeMicrophone = (): { readonly live: () => number; readonly restore: () => void } => {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  const tracks: MediaStreamTrack[] = []
  navigator.mediaDevices.getUserMedia = async () => {
    const audio = new AudioContext()
    const oscillator = audio.createOscillator()
    const destination = audio.createMediaStreamDestination()
    oscillator.connect(destination)
    oscillator.start()
    tracks.push(...destination.stream.getTracks())
    return destination.stream
  }
  return {
    live: () => tracks.filter((track) => track.readyState === "live").length,
    restore: () => void (navigator.mediaDevices.getUserMedia = original),
  }
}

// The demo's voice input starts uninstalled: install it as a person would, in Preferences.
const installVoice = async (): Promise<void> => {
  await pressShortcut("preferences")
  await expectFocusWithin(preferencesDialog())
  await preferencesDialog().getByRole("tab", { name: "Addons" }).click()
  const addons = preferencesDialog().getByRole("tabpanel", { name: "Addons" })
  await addons.getByRole("button", { name: "Install" }).click()
  // Only an installed card offers Uninstall; the switch shows before the install too.
  await expect
    .element(addons.getByRole("button", { name: "Uninstall" }), { timeout: 10_000 })
    .toBeVisible()
  await expect
    .element(addons.getByRole("switch", { name: "Enabled" }))
    .toHaveAttribute("aria-checked", "true")
  await press("{Escape}")
  await expect.element(preferencesDialog()).not.toBeInTheDocument()
}

// Hold to dictate: Ctrl+Shift+M, on every platform.
const dictateKeys = "{Control>}{Shift>}{M>}"
const releaseKeys = "{/M}{/Shift}{/Control}"
/** The dictation status line, once it says `text`. */
const saying = (text: string | RegExp): Locator =>
  page.getByRole("status").filter({ hasText: text })
/** Where an element stacks among its siblings' layer. */
const layer = (element: Element): number => Number(getComputedStyle(element).zIndex)
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

describe("dictation", () => {
  let microphone: ReturnType<typeof fakeMicrophone>
  beforeEach(() => void (microphone = fakeMicrophone()))
  afterEach(() => microphone.restore())

  context("when voice input is not installed", () => {
    it("points to Preferences instead of recording", async () => {
      await openWorkspace()
      await commandInput("Checkout implementation").click()

      await press(`${dictateKeys}${releaseKeys}`)

      await expect.element(saying("Preferences → Addons")).toBeVisible()
      expect(microphone.live()).toBe(0)
      // The terminal's strip opens Addons, where voice input is set up.
      await saying("Preferences → Addons").getByRole("button", { name: "Open Addons" }).click()
      await expect
        .element(preferencesDialog().getByRole("tab", { name: "Addons" }))
        .toHaveAttribute("aria-selected", "true")
    })
  })

  context("before voice input is installed", () => {
    it("offers an agent's microphone, which opens Addons, until turned off there", async () => {
      // The agents demo, whose Checkout implementation runs Claude Code.
      await openWorkspace("/?demo=agents")
      const skip = page.getByRole("button", { name: "Skip for now" })
      if (await skip.query()) await skip.click()
      await terminalTab("Checkout implementation").click()
      // Until voice input is installed, it says what it does: lead to the setup.
      const mic = terminal("Checkout implementation").getByRole("button", {
        name: "Set up voice input for Checkout implementation",
      })
      await mic.click()
      const dialog = preferencesDialog()
      await expect
        .element(dialog.getByRole("tab", { name: "Addons" }))
        .toHaveAttribute("aria-selected", "true")
      expect(microphone.live()).toBe(0)

      const enabled = dialog.getByRole("switch", { name: "Enabled" })
      await expect.element(enabled).toHaveAttribute("aria-checked", "true")
      await enabled.click()
      await expect.element(enabled).toHaveAttribute("aria-checked", "false")
      await press("{Escape}")
      await expect.element(mic).not.toBeInTheDocument()
    })
  })

  context("when voice input is installed", () => {
    it("records while the shortcut is held and pastes the transcript into the terminal without sending it", async () => {
      await openWorkspace()
      await installVoice()
      await commandInput("Checkout implementation").click()

      await press(dictateKeys)
      await expect.element(saying("Release to send")).toBeVisible()
      // Two seconds from the press: past the shortest clip kept, even when the microphone
      // takes a while to start, as on a slow CI machine.
      await expect.element(saying("0:02")).toBeVisible()
      expect(microphone.live()).toBe(1)

      // Modifiers may come up before the letter; the letter ends the hold.
      await press("{/Control}{/Shift}")
      await expect.element(saying("Listening")).toBeVisible()
      await press("{/M}")

      // "Transcribing" shows only as long as the demo takes, too briefly to wait for.
      await expect
        .element(commandInput("Checkout implementation"))
        .toHaveValue("Add a retry to the checkout request and run the tests.")
      expect(microphone.live()).toBe(0)
    })

    it("keeps recording after a quick tap until the next press", async () => {
      await openWorkspace()
      await installVoice()
      await commandInput("Checkout implementation").click()

      await press(`${dictateKeys}${releaseKeys}`)
      await expect.element(saying("Esc discard")).toBeVisible()
      await expect.element(saying("0:02")).toBeVisible()
      expect(microphone.live()).toBe(1)

      await press(`${dictateKeys}${releaseKeys}`)
      // "Transcribing" shows only as long as the demo takes, too briefly to wait for.
      await expect
        .element(commandInput("Checkout implementation"))
        .toHaveValue("Add a retry to the checkout request and run the tests.")
    })

    it("shows its strip over a terminal's chat, not under it", async () => {
      localStorage.setItem("novadeck.preferences", JSON.stringify({ chatView: true }))
      await openWorkspace("/?demo=agents")
      const skip = page.getByRole("button", { name: "Skip for now" })
      if (await skip.query()) await skip.click()
      await installVoice()
      await terminalTab("Checkout implementation").click()
      const chat = terminal("Checkout implementation").getByRole("region", {
        name: "Checkout implementation chat",
      })
      await expect.element(chat).toBeVisible()

      await press(dictateKeys)
      const strip = saying("Release to send")
      await expect.element(strip).toBeVisible()
      // Stacked above the chat pane, which shares its layer over the terminal's content.
      const pane = terminal("Checkout implementation")
        .element()
        .querySelector("[data-workspace-chat]")!
      expect(layer(strip.element())).toBeGreaterThan(layer(pane))
      await press(releaseKeys)
    })

    it("drops the recording on Escape and releases the microphone", async () => {
      await openWorkspace()
      await installVoice()
      await commandInput("Checkout implementation").click()

      await press(dictateKeys)
      await wait(500)
      expect(microphone.live()).toBe(1)
      await press("{Escape}")
      await press(releaseKeys)

      await expect.poll(() => saying(/Listening|Transcribing/).elements().length).toBe(0)
      expect(microphone.live()).toBe(0)
      await expect.element(commandInput("Checkout implementation")).toHaveValue("")
    })
  })
})
