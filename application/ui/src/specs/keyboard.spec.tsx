import { describe as context, describe, expect, it } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import {
  expectFocusWithin,
  findDialog,
  newTerminalName,
  preferencesDialog,
  pressShortcut,
  recentOption,
  recentSwitcher,
  shortcut,
  terminalCount,
  viewRegion,
} from "./support/keyboard"
import {
  chooseView,
  commandInput,
  expectSelected,
  expectStaysAbsent,
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
    context(`when pressing F after using ${windowed}`, () => {
      it(`opens Focus and returns to ${windowed}`, async () => {
        await openWorkspace()
        await chooseView(windowed)
        await terminalTab("Dev server").click()

        await press("f")
        await expect.element(view("Focus")).toBeChecked()
        await expect.element(terminal("Dev server")).toBeVisible()

        await press("f")
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
      await press("f")
      await expect.element(view("Focus")).toBeChecked()

      await reloadWorkspace()
      await expect.element(view("Focus")).toBeChecked()
      await press("f")

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
  for (const { label, keys } of [{ label: "T", keys: "t" }, shortcut.newTerminal()]) {
    context(`when pressing ${label}`, () => {
      it("creates and shows a new terminal", async () => {
        await openWorkspace()
        await expect.element(terminalCount(6)).toBeVisible()

        await press(keys)

        await expect.element(terminalCount(7)).toBeVisible()
        await expect.element(terminal(newTerminalName)).toBeVisible()
        await expect.element(terminal("Checkout implementation")).not.toBeInTheDocument()
      })
    })
  }

  context("when the sidebar is hidden", () => {
    it("opens the Terminals sidebar", async () => {
      await openWorkspace()
      await press("b")
      await expect.element(sidebar()).not.toBeInTheDocument()

      await press("t")

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
    context(`when pressing Up and Down in ${name}`, () => {
      it("selects terminals in sidebar order and wraps at either end", async () => {
        await openWorkspace()
        await chooseView(name)
        await terminalTab("Checkout implementation").click()

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

  context("when pressing Right", () => {
    it("cycles Focus, Grid, and Canvas and keeps the selection", async () => {
      await openWorkspace()
      await terminalTab("Tests").click()

      await press("{ArrowRight}")
      await expect.element(view("Grid")).toBeChecked()
      await press("{ArrowRight}")
      await expect.element(view("Canvas")).toBeChecked()
      await press("{ArrowRight}")
      await expect.element(view("Focus")).toBeChecked()

      await expect.element(terminal("Tests")).toBeVisible()
      await expectSelected("Tests")
    })
  })

  context("when pressing Left", () => {
    it("cycles backwards from Focus to Canvas and keeps the selection", async () => {
      await openWorkspace()
      await terminalTab("Tests").click()

      await press("{ArrowLeft}")
      await expect.element(view("Canvas")).toBeChecked()
      await press("{ArrowLeft}")
      await expect.element(view("Grid")).toBeChecked()

      await expectSelected("Tests")
    })
  })

  context("when a view is disabled in Preferences", () => {
    it("skips it", async () => {
      await openWorkspace()
      await pressShortcut("preferences")
      await preferencesDialog().getByRole("checkbox", { name: "Grid" }).click()
      await preferencesDialog().getByRole("button", { name: "Close preferences" }).click()
      await expect.element(preferencesDialog()).not.toBeInTheDocument()

      await press("{ArrowRight}")
      await expect.element(view("Canvas")).toBeChecked()
      await press("{ArrowRight}")
      await expect.element(view("Focus")).toBeChecked()
    })
  })
})

describe("sidebar shortcuts", () => {
  context("when pressing B", () => {
    it("hides and shows the Terminals sidebar", async () => {
      await openWorkspace()
      await expect.element(sidebar()).toBeVisible()

      await press("b")
      await expect.element(sidebar()).not.toBeInTheDocument()

      await press("b")
      await expect.element(sidebar()).toBeVisible()
      await expect.element(sidebarPanel("Terminals")).toBeChecked()
    })
  })

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
      await press("b")
      await expect.element(sidebar()).not.toBeInTheDocument()

      await reloadWorkspace()

      await expectStaysAbsent(sidebar())
      await press("b")
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
  context("when pressing T while the view choice has keyboard focus", () => {
    it("creates a terminal", async () => {
      await openWorkspace()
      await chooseView("Grid")

      await press("t")

      await expect.element(terminalCount(7)).toBeVisible()
    })
  })

  context("when pressing / while the view choice has keyboard focus", () => {
    it("opens search", async () => {
      await openWorkspace()
      await chooseView("Grid")

      await press("/")

      await expect.element(findDialog()).toBeVisible()
    })
  })

  context("when pressing F while the view choice has keyboard focus", () => {
    it("toggles Focus", async () => {
      await openWorkspace()
      await chooseView("Grid")

      await press("f")

      await expect.element(view("Focus")).toBeChecked()
    })
  })

  context("when pressing arrows while the view choice has keyboard focus", () => {
    it("moves one view or terminal at a time", async () => {
      await openWorkspace()
      await chooseView("Grid")

      await press("{ArrowRight}")
      await expect.element(view("Canvas")).toBeChecked()
      await press("{ArrowLeft}")
      await expect.element(view("Grid")).toBeChecked()
      await press("{ArrowDown}")
      await expectSelected("Dev server")
    })
  })

  context("when pressing B while the view choice has keyboard focus", () => {
    it("hides the sidebar", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await expect.element(sidebar()).toBeVisible()

      await press("b")

      await expect.element(sidebar()).not.toBeInTheDocument()
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

  context("when pressing arrows in a command input", () => {
    it("keeps the selection and the view", async () => {
      await openWorkspace()
      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await commandInput("Checkout implementation").click()

      await press("{ArrowDown}{ArrowRight}")

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

      await press("tf{ArrowRight}")
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
