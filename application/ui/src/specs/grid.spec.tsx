import { afterEach, describe as context, describe, expect, it } from "vitest"
import { page, userEvent } from "vitest/browser"

import { jump } from "./support/keyboard"
import {
  bounds,
  expectStaysTrue,
  focusView,
  gridView,
  headerGap,
  isShownInGrid,
  overlaps,
  sameBox,
} from "./support/layouts"
import {
  chooseView,
  commandInput,
  enterNavigateMode,
  expectSelected,
  expectStaysAbsent,
  focusStage,
  openWorkspace,
  press,
  terminal,
  terminalTab,
  view,
} from "./support/workspace"

const resizeButton = (label: "Make full width" | "Restore width", name: string) =>
  page.getByRole("button", { name: `${label}: ${name}` })

const openGrid = async (): Promise<void> => {
  await openWorkspace()
  await chooseView("Grid")
}

/** Terminal names in the order the Grid presents them. */
const gridTerminalNames = (): string[] =>
  gridView()
    .getByRole("region", { name: / terminal$/ })
    .elements()
    .map((element) => element.getAttribute("aria-label")!.replace(/ terminal$/, ""))

/** Waits for a newly shown Grid terminal and returns its name. */
const newTerminalName = async (before: string[]): Promise<string> => {
  await expect.poll(() => gridTerminalNames().length).toBe(before.length + 1)
  return gridTerminalNames().find((name) => !before.includes(name))!
}

