import { afterEach } from "vitest"
import { page, userEvent } from "vitest/browser"

import { jump } from "../support/keyboard"
import {
  bounds,
  expectStaysTrue,
  focusView,
  gridView,
  headerGap,
  isShownInGrid,
  overlaps,
  sameBox,
} from "../support/layouts"
import { openMessagesDemo } from "../support/messages"
import { confirmClose, headerAction } from "../support/terminals"
import {
  chooseView,
  clickInto,
  commandInput,
  draftOf,
  enterNavigateMode,
  expectSelected,
  expectStaysAbsent,
  focusStage,
  labelled,
  nameOf,
  openWorkspace,
  press,
  recordAppearance,
  terminal,
  terminalTab,
  terminalTabNames,
  view,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// Wide enough for two tiles side by side beside the sidebar, which 1440 px is not.
const twoColumns = { width: 1920, height: 900 }

const openGrid = async (height = twoColumns.height): Promise<void> => {
  await page.viewport(twoColumns.width, height)
  await openWorkspace()
  await chooseView("Grid")
}

afterEach(async () => {
  await page.viewport(1440, 900)
})

/** Each shown tile's box by name, in the order the Grid presents them. */
const tileBoxes = (): Record<string, DOMRect> =>
  Object.fromEntries(gridTerminalNames().map((name) => [name, bounds(terminal(name))] as const))

/** The tiles' names in reading order: left to right, then top to bottom. */
const readingOrder = (): string[] =>
  Object.entries(tileBoxes())
    .toSorted(([, a], [, b]) => (Math.abs(a.top - b.top) > 1 ? a.top - b.top : a.left - b.left))
    .map(([name]) => name)

/** Drags a tile by its header onto another tile's header, in several moves. */
const dragTileOnto = async (source: string, destination: string): Promise<void> => {
  const from = bounds(terminal(source))
  const to = bounds(terminal(destination))
  const grid = bounds(gridView())
  const grip = headerGap(source)
  await userEvent.dragAndDrop(gridView(), gridView(), {
    sourcePosition: { x: from.left + grip.x - grid.left, y: from.top + grip.y - grid.top },
    targetPosition: { x: to.left + grip.x - grid.left, y: to.top + grip.y - grid.top },
    steps: 20,
  })
}

/** Drags a tab by pointer onto the top quarter of another tab, as the sidebar's list is reordered. */
const dragTabOnto = async (source: string, destination: string): Promise<void> => {
  const target = terminalTab(destination)
  const { width, height } = target.element().getBoundingClientRect()
  await userEvent.dragAndDrop(terminalTab(source), target, {
    targetPosition: { x: width / 2, y: height / 4 },
    steps: 20,
  })
}

/** Terminal names in the order the Grid presents them. */
const gridTerminalNames = (): string[] =>
  gridView()
    .getByRole("region", { name: / terminal$/ })
    .elements()
    .map((element) => nameOf(element.getAttribute("aria-label")!.replace(/ terminal$/, "")))

/** Waits for a newly shown Grid terminal and returns its name. */
const newTerminalName = async (before: string[]): Promise<string> => {
  await expect.poll(() => gridTerminalNames().length).toBe(before.length + 1)
  return gridTerminalNames().find((name) => !before.includes(name))!
}

describe("Grid view", () => {
  context("when laying the terminals out", () => {
    it("follows the sidebar's order, left to right and then top to bottom", async () => {
      await openGrid()

      expect(readingOrder()).toEqual(terminalTabNames())
      expect(gridTerminalNames()).toEqual(terminalTabNames())
      const boxes = tileBoxes()
      expect(bounds(terminal(terminalTabNames()[1]!)).left).toBeGreaterThan(
        boxes[terminalTabNames()[0]!]!.right,
      )
    })

    it("gives every terminal the same size, with columns for the Grid's width", async () => {
      await openGrid()

      const boxes = Object.values(tileBoxes())
      for (const box of boxes) {
        expect(box.width).toBeCloseTo(boxes[0]!.width, 0)
        expect(box.height).toBeCloseTo(416, 0)
      }
      // Two tiles of at least 560 px fill a row of the Grid, which is under three.
      expect(boxes[0]!.width).toBeGreaterThanOrEqual(560)
      expect(new Set(boxes.map((box) => Math.round(box.left))).size).toBe(2)
      expect(boxes[1]!.right).toBeLessThanOrEqual(bounds(gridView()).right)
    })

    it("takes the whole width for one column where two would be narrower than 560 px", async () => {
      await page.viewport(1440, 900)
      await openWorkspace()
      await chooseView("Grid")

      const boxes = Object.values(tileBoxes())
      expect(new Set(boxes.map((box) => Math.round(box.left))).size).toBe(1)
      expect(boxes[0]!.width).toBeGreaterThan(1000)
      expect(boxes[0]!.height).toBeCloseTo(416, 0)
    })

    it("lays out again from the sidebar's order when a tab is dragged there", async () => {
      await openGrid()
      const [first, second] = terminalTabNames()

      await dragTabOnto(second!, first!)

      await expect.poll(() => terminalTabNames().slice(0, 2)).toEqual([second, first])
      await expect.poll(() => readingOrder().slice(0, 2)).toEqual([second, first])
    })
  })

  context("when a terminal is added", () => {
    it("shows it first and leaves every tile the size it was", async () => {
      await openGrid()
      const before = tileBoxes()

      await page.getByRole("button", { name: "New terminal" }).click()

      const name = await newTerminalName(Object.keys(before))
      await expect.poll(() => readingOrder()[0]).toBe(name)
      const after = tileBoxes()
      for (const [other, box] of Object.entries(before)) {
        expect(after[other]!.width).toBeCloseTo(box.width, 0)
        expect(after[other]!.height).toBeCloseTo(box.height, 0)
      }
    })
  })

  context("when a terminal is closed", () => {
    it("shifts the later tiles along without resizing them", async () => {
      await openGrid()
      const before = tileBoxes()
      const [first, second, third] = Object.keys(before)

      await headerAction(second!, `Close ${second}`).click()
      await confirmClose()
      await expect.poll(() => gridTerminalNames()).not.toContain(second)

      const after = tileBoxes()
      expect(after[first!]!.left).toBeCloseTo(before[first!]!.left, 0)
      expect(after[third!]!.left).toBeCloseTo(before[second!]!.left, 0)
      expect(after[third!]!.top).toBeCloseTo(before[second!]!.top, 0)
      for (const [name, box] of Object.entries(after))
        expect(box.width).toBeCloseTo(before[name]!.width, 0)
    })
  })

  context("when dragging a terminal by its header", () => {
    it("reorders the Grid and the sidebar's list", async () => {
      await openGrid()
      const [first, second, third] = terminalTabNames()

      await dragTileOnto(third!, first!)

      await expect.poll(() => terminalTabNames().slice(0, 3)).toEqual([third, first, second])
      await expect.poll(() => readingOrder().slice(0, 3)).toEqual([third, first, second])
      // Every tile in its cell, none left over the others.
      const boxes = Object.values(tileBoxes())
      for (const box of boxes) expect(boxes.filter((other) => overlaps(box, other))).toHaveLength(1)
    })

    it("makes room as it goes, before it is dropped", async () => {
      await openGrid()
      const [first, second] = terminalTabNames()
      const from = bounds(terminal(second!))
      // What the tiles and the sidebar show while the pointer is down, noted as it moves.
      const seen: { first: number; tabs: string[] }[] = []
      let dragging = true
      const note = (): void => {
        if (!dragging) return
        seen.push({ first: bounds(terminal(first!)).left, tabs: terminalTabNames().slice(0, 2) })
        requestAnimationFrame(note)
      }
      note()

      await dragTileOnto(second!, first!)
      dragging = false

      // The first tile moved aside, into the dragged tile's cell, while the sidebar's list was
      // still as it was; the drop then saved the order.
      expect(
        seen.some(
          ({ first: left, tabs }) =>
            Math.abs(left - from.left) < 1 && tabs.join() === [first, second].join(),
        ),
      ).toBe(true)
      await expect.poll(() => terminalTabNames().slice(0, 2)).toEqual([second, first])
    })

    it("leaves the order alone when it is dropped where it was", async () => {
      await openGrid()
      const before = terminalTabNames()

      await dragTileOnto(before[0]!, before[0]!)

      await expectStaysTrue(() => terminalTabNames().join() === before.join(), "the sidebar order")
    })
  })

  context("when the terminals do not all fit on screen", () => {
    it("scrolls a terminal selected from its tab into view", async () => {
      await openGrid(560)
      await expect.poll(() => isShownInGrid("Build")).toBe(false)

      await terminalTab("Build").click()

      await expectSelected("Build")
      await expect.poll(() => isShownInGrid("Build")).toBe(true)
    })

    it("shows a new terminal first, in view, over none of the others", async () => {
      await openGrid(560)
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

  context("when the wheel turns over a window", () => {
    const stage = (): HTMLElement => gridView().element().querySelector(".grid-stage")!

    /** Counts the wheels that reach what the terminal draws in its window. */
    const wheelsInside = (name: string): { count: number } => {
      const reached = { count: 0 }
      terminal(name)
        .element()
        .querySelector("[data-terminal-content]")!
        .addEventListener("wheel", () => reached.count++)
      return reached
    }

    it("scrolls the grid, not the window, while another window is selected", async () => {
      await openGrid(560)
      await clickInto("Dev server")
      const reached = wheelsInside("Tests")

      await userEvent.wheel(terminal("Tests"), { delta: { y: 200 } })

      await expect.poll(() => stage().scrollTop).toBeGreaterThan(0)
      expect(reached.count).toBe(0)
    })

    it("scrolls the grid while the window is selected but the focus is elsewhere", async () => {
      await openGrid(560)
      await clickInto("Tests")
      await focusStage()
      await expectSelected("Tests")
      const reached = wheelsInside("Tests")

      await userEvent.wheel(terminal("Tests"), { delta: { y: 200 } })

      await expect.poll(() => stage().scrollTop).toBeGreaterThan(0)
      expect(reached.count).toBe(0)
    })

    /** Lays `element` over what a window shows, where the wheel turns. */
    const cover = (name: string, element: HTMLElement): HTMLElement => {
      element.style.cssText += "; position: absolute; inset: 0; z-index: 50"
      terminal(name).element().querySelector("[data-terminal-content]")!.append(element)
      return element
    }

    it("scrolls the grid over a scroller in the window that keeps its scroll to itself", async () => {
      await openGrid(560)
      await clickInto("Dev server")
      const scroller = document.createElement("div")
      scroller.style.cssText = "overflow-y: auto; overscroll-behavior: contain"
      scroller.innerHTML = '<div style="height: 2000px"></div>'
      cover("Tests", scroller)
      // At its foot, where it can scroll no further down and lets nothing past it.
      scroller.scrollTop = scroller.scrollHeight
      const foot = scroller.scrollTop
      expect(foot).toBeGreaterThan(0)

      await userEvent.wheel(terminal("Tests"), { delta: { y: 200 } })

      await expect.poll(() => stage().scrollTop).toBeGreaterThan(0)
      expect(scroller.scrollTop).toBe(foot)
    })

    it("scrolls the grid over a page the window shows in its own frame", async () => {
      await openGrid(560)
      await clickInto("Dev server")
      const frame = document.createElement("iframe")
      frame.srcdoc = '<div style="height: 2000px"></div>'
      cover("Tests", frame)
      await expect.poll(() => frame.contentDocument?.body?.scrollHeight ?? 0).toBeGreaterThan(1000)

      await userEvent.wheel(terminal("Tests"), { delta: { y: 200 } })

      await expect.poll(() => stage().scrollTop).toBeGreaterThan(0)
      expect(frame.contentWindow!.scrollY).toBe(0)
    })

    it("hands the wheel to the window that is selected and holds the focus", async () => {
      await openGrid(560)
      await clickInto("Tests")
      const reached = wheelsInside("Tests")

      await userEvent.wheel(terminal("Tests"), { delta: { y: 200 } })

      await expect.poll(() => reached.count).toBeGreaterThan(0)
    })
  })

  context("when creating a terminal from the background", () => {
    it("offers Terminal and creates one and focuses its input", async () => {
      await openGrid()
      const before = gridTerminalNames()
      const left = bounds(terminal("Checkout implementation"))
      const right = bounds(terminal("Dev server"))
      const grid = bounds(gridView())

      // In the gutter between two tiles.
      await gridView().click({
        button: "right",
        position: { x: (left.right + right.left) / 2 - grid.left, y: left.top + 40 - grid.top },
      })
      await page.getByRole("menuitem", { name: "Terminal" }).click()

      const name = await newTerminalName(before)
      await expect.element(terminal(name).getByRole("heading", { name })).toBeVisible()
      await expectStaysAbsent(page.getByRole("textbox", { name: labelled("Rename ", name) }))
      await expect.element(commandInput(name)).toHaveFocus()
    })
  })

  context("when double-clicking a header outside the name", () => {
    it("has no effect", async () => {
      await openGrid()
      const before = bounds(terminal("Tests"))

      await terminal("Tests").dblClick({ position: headerGap("Tests") })

      await expectStaysAbsent(page.getByRole("textbox", { name: labelled("Rename ", "Tests") }))
      await expectStaysAbsent(focusView())
      await expectStaysTrue(() => sameBox(bounds(terminal("Tests")), before), "Tests terminal")
      await expect.element(view("Grid")).toBeChecked()
      await expect.element(terminal("Tests").getByRole("heading", { name: "Tests" })).toBeVisible()
    })
  })

  context("when choosing Focus from a terminal header", () => {
    it("opens that terminal in Focus", async () => {
      await openGrid()

      await page.getByRole("button", { name: labelled("Focus ", "Runtime") }).click()

      await expect.element(view("Focus")).toBeChecked()
      await expect
        .element(focusView().getByRole("region", { name: labelled("", "Runtime", " terminal") }))
        .toBeVisible()
      await expect.element(terminal("Checkout implementation")).not.toBeInTheDocument()
      await expectSelected("Runtime")
    })
  })
})

describe("Grid arrow keys", () => {
  // Demo layout at 1920px, two columns in the sidebar's order: Checkout implementation and
  // Dev server, Tests and Checkout review, Runtime and Build.
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
      const below = bounds(terminal("Tests"))
      expect(right.left).toBeGreaterThan(start.right)
      expect(right.top < start.bottom && start.top < right.bottom).toBe(true)
      expect(below.top).toBeGreaterThan(start.bottom - 1)
      expect(below.left).toBeLessThan(start.right)

      await enterNavigateMode()

      await press("{ArrowRight}")
      await expectSelected("Dev server")
      await press("{ArrowDown}")
      await expectSelected("Checkout review")
      await press("{ArrowLeft}")
      await expectSelected("Tests")
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
      await clickInto("Checkout implementation")
      await expectSelected("Checkout implementation")

      await press(jump("Right").keys)
      await expectSelected("Dev server")
      await expect.element(commandInput("Dev server")).toHaveFocus()
      // The dev server, running, takes no command; what is typed reaches it and not the shell.
      await press("ls")
      await expect.element(commandInput("Dev server")).toHaveFocus()
      await expect.poll(() => draftOf("Checkout implementation")).toBe("")
    })
  })

  context("when pressing an arrow toward an edge with no tile", () => {
    it("keeps the selection without wrapping", async () => {
      await selectInGrid("Checkout implementation")
      await enterNavigateMode()

      await press("{ArrowLeft}")
      await expectSelected("Checkout implementation")
      await press("{ArrowUp}")
      await expectSelected("Checkout implementation")

      await terminal("Dev server").click({ position: { x: 150, y: 150 } })
      await expectSelected("Dev server")
      await enterNavigateMode()
      await press("{ArrowUp}")
      await expectSelected("Dev server")

      await terminal("Build").click({ position: { x: 150, y: 150 } })
      await expectSelected("Build")
      await enterNavigateMode()
      await press("{ArrowRight}")
      await expect.element(terminalTab("Build")).toHaveAttribute("aria-current", "true")
    })
  })
})

describe("Grid view's team wire", () => {
  const ticks = () => gridView().element().querySelectorAll(".grid-team-wire-tick").length
  const lit = () => gridView().element().querySelectorAll(".grid-team-wire-shape[data-lit]").length

  it("tints the selected terminal's teammates' windows, as their tabs, its lead's too", async () => {
    const tinted = (name: string) =>
      getComputedStyle(terminal(name).element(), "::after").backgroundColor !== "rgba(0, 0, 0, 0)"
    const outline = (name: string) => getComputedStyle(terminal(name).element()).borderTopColor
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    await chooseView("Grid")
    await expect.poll(() => tinted("Checkout review")).toBe(true)
    expect(outline("Checkout review")).not.toBe(outline("Dev server"))
    expect(tinted("Checkout implementation")).toBe(false)
    expect(tinted("Dev server")).toBe(false)
    // Its worker selected keeps its own look, and its lead takes the tint.
    await terminalTab("Checkout review").click()
    await expect.poll(() => tinted("Checkout implementation")).toBe(true)
    expect(outline("Checkout implementation")).not.toBe(outline("Dev server"))
    expect(tinted("Checkout review")).toBe(false)
    expect(tinted("Dev server")).toBe(false)
    // A terminal in no team selected: none is tinted.
    await terminalTab("Dev server").click()
    await expect.poll(() => tinted("Checkout implementation")).toBe(false)
    expect(tinted("Checkout review")).toBe(false)
  })

  it("runs from the lead to its worker while a member of the team is selected", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    await chooseView("Grid")
    await expect.poll(ticks).toBe(1)
    expect(gridView().element().querySelectorAll(".grid-team-wire-cursor")).toHaveLength(1)
    expect(lit()).toBe(1)
    // It runs through the gutters: no tile has a run in it, nor a tick past its border.
    const tiles = [...gridView().element().querySelectorAll("[data-grid-terminal]")].map((tile) =>
      tile.getBoundingClientRect(),
    )
    const pieces = [
      ...gridView().element().querySelectorAll(".grid-team-wire-run, .grid-team-wire-tick"),
    ]
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      const rect = piece.getBoundingClientRect()
      const slack = piece.className.includes("tick") ? 1 : 0
      for (const tile of tiles)
        expect(
          overlaps(new DOMRect(rect.left, rect.top, rect.width - slack, rect.height), tile),
        ).toBe(false)
    }
  })

  it("stays, at rest, while a terminal in no team is selected", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    await chooseView("Grid")
    await expect.poll(ticks).toBe(1)
    await terminal("Dev server").click({ position: { x: 150, y: 150 } })
    await expectSelected("Dev server")
    await expectStaysTrue(() => ticks() === 1, "the wire stays while Dev server is selected")
    expect(lit()).toBe(0)
  })

  it("is there when the view opens with a terminal in no team selected", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    await chooseView("Grid")
    await expect.poll(ticks).toBe(1)
  })

  it("lights a team's wire, playing its entrance, each time one of its members is selected after another terminal", async () => {
    // Playing where it can be seen: not while the wires are out of the way.
    const entrance =
      ".grid-team-wire:not([data-settled], [data-hidden]) .grid-team-wire-shape[data-lit]"
    const playing = () => gridView().element().querySelector(entrance) !== null
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    // The entrance is short, and a slow machine can spend it before a first look: it is noted
    // from before the view is chosen, and from before each selection after.
    const played = recordAppearance(entrance)
    await chooseView("Grid")
    await expect.poll(played).toBe(true)
    await expect.poll(playing, { timeout: 4000 }).toBe(false)
    expect(lit()).toBe(1)
    // Another terminal rests the wire, and plays nothing.
    await terminal("Dev server").click({ position: { x: 150, y: 150 } })
    await expectSelected("Dev server")
    await expect.poll(lit).toBe(0)
    await expectStaysTrue(() => !playing(), "nothing plays while Dev server is selected")
    // Back to the same member: it lights, and its entrance plays again.
    const again = recordAppearance(entrance)
    await terminal("Checkout implementation").click({ position: { x: 150, y: 150 } })
    await expectSelected("Checkout implementation")
    await expect.poll(again).toBe(true)
    expect(lit()).toBe(1)
  })
})
