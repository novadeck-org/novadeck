import { describe as context, describe, expect, it, onTestFinished } from "vitest"
import { page, type Locator } from "vitest/browser"

import {
  boxesOf,
  boxOf,
  canvasMenu,
  clickBackground,
  doubleClickHeader,
  dragBackground,
  dragBy,
  dragHeader,
  fillsView,
  insideView,
  near,
  rightClickBackground,
  sameBox,
  scrollCanvas,
  scrollOver,
  settled,
  terminalAt,
  viewBox,
  type Box,
} from "./support/canvas"
import { overlaps } from "./support/layouts"
import {
  chooseView,
  expectSelected,
  expectStaysAbsent,
  openWorkspace,
  press,
  terminal,
  terminalTab,
  view,
} from "./support/workspace"

const names = ["Checkout implementation", "Dev server", "Checkout review", "Runtime"]
const area = (box: Box): number => box.width * box.height
const ratio = (box: Box): number => box.width / box.height

const openCanvas = async (): Promise<void> => {
  await openWorkspace()
  await chooseView("Canvas")
  await expect.element(terminal("Checkout implementation")).toBeVisible()
  await settled(() => boxesOf(names))
}

/** Pans the camera down so the middle of the Canvas is bare, ready for wheel gestures. */
const clearMiddle = async (): Promise<void> => {
  await dragBackground({ x: 150, y: 100 }, { x: 0, y: 450 })
  await settled(() => boxesOf(names))
}

/** Every terminal kept its size and moved on screen by exactly `by`. */
const allShifted = (before: Record<string, Box>, by: { x: number; y: number }): boolean =>
  Object.entries(boxesOf(Object.keys(before))).every(([name, box]) =>
    sameBox(box, {
      ...before[name]!,
      left: before[name]!.left + by.x,
      top: before[name]!.top + by.y,
    }),
  )

const flownTo = (name: string): Promise<boolean> =>
  settled(() => boxOf(terminal(name))).then(fillsView)

const asRect = (box: Box): DOMRect => new DOMRect(box.left, box.top, box.width, box.height)

/** Moves Dev server over Checkout implementation, then brings Checkout implementation to the front. */
const overlapDevServerOnCheckout = async (): Promise<{ x: number; y: number }> => {
  await terminal("Dev server").click({ position: { x: 150, y: 150 } })
  await expectSelected("Dev server")
  await dragHeader("Dev server", { x: -300, y: 0 })
  const overlap = await settled(() => {
    const front = boxOf(terminal("Dev server"))
    return { x: front.left + 60, y: front.top + 150 }
  })
  expect(terminalAt(overlap)).toBe("Dev server")
  await terminal("Checkout implementation").click({ position: { x: 100, y: 200 } })
  await expect.poll(() => terminalAt(overlap)).toBe("Checkout implementation")
  return overlap
}

const enlarge = (name: string): Locator =>
  terminal(name).getByRole("button", { name: `Enlarge terminal: ${name}` })
const compact = (name: string): Locator =>
  terminal(name).getByRole("button", { name: `Make compact: ${name}` })