describe("Grid view", () => {
  context("when making a terminal full width", () => {
    it("fills the available columns", async () => {
      await openGrid()
      const compact = bounds(terminal("Tests")).width

      await resizeButton("Make full width", "Tests").click()

      await expect
        .element(resizeButton("Restore width", "Tests"))
        .toHaveAttribute("aria-pressed", "true")
      await expect.poll(() => bounds(terminal("Tests")).width).toBeGreaterThan(compact)
      await expect
        .poll(() => bounds(terminal("Tests")).width / bounds(gridView()).width)
        .toBeGreaterThan(0.9)
    })

    it("returns to the previous width and keeps the height when restored", async () => {
      await openGrid()
      const before = bounds(terminal("Tests"))
      await resizeButton("Make full width", "Tests").click()
      await expect
        .poll(() => bounds(terminal("Tests")).width / bounds(gridView()).width)
        .toBeGreaterThan(0.9)

      await resizeButton("Restore width", "Tests").click()

      await expect
        .element(resizeButton("Make full width", "Tests"))
        .toHaveAttribute("aria-pressed", "false")
      await expect.poll(() => bounds(terminal("Tests")).width).toBeCloseTo(before.width, 0)
      await expect.poll(() => bounds(terminal("Tests")).height).toBeCloseTo(before.height, 0)
    })

    it("remembers the choice after visiting Focus", async () => {
      await openGrid()
      await resizeButton("Make full width", "Tests").click()
      await expect.element(resizeButton("Restore width", "Tests")).toBeInTheDocument()

      await chooseView("Focus")
      await chooseView("Grid")

      await expect
        .element(resizeButton("Restore width", "Tests"))
        .toHaveAttribute("aria-pressed", "true")
      await expect
        .poll(() => bounds(terminal("Tests")).width / bounds(gridView()).width)
        .toBeGreaterThan(0.9)
    })

    it("keeps the choice to Grid, leaving the terminal compact in Canvas", async () => {
      await openGrid()
      await resizeButton("Make full width", "Tests").click()
      await expect.element(resizeButton("Restore width", "Tests")).toBeInTheDocument()

      await chooseView("Canvas")

      await expect
        .element(page.getByRole("button", { name: "Enlarge terminal: Tests" }))
        .toHaveAttribute("aria-pressed", "false")
    })
  })

  context("when dragging a terminal's resize corner", () => {
    it("resizes the terminal to follow the pointer", async () => {
      await openGrid()
      const before = bounds(terminal("Tests"))
      const grid = bounds(gridView())

      await userEvent.dragAndDrop(gridView(), gridView(), {
        sourcePosition: { x: before.right - 4 - grid.left, y: before.bottom - 4 - grid.top },
        targetPosition: { x: before.right - 4 - grid.left, y: before.bottom + 120 - grid.top },
      })

      await expect.poll(() => bounds(terminal("Tests")).height).toBeGreaterThan(before.height + 60)
      await expect.poll(() => bounds(terminal("Tests")).width).toBeCloseTo(before.width, 0)
    })
  })

  context("when dragging a terminal by its header", () => {
    it("moves the terminal to where it is dropped", async () => {
      await openGrid()
      const from = bounds(terminal("Tests"))
      const to = bounds(terminal("Checkout implementation"))
      const grid = bounds(gridView())
      const grip = headerGap("Tests")

      await userEvent.dragAndDrop(gridView(), gridView(), {
        sourcePosition: { x: from.left + grip.x - grid.left, y: from.top + grip.y - grid.top },
        targetPosition: { x: to.left + grip.x - grid.left, y: to.top + grip.y - grid.top },
      })

      await expect.poll(() => bounds(terminal("Tests")).left).toBeCloseTo(to.left, 0)
      await expect
        .poll(() =>
          overlaps(bounds(terminal("Tests")), bounds(terminal("Checkout implementation"))),
        )
        .toBe(false)
    })
  })

  context("when the terminals do not all fit on screen", () => {
    afterEach(async () => {
      await page.viewport(1440, 900)
    })

    it("scrolls a terminal selected from its tab into view", async () => {
      await page.viewport(1440, 560)
      await openGrid()
      await expect.poll(() => isShownInGrid("Build")).toBe(false)

      await terminalTab("Build").click()

      await expectSelected("Build")
      await expect.poll(() => isShownInGrid("Build")).toBe(true)
    })

    it("places a new terminal in a free slot and scrolls it into view", async () => {
      await page.viewport(1440, 560)
      await openGrid()
      const before = gridTerminalNames()

      await page.getByRole("button", { name: "New terminal" }).click()

      const name = await newTerminalName(before)
      await expect.poll(() => isShownInGrid(name)).toBe(true)
      await expect
        .poll(() =>
          before.filter((other) => overlaps(bounds(terminal(name)), bounds(terminal(other)))),
        )
        .toEqual([])
    })
  })

  context("when creating a terminal from the background", () => {
    it("offers Terminal and creates one and focuses its input", async () => {
      await openGrid()
      const before = gridTerminalNames()
      const left = bounds(terminal("Checkout implementation"))
      const right = bounds(terminal("Dev server"))
      const grid = bounds(gridView())

      await gridView().click({
        button: "right",
        position: { x: (left.right + right.left) / 2 - grid.left, y: left.top + 40 - grid.top },
      })
      await page.getByRole("menuitem", { name: "Terminal" }).click()

      const name = await newTerminalName(before)
      await expect.element(terminal(name).getByRole("heading", { name })).toBeVisible()
      await expectStaysAbsent(page.getByRole("textbox", { name: `Rename ${name}` }))
      await expect.element(commandInput(name)).toHaveFocus()
    })
  })

  context("when double-clicking a header outside the name", () => {
    it("has no effect", async () => {
      await openGrid()
      const before = bounds(terminal("Tests"))

      await terminal("Tests").dblClick({ position: headerGap("Tests") })

      await expectStaysAbsent(page.getByRole("textbox", { name: "Rename Tests" }))
      await expectStaysAbsent(focusView())
      await expectStaysTrue(() => sameBox(bounds(terminal("Tests")), before), "Tests terminal")
      await expect.element(view("Grid")).toBeChecked()
      await expect.element(terminal("Tests").getByRole("heading", { name: "Tests" })).toBeVisible()
    })
  })

  context("when choosing Focus from a terminal header", () => {
    it("opens that terminal in Focus", async () => {
      await openGrid()

      await page.getByRole("button", { name: "Focus Runtime" }).click()

      await expect.element(view("Focus")).toBeChecked()
      await expect
        .element(focusView().getByRole("region", { name: "Runtime terminal" }))
        .toBeVisible()
      await expect.element(terminal("Checkout implementation")).not.toBeInTheDocument()
      await expectSelected("Runtime")
    })
  })
})

