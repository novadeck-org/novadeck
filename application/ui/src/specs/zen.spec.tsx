import { describe as context, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import { emptyWorkspace, pressNewSession } from "./support/sessions"
import {
  chooseView,
  commandInput,
  expectNothingSelected,
  expectSelected,
  expectStaysAbsent,
  isMac,
  openWorkspace,
  press,
  reloadWorkspace,
  sidebar,
  sidebarPanel,
  terminal,
  terminalTab,
  viewSwitcher,
  visibleTerminalCounts,
} from "./support/workspace"

const enterZen = () => page.getByRole("button", { name: "Enter Zen mode" })
const dock = () => page.getByRole("group", { name: "Zen controls" })
const showControls = () => dock().getByRole("button", { name: "Show Zen controls" })
const hideControls = () => dock().getByRole("button", { name: "Hide Zen controls" })
const dockView = (name: "Focus" | "Grid" | "Canvas") =>
  dock().getByRole("button", { name: `${name} view` })
const exitZen = () => dock().getByRole("button", { name: "Exit Zen" })
const sidebarActions = () => page.getByRole("radiogroup", { name: "Sidebar actions" })
const expectInZen = async (): Promise<void> => {
  await expect.element(dock()).toBeVisible()
  await expect.element(enterZen()).not.toBeInTheDocument()
  await expect.element(viewSwitcher()).not.toBeInTheDocument()
  await expect.element(sidebar()).not.toBeInTheDocument()
  await expect.element(sidebarActions()).not.toBeInTheDocument()
  await expect.poll(visibleTerminalCounts).toHaveLength(0)
}

const expectOutOfZen = async (): Promise<void> => {
  await expect.element(dock()).not.toBeInTheDocument()
  await expect.element(enterZen()).toBeVisible()
  await expect.element(viewSwitcher()).toBeVisible()
  await expect.element(sidebarActions()).toBeVisible()
  await expect.poll(visibleTerminalCounts).not.toHaveLength(0)
}

const buildWidth = (): number => terminal("Build").element().getBoundingClientRect().width
const focusedBox = (): DOMRect =>
  terminal("Checkout implementation").element().getBoundingClientRect()
const canvasArea = () => page.getByLabelText("Terminal canvas")
const viewArea = (name: "Focus" | "Grid" | "Canvas") =>
  page.getByRole("region", { name: `${name.toLowerCase()} view` })
const sampleTerminals = [
  "Checkout implementation",
  "Dev server",
  "Tests",
  "Checkout review",
  "Runtime",
  "Build",
]

/** Polls a measurement until it holds still for a rendered frame, then returns it. */
const settled = async (measure: () => number): Promise<number> => {
  let previous = Number.NaN
  await expect
    .poll(async () => {
      await new Promise(requestAnimationFrame)
      const next = measure()
      const still = next === previous
      previous = next
      return still
    })
    .toBe(true)
  return previous
}

/**
 * Clicks the Canvas background near its top-left corner, after checking that no
 * terminal covers that spot, and confirms the click landed there: it clears the selection.
 */
const clickCanvasBackground = async (): Promise<void> => {
  const area = canvasArea().element().getBoundingClientRect()
  const spot = { x: 12, y: 12 }
  const covered = sampleTerminals.some((name) => {
    const box = terminal(name).query()?.getBoundingClientRect()
    return (
      box !== undefined &&
      area.left + spot.x >= box.left &&
      area.left + spot.x <= box.right &&
      area.top + spot.y >= box.top &&
      area.top + spot.y <= box.bottom
    )
  })
  expect(covered, "a terminal covers the background spot").toBe(false)
  await canvasArea().click({ position: spot })
  await expect.element(canvasArea()).toHaveFocus()
}

const modifier = (): string => (isMac() ? "Meta" : "Control")

describe("Zen mode", () => {
  for (const name of ["Focus", "Grid", "Canvas"] as const) {
    context(`when entering Zen in ${name}`, () => {
      it("hides the header, sidebar, rail, and footer but keeps the view, terminal, and draft", async () => {
        await openWorkspace()
        await chooseView(name)
        await terminalTab("Checkout implementation").click()
        await commandInput("Checkout implementation").fill("unfinished command")

        await enterZen().click()

        await expectInZen()
        await expect.element(commandInput("Checkout implementation")).toBeVisible()
        await expect
          .element(commandInput("Checkout implementation"))
          .toHaveValue("unfinished command")
        await showControls().click()
        await expect.element(dockView(name)).toHaveAttribute("aria-pressed", "true")
      })
    })
  }

  context("when entering Zen in Focus", () => {
    it("shows the terminal edge to edge", async () => {
      await openWorkspace()
      const before = focusedBox()

      await enterZen().click()
      await expectInZen()

      await expect.poll(() => focusedBox().width).toBeGreaterThanOrEqual(window.innerWidth * 0.95)
      await expect.poll(() => focusedBox().height).toBeGreaterThan(before.height)
    })
  })

  context("when entering Zen in Canvas", () => {
    it("keeps the camera zoom", async () => {
      await openWorkspace()
      await chooseView("Canvas")
      const initial = await settled(buildWidth)
      await clickCanvasBackground()
      await expectNothingSelected()
      await press("+")
      await expect.poll(buildWidth).toBeGreaterThan(initial * 1.1)
      const zoomed = await settled(buildWidth)

      await enterZen().click()
      await expectInZen()

      await expect.poll(() => Math.abs(buildWidth() / zoomed - 1)).toBeLessThan(0.01)
    })

    it("keeps the active terminal", async () => {
      await openWorkspace()
      await chooseView("Canvas")
      await terminalTab("Runtime").click()

      await enterZen().click()
      await expectInZen()
      await expect.element(terminal("Runtime")).toBeInTheDocument()
      await showControls().click()
      await exitZen().click()

      await expectSelected("Runtime")
    })
  })

  for (const name of ["Grid", "Canvas"] as const) {
    context(`when entering Zen in ${name}`, () => {
      it("gives the view the space of the hidden header, sidebar, and footer", async () => {
        await openWorkspace()
        await chooseView(name)
        const box = () => viewArea(name).element().getBoundingClientRect()
        const before = box()

        await enterZen().click()
        await expectInZen()

        await expect.poll(() => box().width).toBeGreaterThan(before.width + 100)
        await expect.poll(() => box().height).toBeGreaterThan(before.height + 50)
      })
    })
  }

  context("when using Canvas keys on the background in Zen", () => {
    it("zooms in with + and out with −", async () => {
      await openWorkspace()
      await chooseView("Canvas")
      await enterZen().click()
      await expectInZen()
      const initial = await settled(buildWidth)
      await clickCanvasBackground()

      await press("+")
      await expect.poll(buildWidth).toBeGreaterThan(initial * 1.1)
      const zoomed = await settled(buildWidth)

      await press("-")
      await expect.poll(buildWidth).toBeLessThan(zoomed * 0.9)
      await expectInZen()
    })

    it("fits every terminal in view with 0", async () => {
      await openWorkspace()
      await chooseView("Canvas")
      await enterZen().click()
      await expectInZen()
      await clickCanvasBackground()
      await press("+++")
      const area = canvasArea().element().getBoundingClientRect()
      const inside = (name: string): boolean => {
        const box = terminal(name).element().getBoundingClientRect()
        return (
          box.left >= area.left - 1 &&
          box.right <= area.right + 1 &&
          box.top >= area.top - 1 &&
          box.bottom <= area.bottom + 1
        )
      }
      await expect.poll(() => sampleTerminals.every(inside)).toBe(false)

      await press("0")

      await expect.poll(() => sampleTerminals.every(inside)).toBe(true)
      await expectInZen()
    })
  })

  context("when pressing / in Zen", () => {
    it("opens search and stays in Zen", async () => {
      await openWorkspace()
      await enterZen().click()
      await expectInZen()

      await press("/")

      await expect.element(page.getByRole("dialog", { name: "Find a terminal" })).toBeVisible()
      await expectStaysAbsent(enterZen())
    })
  })

  context("when pressing Z on the workspace", () => {
    it("toggles Zen", async () => {
      await openWorkspace()
      await expectOutOfZen()

      await press("z")
      await expectInZen()

      await press("z")
      await expectOutOfZen()
      await expect.element(dock()).not.toBeInTheDocument()
    })

    it("types the letter instead when a terminal input has focus", async () => {
      await openWorkspace()
      await commandInput("Checkout implementation").click()

      await press("z")

      await expect.element(commandInput("Checkout implementation")).toHaveValue("z")
      await expectStaysAbsent(dock())
      await expectOutOfZen()
    })
  })

  context("when the app reloads", () => {
    it("starts outside Zen", async () => {
      await openWorkspace()
      await enterZen().click()
      await expectInZen()

      await reloadWorkspace()

      await expectOutOfZen()
      await expect.element(dock()).not.toBeInTheDocument()
    })
  })
})

describe("Zen dock", () => {
  context("when Zen starts", () => {
    it("folds to New terminal and a chevron", async () => {
      await openWorkspace()

      await enterZen().click()

      await expect.element(dock().getByRole("button", { name: "New terminal" })).toBeVisible()
      await expect.element(showControls()).toHaveAttribute("aria-expanded", "false")
      await expect.element(dockView("Grid")).not.toBeInTheDocument()
      await expect.element(exitZen()).not.toBeInTheDocument()
    })
  })

  context("when clicking the chevron", () => {
    it("shows and hides the view choices and Exit Zen", async () => {
      await openWorkspace()
      await enterZen().click()

      await showControls().click()
      await expect.element(hideControls()).toHaveAttribute("aria-expanded", "true")
      for (const name of ["Focus", "Grid", "Canvas"] as const) {
        // oxlint-disable-next-line no-await-in-loop -- Checks each view choice in turn.
        await expect.element(dockView(name)).toBeVisible()
      }
      await expect.element(exitZen()).toBeVisible()

      await hideControls().click()
      await expect.element(showControls()).toHaveAttribute("aria-expanded", "false")
      await expect.element(exitZen()).not.toBeInTheDocument()
    })
  })

  context("when activating the chevron from the keyboard", () => {
    it("toggles with Enter and Space", async () => {
      await openWorkspace()
      await enterZen().click()
      await expect.element(dock().getByRole("button", { name: "New terminal" })).toHaveFocus()
      await press("{Tab}")
      await expect.element(showControls()).toHaveFocus()

      await press("{Enter}")
      await expect.element(exitZen()).toBeVisible()

      await press(" ")
      await expect.element(showControls()).toHaveAttribute("aria-expanded", "false")
      await expect.element(exitZen()).not.toBeInTheDocument()
    })
  })

  context("when the unfolded dock loses attention", () => {
    it("folds after a click outside", async () => {
      await openWorkspace()
      await enterZen().click()
      await showControls().click()
      await expect.element(exitZen()).toBeVisible()

      await terminal("Checkout implementation")
        .getByRole("heading", { name: "Checkout implementation" })
        .click()

      await expect.element(showControls()).toHaveAttribute("aria-expanded", "false")
      await expect.element(exitZen()).not.toBeInTheDocument()
      await expectStaysAbsent(enterZen())
      await expectInZen()
    })

    it("folds on Escape and returns focus to New terminal", async () => {
      await openWorkspace()
      await enterZen().click()
      await showControls().click()
      await expect.element(exitZen()).toBeVisible()

      await press("{Escape}")

      await expect.element(showControls()).toHaveAttribute("aria-expanded", "false")
      await expect.element(dock().getByRole("button", { name: "New terminal" })).toHaveFocus()
      await expectStaysAbsent(enterZen())
      await expectInZen()
    })

    it("folds when keyboard focus leaves it", async () => {
      await openWorkspace()
      await enterZen().click()
      await press("{Tab}")
      await expect.element(showControls()).toHaveFocus()
      await press("{Enter}")
      await expect.element(exitZen()).toBeVisible()

      await press("{Shift>}{Tab}{Tab}{/Shift}")

      await expect.element(showControls()).toHaveAttribute("aria-expanded", "false")
      await expect.element(exitZen()).not.toBeInTheDocument()
    })
  })

  for (const name of ["Grid", "Canvas"] as const) {
    context(`when choosing ${name} in the dock`, () => {
      it("switches view and stays in Zen", async () => {
        await openWorkspace()
        await enterZen().click()
        await showControls().click()

        await dockView(name).click()

        await expect.element(dockView(name)).toHaveAttribute("aria-pressed", "true")
        await expect.element(dockView("Focus")).toHaveAttribute("aria-pressed", "false")
        await expect.element(terminal("Build")).toBeInTheDocument()
        await expectStaysAbsent(enterZen())
        await expectInZen()
      })
    })
  }

  context("when choosing New terminal in the dock", () => {
    it("creates a terminal and renames it in its header", async () => {
      await openWorkspace()
      await enterZen().click()

      await dock().getByRole("button", { name: "New terminal" }).click()

      await expect.element(terminal("Terminal 07")).toBeVisible()
      await expect
        .element(terminal("Terminal 07").getByRole("textbox", { name: "Rename Terminal 07" }))
        .toHaveFocus()
      await expectInZen()
    })
  })
})

describe("leaving Zen", () => {
  context("when choosing Exit Zen", () => {
    it("restores the sidebar panel that was open", async () => {
      await openWorkspace()
      await sidebarPanel("Sessions").click()
      await expect.element(sidebar()).toHaveAccessibleName("Workspace sessions")
      await enterZen().click()
      await expectInZen()

      await showControls().click()
      await exitZen().click()

      await expectOutOfZen()
      await expect.element(sidebar()).toHaveAccessibleName("Workspace sessions")
      await expect.element(sidebarPanel("Sessions")).toBeChecked()
      await expect.element(enterZen()).toHaveFocus()
    })

    it("keeps a hidden sidebar hidden", async () => {
      await openWorkspace()
      await sidebarPanel("Terminals").click()
      await expect.element(sidebar()).not.toBeInTheDocument()
      await enterZen().click()
      await dock().getByRole("button", { name: "New terminal" }).click()
      await expect.element(terminal("Terminal 07")).toBeVisible()
      await press("{Escape}")

      await showControls().click()
      await exitZen().click()

      await expectOutOfZen()
      await expectStaysAbsent(sidebar())
    })
  })

  context("when pressing a sidebar shortcut", () => {
    it("leaves Zen showing Terminals for the terminal sidebar shortcut", async () => {
      await openWorkspace()
      await sidebarPanel("Sessions").click()
      await enterZen().click()
      await expectInZen()

      await press(`{${modifier()}>}{Shift>}1{/Shift}{/${modifier()}}`)

      await expectOutOfZen()
      await expect.element(sidebar()).toHaveAccessibleName("Terminal sessions")
      await expect.element(sidebarPanel("Terminals")).toBeChecked()
    })

    it("leaves Zen showing Sessions for the session sidebar shortcut", async () => {
      await openWorkspace()
      await enterZen().click()
      await expectInZen()

      await press(`{${modifier()}>}{Shift>}2{/Shift}{/${modifier()}}`)

      await expectOutOfZen()
      await expect.element(sidebar()).toHaveAccessibleName("Workspace sessions")
    })

    it("leaves Zen showing Terminals for B", async () => {
      await openWorkspace()
      await sidebarPanel("Terminals").click()
      await expect.element(sidebar()).not.toBeInTheDocument()
      await enterZen().click()
      await expectInZen()

      await press("b")

      await expectOutOfZen()
      await expect.element(sidebar()).toHaveAccessibleName("Terminal sessions")
    })
  })

  context("when choosing Browse sessions in an empty session", () => {
    it("leaves Zen showing Sessions", async () => {
      await openWorkspace()
      await pressNewSession()
      await expect.element(emptyWorkspace()).toBeVisible()
      await sidebarPanel("Sessions").click()
      await enterZen().click()
      await expectInZen()

      await page.getByRole("button", { name: "Browse sessions" }).click()

      await expectOutOfZen()
      await expect.element(sidebar()).toHaveAccessibleName("Workspace sessions")
    })
  })
})