describe("Canvas", () => {
  context("when scrolling the wheel over the canvas", () => {
    it("zooms in, making terminals larger on screen", async () => {
      await openCanvas()
      await clearMiddle()
      const before = boxOf(terminal("Dev server"))

      await scrollCanvas(-300)

      await expect
        .poll(() => boxOf(terminal("Dev server")).width)
        .toBeGreaterThan(before.width + 20)
    })

    it("zooms out, making terminals smaller on screen", async () => {
      await openCanvas()
      await clearMiddle()
      const before = boxOf(terminal("Dev server"))

      await scrollCanvas(300)

      await expect.poll(() => boxOf(terminal("Dev server")).width).toBeLessThan(before.width - 20)
    })
  })

  context("when pressing zoom keys on the canvas background", () => {
    it("zooms in with + and out with −", async () => {
      await openCanvas()
      await clickBackground({ x: 150, y: 100 })
      const start = boxOf(terminal("Checkout implementation")).width

      await press("+")
      await expect
        .poll(() => boxOf(terminal("Checkout implementation")).width)
        .toBeGreaterThan(start + 20)

      const zoomed = await settled(() => boxOf(terminal("Checkout implementation")).width)
      await press("-")
      await expect
        .poll(() => boxOf(terminal("Checkout implementation")).width)
        .toBeLessThan(zoomed - 20)
    })

    it("fits all terminals inside the view with 0", async () => {
      await openCanvas()
      const all = [
        "Checkout implementation",
        "Dev server",
        "Tests",
        "Checkout review",
        "Runtime",
        "Build",
      ]
      expect(all.every((name) => insideView(boxOf(terminal(name))))).toBe(false)
      await clickBackground({ x: 150, y: 100 })

      await press("0")

      await expect.poll(() => all.every((name) => insideView(boxOf(terminal(name))))).toBe(true)
    })
  })

  context("when dragging the background", () => {
    it("pans every terminal by the drag distance without resizing them", async () => {
      await openCanvas()
      const before = boxesOf(names)

      await dragBackground({ x: 150, y: 100 }, { x: 120, y: 80 })

      await expect.poll(() => allShifted(before, { x: 120, y: 80 })).toBe(true)
    })
  })

  context("when dragging an inactive terminal", () => {
    it("pans the canvas instead of moving the terminal", async () => {
      await openCanvas()
      await expectSelected("Checkout implementation")
      const before = boxesOf(names)

      await dragBy(terminal("Dev server"), { x: -150, y: 60 }, { x: 120, y: 150 })

      await expect.poll(() => allShifted(before, { x: -150, y: 60 })).toBe(true)
    })
  })

  context("when clicking a terminal", () => {
    it("activates it and brings it in front of the terminal it overlaps", async () => {
      await openCanvas()
      await terminal("Dev server").click({ position: { x: 150, y: 150 } })
      await expectSelected("Dev server")
      // Overlap the two terminals by moving Dev server over Checkout implementation.
      await dragHeader("Dev server", { x: -300, y: 0 })
      const overlap = await settled(() => {
        const front = boxOf(terminal("Dev server"))
        return { x: front.left + 60, y: front.top + 150 }
      })
      const behind = boxOf(terminal("Checkout implementation"))
      expect(overlap.x).toBeLessThan(behind.left + behind.width)
      expect(overlap.y).toBeLessThan(behind.top + behind.height)
      expect(terminalAt(overlap)).toBe("Dev server")

      await terminal("Checkout implementation").click({ position: { x: 100, y: 200 } })

      await expectSelected("Checkout implementation")
      await expect.poll(() => terminalAt(overlap)).toBe("Checkout implementation")
    })
  })

  context("when dragging the active terminal's header", () => {
    it("moves only that terminal", async () => {
      await openCanvas()
      await expectSelected("Checkout implementation")
      const before = boxesOf(names)

      await dragHeader("Checkout implementation", { x: 96, y: -120 })

      const after = await settled(() => boxesOf(names))
      const moved = after["Checkout implementation"]!
      const origin = before["Checkout implementation"]!
      // The terminal lands on the canvas grid, so allow for snapping and drag slop.
      expect(near(moved.left, origin.left + 96, 20)).toBe(true)
      expect(near(moved.top, origin.top - 120, 20)).toBe(true)
      expect(near(moved.width, origin.width) && near(moved.height, origin.height)).toBe(true)
      for (const name of ["Dev server", "Checkout review", "Runtime"])
        expect(sameBox(after[name]!, before[name]!)).toBe(true)
    })
  })

  context("when double-clicking a terminal header beside its name", () => {
    it("centres the terminal and zooms it to fit the view", async () => {
      await openCanvas()

      await doubleClickHeader("Dev server")

      await expectSelected("Dev server")
      await expect.poll(() => fillsView(boxOf(terminal("Dev server")))).toBe(true)
    })

    it("returns to the previous camera when repeated on the same terminal", async () => {
      await openCanvas()
      const before = boxesOf(names)
      await doubleClickHeader("Checkout implementation")
      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(true)

      await doubleClickHeader("Checkout implementation")

      await expect
        .poll(() => names.every((name) => sameBox(boxOf(terminal(name)), before[name]!)))
        .toBe(true)
    })

    it("flies to the terminal again after a manual pan instead of returning", async () => {
      await openCanvas()
      await doubleClickHeader("Checkout implementation")
      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(true)
      await dragBackground({ x: 8, y: 400 }, { x: 150, y: 40 })
      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(false)

      await doubleClickHeader("Checkout implementation")

      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(true)
    })

    it("flies to the terminal again after zooming with the keyboard instead of returning", async () => {
      await openCanvas()
      await doubleClickHeader("Checkout implementation")
      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(true)
      await clickBackground({ x: 8, y: 400 })
      await press("-")
      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(false)

      await doubleClickHeader("Checkout implementation")

      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(true)
    })

    it("starts a new visit when flying to a different terminal", async () => {
      // A tall window keeps the terminal below in view while the first one fills the width.
      await page.viewport(1440, 1600)
      onTestFinished(() => page.viewport(1440, 900))
      await openCanvas()
      await doubleClickHeader("Checkout implementation")
      const visited = await settled(() => boxOf(terminal("Checkout implementation")))
      expect(fillsView(visited)).toBe(true)

      await doubleClickHeader("Checkout review")
      await expect.poll(() => fillsView(boxOf(terminal("Checkout review")))).toBe(true)
      await doubleClickHeader("Checkout review")

      await expect
        .poll(() => sameBox(boxOf(terminal("Checkout implementation")), visited))
        .toBe(true)
    })

    it("restores a minimized terminal and keeps it restored when returning", async () => {
      await openCanvas()
      await terminal("Checkout implementation")
        .getByRole("button", { name: "Minimize Checkout implementation" })
        .click()
      await expect
        .element(page.getByRole("textbox", { name: "Command for Checkout implementation" }))
        .not.toBeInTheDocument()

      await doubleClickHeader("Checkout implementation")

      await expect
        .element(page.getByRole("textbox", { name: "Command for Checkout implementation" }))
        .toBeVisible()
      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(true)

      await doubleClickHeader("Checkout implementation")

      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(false)
      await expect
        .element(page.getByRole("textbox", { name: "Command for Checkout implementation" }))
        .toBeVisible()
    })
  })

  context("when using the header resize control", () => {
    it("enlarges to the view's aspect ratio at four times the compact area, around its centre", async () => {
      // A tall window gives the view a portrait shape, far from the compact 3:2.
      await page.viewport(1440, 1600)
      onTestFinished(() => page.viewport(1440, 900))
      await openCanvas()
      const original = boxOf(terminal("Checkout implementation"))
      const others = boxesOf(["Dev server", "Checkout review"])

      await enlarge("Checkout implementation").click()

      await expect
        .element(compact("Checkout implementation"))
        .toHaveAttribute("aria-pressed", "true")
      const enlarged = await settled(() => boxOf(terminal("Checkout implementation")))
      const shape = viewBox()
      expect(shape.width / shape.height).toBeLessThan(1)
      expect(ratio(enlarged)).toBeCloseTo(shape.width / shape.height, 1)
      expect(
        near(enlarged.centerX, original.centerX, 13) &&
          near(enlarged.centerY, original.centerY, 13),
      ).toBe(true)
      for (const [name, box] of Object.entries(others))
        expect(sameBox(boxOf(terminal(name)), box)).toBe(true)

      await compact("Checkout implementation").click()

      await expect
        .element(enlarge("Checkout implementation"))
        .toHaveAttribute("aria-pressed", "false")
      const compacted = await settled(() => boxOf(terminal("Checkout implementation")))
      expect(ratio(compacted)).toBeCloseTo(3 / 2, 2)
      expect(area(enlarged) / area(compacted)).toBeCloseTo(4, 1)
    })

    it("enlarges to the same canvas size at any zoom", async () => {
      await openCanvas()
      const relativeArea = async (): Promise<number> => {
        await enlarge("Checkout implementation").click()
        await expect.element(compact("Checkout implementation")).toBeInTheDocument()
        const boxes = await settled(() => boxesOf(["Checkout implementation", "Dev server"]))
        return area(boxes["Checkout implementation"]!) / area(boxes["Dev server"]!)
      }
      const atStart = await relativeArea()
      await compact("Checkout implementation").click()
      await clickBackground({ x: 150, y: 100 })
      const width = (await settled(() => boxOf(terminal("Dev server")))).width
      await press("-")
      await expect.poll(() => boxOf(terminal("Dev server")).width).toBeLessThan(width - 20)

      const zoomedOut = await relativeArea()

      expect(zoomedOut / atStart).toBeCloseTo(1, 1)
    })

    it("restores a minimized terminal", async () => {
      await openCanvas()
      await terminal("Checkout implementation")
        .getByRole("button", { name: "Minimize Checkout implementation" })
        .click()
      await expect
        .element(page.getByRole("textbox", { name: "Command for Checkout implementation" }))
        .not.toBeInTheDocument()

      await enlarge("Checkout implementation").click()

      await expect
        .element(page.getByRole("textbox", { name: "Command for Checkout implementation" }))
        .toBeVisible()
      await expect
        .element(
          terminal("Checkout implementation").getByRole("button", {
            name: "Minimize Checkout implementation",
          }),
        )
        .toBeVisible()
    })
  })

  context("when creating a terminal with New terminal", () => {
    it("places it inside the view without changing zoom", async () => {
      await openCanvas()
      const before = boxesOf(names)

      await page.getByRole("button", { name: "New terminal", exact: true }).click()

      await expect.element(terminal("Terminal 07")).toBeVisible()
      // The camera may pan a moment later to reveal it; wait for what the person ends up seeing.
      await expect.poll(() => insideView(boxOf(terminal("Terminal 07")))).toBe(true)
      const after = await settled(() => boxesOf(names))
      for (const name of names) {
        expect(near(after[name]!.width, before[name]!.width)).toBe(true)
        expect(near(after[name]!.height, before[name]!.height)).toBe(true)
      }
    })
  })

  context("when choosing Terminal from the background context menu", () => {
    it("places the new terminal's top-left corner at the clicked point without moving the camera", async () => {
      await openCanvas()
      const before = boxesOf(names)
      await rightClickBackground({ x: 100, y: 120 })

      await canvasMenu().getByRole("menuitem", { name: "Terminal" }).click()

      await expect.element(terminal("Terminal 07")).toBeVisible()
      await expectSelected("Terminal 07")
      await expect.element(canvasMenu()).not.toBeInTheDocument()
      const created = await settled(() => boxOf(terminal("Terminal 07")))
      // The corner lands on the canvas grid, so allow for snapping.
      expect(near(created.left, 100, 13) && near(created.top, 120, 13)).toBe(true)
      for (const name of names) expect(sameBox(boxOf(terminal(name)), before[name]!)).toBe(true)
    })

    it("does not start renaming the new terminal", async () => {
      await openCanvas()
      await rightClickBackground({ x: 100, y: 120 })

      await canvasMenu().getByRole("menuitem", { name: "Terminal" }).click()

      await expect.element(terminalTab("Terminal 07")).toBeVisible()
      await expectStaysAbsent(page.getByRole("textbox", { name: "Rename Terminal 07" }))
    })
  })

  context("when right-clicking a terminal", () => {
    it("does not offer the canvas actions", async () => {
      await openCanvas()
      await rightClickBackground({ x: 100, y: 120 })
      await expect.element(canvasMenu()).toBeVisible()
      await press("{Escape}")
      await expect.element(canvasMenu()).not.toBeInTheDocument()

      await terminal("Checkout implementation").click({
        button: "right",
        position: { x: 150, y: 150 },
      })

      await expectStaysAbsent(canvasMenu())
    })
  })

  context("when pressing modified arrow keys on the canvas", () => {
    it("neither pans the canvas nor moves the active terminal", async () => {
      await openCanvas()
      await terminal("Checkout implementation").click({ position: { x: 150, y: 150 } })
      await expectSelected("Checkout implementation")
      const before = boxesOf(names)

      await press("{Shift>}{ArrowLeft}{ArrowRight}{ArrowUp}{ArrowDown}{/Shift}")
      await clickBackground({ x: 150, y: 100 })
      await press("{Shift>}{ArrowLeft}{ArrowRight}{ArrowUp}{ArrowDown}{/Shift}")
      await press("{Control>}{ArrowLeft}{ArrowUp}{/Control}")

      const after = await settled(() => boxesOf(names))
      for (const name of names) expect(sameBox(after[name]!, before[name]!)).toBe(true)
    })
  })

  context("when selecting an off-screen terminal", () => {
    it("pans to reveal it when chosen from its sidebar tab, keeping the zoom", async () => {
      await openCanvas()
      const before = boxOf(terminal("Tests"))
      expect(insideView(before)).toBe(false)

      await terminalTab("Tests").click()

      await expectSelected("Tests")
      await expect.poll(() => insideView(boxOf(terminal("Tests")))).toBe(true)
      const after = await settled(() => boxOf(terminal("Tests")))
      expect(near(after.width, before.width) && near(after.height, before.height)).toBe(true)
    })

    it("pans to reveal it when reached with Down", async () => {
      await openCanvas()
      await terminalTab("Dev server").click()
      await expectSelected("Dev server")
      expect(insideView(await settled(() => boxOf(terminal("Tests"))))).toBe(false)

      await press("{ArrowDown}")

      await expectSelected("Tests")
      await expect.poll(() => insideView(boxOf(terminal("Tests")))).toBe(true)
    })
  })

  context("when the camera moves between two double-clicks on the same header", () => {
    const moves: [string, () => Promise<void>][] = [
      [
        "zooming with the wheel",
        () =>
          scrollOver(
            terminal("Checkout implementation").getByRole("heading", {
              name: "Checkout implementation",
            }),
            200,
          ),
      ],
      [
        "fitting all terminals",
        async () => {
          await clickBackground({ x: 8, y: 400 })
          await press("0")
        },
      ],
      [
        "navigating from the sidebar",
        async () => {
          await terminalTab("Dev server").click()
          await expectSelected("Dev server")
          await terminalTab("Checkout implementation").click()
          await expectSelected("Checkout implementation")
        },
      ],
      [
        "leaving Canvas and coming back",
        async () => {
          await chooseView("Grid")
          await chooseView("Canvas")
        },
      ],
    ]
    for (const [move, perform] of moves) {
      it(`flies to the terminal again after ${move} instead of returning`, async () => {
        await openCanvas()
        await doubleClickHeader("Checkout implementation")
        expect(await flownTo("Checkout implementation")).toBe(true)
        await perform()
        await settled(() => boxesOf(names))

        await doubleClickHeader("Checkout implementation")

        expect(await flownTo("Checkout implementation")).toBe(true)
      })
    }
  })

  context("when activating terminals that do not overlap", () => {
    it("keeps the most recently activated terminal in front while in Canvas", async () => {
      await openCanvas()
      const overlap = await overlapDevServerOnCheckout()

      await terminal("Runtime").click({ position: { x: 100, y: 150 } })

      await expectSelected("Runtime")
      await settled(() => boxesOf(names))
      expect(terminalAt(overlap)).toBe("Checkout implementation")
    })

    it("forgets that order after leaving Canvas", async () => {
      await openCanvas()
      const overlap = await overlapDevServerOnCheckout()
      await terminal("Runtime").click({ position: { x: 100, y: 150 } })
      await expectSelected("Runtime")

      await chooseView("Grid")
      await chooseView("Canvas")

      await settled(() => boxesOf(names))
      expect(terminalAt(overlap)).toBe("Dev server")
    })
  })

  context("when choosing Focus in a terminal header", () => {
    it("opens that terminal in Focus", async () => {
      await openCanvas()

      await terminal("Checkout review")
        .getByRole("button", { name: "Focus Checkout review" })
        .click()

      await expect.element(view("Focus")).toBeChecked()
      await expectSelected("Checkout review")
      await expect.element(terminal("Checkout review")).toBeVisible()
      await expect.element(terminal("Checkout implementation")).not.toBeInTheDocument()
    })
  })

  context("when creating a terminal with New terminal while the view has free room", () => {
    it("places it in the free room without moving the camera", async () => {
      await openCanvas()
      await clearMiddle()
      const before = boxesOf(names)

      await page.getByRole("button", { name: "New terminal", exact: true }).click()

      await expect.element(terminal("Terminal 07")).toBeVisible()
      const after = await settled(() => boxesOf([...names, "Terminal 07"]))
      const created = after["Terminal 07"]!
      expect(insideView(created)).toBe(true)
      for (const name of names) {
        expect(sameBox(after[name]!, before[name]!)).toBe(true)
        expect(overlaps(asRect(created), asRect(after[name]!))).toBe(false)
      }
    })
  })

  context("when double-clicking an enlarged terminal's header", () => {
    it("fills the whole view with the terminal", async () => {
      await openCanvas()
      await enlarge("Checkout implementation").click()
      await expect.element(compact("Checkout implementation")).toBeInTheDocument()
      await settled(() => boxOf(terminal("Checkout implementation")))

      await doubleClickHeader("Checkout implementation")

      const filled = await settled(() => boxOf(terminal("Checkout implementation")))
      const whole = viewBox()
      expect(near(filled.width, whole.width, 4) && near(filled.height, whole.height, 4)).toBe(true)
      expect(near(filled.left, 0, 3) && near(filled.top, 0, 3)).toBe(true)
    })
  })
})