describe("Grid arrow keys", () => {
  // Demo layout at 1440px, three columns: Checkout implementation, Dev server, Tests
  // on top; Checkout review, Runtime, Build below.
  const selectInGrid = async (name: string): Promise<void> => {
    await openGrid()
    await terminal(name).click({ position: { x: 150, y: 150 } })
    await expectSelected(name)
  }

  context("when pressing Right and Down", () => {
    it("selects the tile on that side, as laid out on screen", async () => {
      await selectInGrid("Checkout implementation")
      const start = bounds(terminal("Checkout implementation"))
      const right = bounds(terminal("Dev server"))
      const below = bounds(terminal("Checkout review"))
      expect(right.left).toBeGreaterThan(start.right)
      expect(right.top < start.bottom && start.top < right.bottom).toBe(true)
      expect(below.top).toBeGreaterThan(start.bottom - 1)
      expect(below.left).toBeLessThan(start.right)

      await enterNavigateMode()

      await press("{ArrowRight}")
      await expectSelected("Dev server")
      await press("{ArrowDown}")
      await expectSelected("Runtime")
      await press("{ArrowLeft}")
      await expectSelected("Checkout review")
      await press("{ArrowUp}")
      await expectSelected("Checkout implementation")
    })
  })

  context("when pressing an arrow outside navigate mode", () => {
    it("keeps the selection", async () => {
      await selectInGrid("Checkout implementation")
      await focusStage()

      await press("{ArrowRight}{ArrowDown}")

      await expectSelected("Checkout implementation")
      await expect.element(terminal("Checkout implementation")).toBeVisible()
    })
  })

  context(`when pressing ${jump("Right").label} while typing in a terminal`, () => {
    it("selects the tile on that side and keeps typing there", async () => {
      await openGrid()
      await commandInput("Checkout implementation").click()
      await expectSelected("Checkout implementation")

      await press(jump("Right").keys)
      await expectSelected("Dev server")
      await expect.element(commandInput("Dev server")).toHaveFocus()
      await press("ls")
      await expect.element(commandInput("Dev server")).toHaveValue("ls")
      await expect.element(commandInput("Checkout implementation")).toHaveValue("")

      await press(jump("Down").keys)
      await expectSelected("Runtime")
      await expect.element(commandInput("Runtime")).toHaveFocus()
    })

    it("stays put at the edge without typing anything", async () => {
      await openGrid()
      await commandInput("Checkout implementation").click()

      await press(jump("Left").keys)
      await expectSelected("Checkout implementation")
      await expect.element(commandInput("Checkout implementation")).toHaveFocus()
      await expect.element(commandInput("Checkout implementation")).toHaveValue("")
    })
  })

  context("when pressing an arrow toward an edge with no tile", () => {
    it("keeps the selection without wrapping", async () => {
      await selectInGrid("Checkout implementation")
      await enterNavigateMode()

      await press("{ArrowLeft}")
      await expectSelected("Checkout implementation")
      // Its shorter row-mates are beside it, not above it.
      await press("{ArrowUp}")
      await expectSelected("Checkout implementation")

      await terminal("Dev server").click({ position: { x: 150, y: 150 } })
      await expectSelected("Dev server")
      await enterNavigateMode()
      await press("{ArrowUp}")
      await expectSelected("Dev server")

      await terminal("Tests").click({ position: { x: 150, y: 150 } })
      await expectSelected("Tests")
      await enterNavigateMode()
      await press("{ArrowRight}")
      await expect.element(terminalTab("Tests")).toHaveAttribute("aria-current", "true")
    })
  })
})
