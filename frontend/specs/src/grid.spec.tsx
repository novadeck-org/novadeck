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
import { openMessagesDemo } from "./support/messages"
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
  view,
} from "./support/workspace"

const resizeButton = (label: "Make full width" | "Restore width", name: string) =>
  page.getByRole("button", { name: labelled(`${label}: `, name) })

const openGrid = async (): Promise<void> => {
  await openWorkspace()
  await chooseView("Grid")
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

    it("keeps the choice to Grid, where Canvas offers no width control", async () => {
      await openGrid()
      await resizeButton("Make full width", "Tests").click()
      await expect.element(resizeButton("Restore width", "Tests")).toBeInTheDocument()

      await chooseView("Canvas")

      await expect.element(terminal("Tests")).toBeVisible()
      await expect.element(resizeButton("Restore width", "Tests")).not.toBeInTheDocument()
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

    it("lets no terminal's text be selected until the corner is let go", async () => {
      await openGrid()
      const corner = bounds(terminal("Tests"))
      const at = { clientX: corner.right - 4, clientY: corner.bottom - 4, button: 0, bubbles: true }
      const text = (): string =>
        getComputedStyle(terminal("Dev server").element().querySelector("[data-terminal-content]")!)
          .userSelect
      expect(text()).toBe("text")

      document
        .elementFromPoint(at.clientX, at.clientY)!
        .dispatchEvent(new MouseEvent("mousedown", at))
      await expect.poll(text).toBe("none")

      document.dispatchEvent(new MouseEvent("mouseup", at))
      await expect.poll(text).toBe("text")
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

    it("follows the pointer between columns rather than jumping from one to the next", async () => {
      await openGrid()
      const from = bounds(terminal("Tests"))
      const grip = headerGap("Tests")
      const at = (dx: number): MouseEventInit => ({
        clientX: from.left + grip.x + dx,
        clientY: from.top + grip.y,
        button: 0,
        bubbles: true,
      })
      document
        .elementFromPoint(from.left + grip.x, from.top + grip.y)!
        .dispatchEvent(new MouseEvent("mousedown", at(0)))
      await expect
        .poll(() => terminal("Tests").element().closest(".react-draggable-dragging"))
        .not.toBeNull()
      // Past the drag's threshold, then a few pixels on: far less than a column.
      document.dispatchEvent(new MouseEvent("mousemove", at(20)))
      await expect.poll(() => bounds(terminal("Tests")).left).not.toBe(from.left)
      const started = bounds(terminal("Tests")).left

      document.dispatchEvent(new MouseEvent("mousemove", at(26)))

      await expect.poll(() => bounds(terminal("Tests")).left).toBeCloseTo(started + 6, 0)
      document.dispatchEvent(new MouseEvent("mouseup", at(26)))
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

  context("when the wheel turns over a window", () => {
    afterEach(async () => {
      await page.viewport(1440, 900)
    })

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
      await page.viewport(1440, 560)
      await openGrid()
      await clickInto("Dev server")
      const reached = wheelsInside("Tests")

      await userEvent.wheel(terminal("Tests"), { delta: { y: 200 } })

      await expect.poll(() => stage().scrollTop).toBeGreaterThan(0)
      expect(reached.count).toBe(0)
    })

    it("scrolls the grid while the window is selected but the focus is elsewhere", async () => {
      await page.viewport(1440, 560)
      await openGrid()
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
      await page.viewport(1440, 560)
      await openGrid()
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
      await page.viewport(1440, 560)
      await openGrid()
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
      await page.viewport(1440, 560)
      await openGrid()
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
