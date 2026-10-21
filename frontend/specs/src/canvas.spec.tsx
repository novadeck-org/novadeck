import { describe as context, describe, expect, it, onTestFinished } from "vitest"
import { page } from "vitest/browser"

import {
  boxesOf,
  boxOf,
  canvasMenu,
  clickBackground,
  doubleClickHeader,
  dragBackground,
  dragBy,
  dragCorner,
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
  type Box,
} from "./support/canvas"
import { escapeFrom, newTerminalName } from "./support/keyboard"
import { overlaps } from "./support/layouts"
import { openMessagesDemo } from "./support/messages"
import {
  chooseView,
  commandInput,
  enterNavigateMode,
  expectSelected,
  expectStaysAbsent,
  focusStage,
  openWorkspace,
  press,
  sidebarPanel,
  terminal,
  terminalTab,
  view,
  labelled,
} from "./support/workspace"

const names = ["Checkout implementation", "Dev server", "Checkout review", "Runtime"]
const allTerminals = [
  "Checkout implementation",
  "Dev server",
  "Tests",
  "Checkout review",
  "Runtime",
  "Build",
]
const allInView = (): boolean => allTerminals.every((name) => insideView(boxOf(terminal(name))))
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

/** Zooms in on `anchor`'s header until Tests is off screen, as Canvas opens framing all. */
const pushTestsOffScreen = async (anchor: string, steps = 4): Promise<void> => {
  if (!insideView(boxOf(terminal("Tests")))) return
  expect(steps).toBeGreaterThan(0)
  await scrollOver(terminal(anchor).getByRole("heading", { name: anchor }), -300)
  await settled(() => boxesOf(names))
  return pushTestsOffScreen(anchor, steps - 1)
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

/** The terminal's size on screen, which a new terminal shares while the zoom holds. */
const sameSize = (actual: Box, expected: Box): boolean =>
  near(actual.width, expected.width) && near(actual.height, expected.height)

/** Resizes Checkout implementation by its corner, and gives back its new box. */
const resizeCheckout = async (): Promise<Box> => {
  const before = boxOf(terminal("Checkout implementation"))
  await dragCorner("Checkout implementation", { x: 120, y: 90 })
  await expect
    .poll(() => boxOf(terminal("Checkout implementation")).width)
    .toBeGreaterThan(before.width + 60)
  return settled(() => boxOf(terminal("Checkout implementation")))
}

describe("Canvas", () => {
  context("when opened", () => {
    it("frames every terminal, however its camera was left", async () => {
      await openCanvas()
      expect(allInView()).toBe(true)
      await clearMiddle()
      expect(allInView()).toBe(false)

      await chooseView("Grid")
      await chooseView("Canvas")

      await expect.element(terminal("Checkout implementation")).toBeVisible()
      await expect.poll(allInView).toBe(true)
    })
  })

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
      await clearMiddle()
      await scrollCanvas(-300)
      await expect.poll(() => allInView()).toBe(false)
      await clickBackground({ x: 150, y: 100 })

      await press("0")

      await expect.poll(() => allInView()).toBe(true)
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
  })

  context("when going to a terminal from its Inbox item", () => {
    it("flies the camera in to it, as a double-click on its header does", async () => {
      await openWorkspace("/?demo=agents")
      const skip = page.getByRole("button", { name: "Skip for now" })
      if (await skip.query()) await skip.click()
      await chooseView("Canvas")
      await expect.element(terminal("Checkout review")).toBeVisible()
      expect(fillsView(await settled(() => boxOf(terminal("Checkout review"))))).toBe(false)
      await sidebarPanel("Inbox").click()
      await page.getByRole("button", { name: /Run pnpm test/ }).click()

      await page
        .getByRole("dialog", { name: "Checkout review" })
        .getByRole("button", { name: "Show terminal" })
        .click()

      await expect.poll(() => fillsView(boxOf(terminal("Checkout review")))).toBe(true)
      // The way back is the visit's, as from a header.
      await doubleClickHeader("Checkout review")
      await expect.poll(() => fillsView(boxOf(terminal("Checkout review")))).toBe(false)
    })

    it("flies in from the camera its session was left with, when the item is from another", async () => {
      await openWorkspace("/projects/storefront/sessions/initial/canvas?demo=agents")
      const skip = page.getByRole("button", { name: "Skip for now" })
      if (await skip.query()) await skip.click()
      await expect.element(terminal("Checkout review")).toBeVisible()
      // To docs-site's Grid, leaving storefront's Canvas with its camera.
      window.location.hash = "#/projects/docs-site/sessions/initial/grid"
      await expect.element(view("Grid")).toBeChecked()
      await sidebarPanel("Inbox").click()
      await page.getByRole("button", { name: /Run pnpm test/ }).click()

      await page
        .getByRole("dialog", { name: "Checkout review" })
        .getByRole("button", { name: "Show terminal" })
        .click()

      await expect.element(view("Canvas")).toBeChecked()
      await expect.poll(() => fillsView(boxOf(terminal("Checkout review")))).toBe(true)
      // A visit, as a header's double-click makes, which a plain fit would not: it goes back.
      await doubleClickHeader("Checkout review")
      await expect.poll(() => fillsView(boxOf(terminal("Checkout review")))).toBe(false)
    })

    it("frames every window when Canvas opens from another view later, flying no more", async () => {
      await openWorkspace("/?demo=agents")
      const skip = page.getByRole("button", { name: "Skip for now" })
      if (await skip.query()) await skip.click()
      await chooseView("Canvas")
      await sidebarPanel("Inbox").click()
      await page.getByRole("button", { name: /Run pnpm test/ }).click()
      await page
        .getByRole("dialog", { name: "Checkout review" })
        .getByRole("button", { name: "Show terminal" })
        .click()
      await expect.poll(() => fillsView(boxOf(terminal("Checkout review")))).toBe(true)

      await chooseView("Grid")
      await chooseView("Canvas")

      await expect.poll(() => fillsView(boxOf(terminal("Checkout review")))).toBe(false)
      await expect.poll(() => insideView(boxOf(terminal("Checkout implementation")))).toBe(true)
    })
  })

  context("when resizing a terminal by its corner", () => {
    it("offers no other resize control in its header", async () => {
      await openCanvas()

      await expect
        .element(
          terminal("Checkout implementation").getByRole("button", {
            name: /Enlarge|compact|width/,
          }),
        )
        .not.toBeInTheDocument()
    })

    it("keeps a new terminal's size when a corner is only pressed", async () => {
      await openCanvas()
      // Off Canvas's grid, as the demo's windows are, so a size taken from a press would show.
      await dragCorner("Checkout implementation", { x: 0, y: 0 })

      await page.getByRole("button", { name: "New terminal", exact: true }).click()

      await expect.element(terminal(newTerminalName)).toBeVisible()
      const created = await settled(() => boxOf(terminal(newTerminalName)))
      expect(near(ratio(created), 3 / 2, 0.05)).toBe(true)
    })

    it("opens the next new terminal at the size it was given", async () => {
      await openCanvas()
      const resized = await resizeCheckout()

      await page.getByRole("button", { name: "New terminal", exact: true }).click()

      await expect.element(terminal(newTerminalName)).toBeVisible()
      const created = await settled(() => boxOf(terminal(newTerminalName)))
      expect(sameSize(created, resized)).toBe(true)
    })
  })

  context("when creating a terminal with New terminal", () => {
    it("places it inside the view without changing zoom", async () => {
      await openCanvas()
      const before = boxesOf(names)

      await page.getByRole("button", { name: "New terminal", exact: true }).click()

      await expect.element(terminal(newTerminalName)).toBeVisible()
      // The camera may pan a moment later to reveal it; wait for what the person ends up seeing.
      await expect.poll(() => insideView(boxOf(terminal(newTerminalName)))).toBe(true)
      const after = await settled(() => boxesOf(names))
      for (const name of names) {
        expect(near(after[name]!.width, before[name]!.width)).toBe(true)
        expect(near(after[name]!.height, before[name]!.height)).toBe(true)
      }
    })
  })

  context("when a terminal is added in another view", () => {
    it("opens it in Canvas at a new terminal's 3:2, whatever the view's shape", async () => {
      // A tall window gives the view a portrait shape, far from a new terminal's 3:2.
      await page.viewport(1440, 1600)
      onTestFinished(() => page.viewport(1440, 900))
      await openWorkspace()
      await chooseView("Grid")
      await page.getByRole("button", { name: "New terminal" }).click()
      await expect.element(terminal(newTerminalName)).toBeVisible()

      await chooseView("Canvas")

      const created = await settled(() => boxOf(terminal(newTerminalName)))
      expect(near(ratio(created), 3 / 2, 0.05)).toBe(true)
    })

    it("opens it in Canvas at the size a terminal was last given there", async () => {
      await openCanvas()
      await resizeCheckout()
      await chooseView("Grid")
      await page.getByRole("button", { name: "New terminal" }).click()
      await expect.element(terminal(newTerminalName)).toBeVisible()

      await chooseView("Canvas")

      const boxes = await settled(() => boxesOf(["Checkout implementation", newTerminalName]))
      expect(sameSize(boxes[newTerminalName]!, boxes["Checkout implementation"]!)).toBe(true)
    })
  })

  context("when choosing Terminal from the background context menu", () => {
    it("places the new terminal's top-left corner at the clicked point without moving the camera", async () => {
      await openCanvas()
      const before = boxesOf(names)
      await rightClickBackground({ x: 100, y: 120 })

      await canvasMenu().getByRole("menuitem", { name: "Terminal" }).click()

      await expect.element(terminal(newTerminalName)).toBeVisible()
      await expectSelected(newTerminalName)
      await expect.element(canvasMenu()).not.toBeInTheDocument()
      const created = await settled(() => boxOf(terminal(newTerminalName)))
      // The corner lands on the canvas grid, so allow for snapping.
      expect(near(created.left, 100, 13) && near(created.top, 120, 13)).toBe(true)
      for (const name of names) expect(sameBox(boxOf(terminal(name)), before[name]!)).toBe(true)
    })

    it("opens it at the size a terminal was last given", async () => {
      await openCanvas()
      const resized = await resizeCheckout()
      await rightClickBackground({ x: 100, y: 120 })

      await canvasMenu().getByRole("menuitem", { name: "Terminal" }).click()

      await expect.element(terminal(newTerminalName)).toBeVisible()
      const created = await settled(() => boxOf(terminal(newTerminalName)))
      expect(sameSize(created, resized)).toBe(true)
    })

    it("focuses the new terminal instead of renaming it", async () => {
      await openCanvas()
      await rightClickBackground({ x: 100, y: 120 })

      await canvasMenu().getByRole("menuitem", { name: "Terminal" }).click()

      await expect.element(terminalTab(newTerminalName)).toBeVisible()
      await expectStaysAbsent(
        page.getByRole("textbox", { name: labelled("Rename ", newTerminalName) }),
      )
      await expect.element(commandInput(newTerminalName)).toHaveFocus()
    })
  })

  context("when right-clicking a terminal", () => {
    it("does not offer the canvas actions", async () => {
      await openCanvas()
      await rightClickBackground({ x: 100, y: 120 })
      await escapeFrom(canvasMenu())
      await expect.element(canvasMenu()).not.toBeInTheDocument()

      await terminal("Checkout implementation").click({
        button: "right",
        position: { x: 150, y: 150 },
      })

      await expectStaysAbsent(canvasMenu())
    })
  })

  context("when pressing Up or Down with a modifier on the canvas", () => {
    it("neither pans the canvas nor moves the active terminal", async () => {
      await openCanvas()
      await terminal("Checkout implementation").click({ position: { x: 150, y: 150 } })
      await expectSelected("Checkout implementation")
      const before = boxesOf(names)

      await press("{Shift>}{ArrowUp}{ArrowDown}{/Shift}")
      await clickBackground({ x: 150, y: 100 })
      await press("{Shift>}{ArrowUp}{ArrowDown}{/Shift}")
      await press("{Control>}{ArrowLeft}{ArrowRight}{ArrowUp}{ArrowDown}{/Control}")
      await press("{Alt>}{ArrowLeft}{ArrowRight}{ArrowUp}{ArrowDown}{/Alt}")

      const after = await settled(() => boxesOf(names))
      for (const name of names) expect(sameBox(after[name]!, before[name]!)).toBe(true)
    })
  })

  context("when pressing an arrow key on the canvas", () => {
    // Demo layout, left to right: Checkout implementation, Dev server, Tests above;
    // Checkout review, Runtime, Build below, each a little lower than the one above.
    const picks: [string, string, string][] = [
      ["Checkout implementation", "{ArrowRight}", "Dev server"],
      ["Checkout implementation", "{ArrowDown}", "Checkout review"],
      ["Runtime", "{ArrowUp}", "Dev server"],
      ["Runtime", "{ArrowLeft}", "Checkout review"],
    ]

    for (const [from, key, to] of picks) {
      it(`selects the terminal on that side: ${key} from ${from} reaches ${to}`, async () => {
        await openCanvas()
        await terminal(from).click({ position: { x: 150, y: 150 } })
        await expectSelected(from)
        await enterNavigateMode()
        const start = boxOf(terminal(from))
        const target = boxOf(terminal(to))
        const horizontal = key === "{ArrowRight}" || key === "{ArrowLeft}"
        const sign = key === "{ArrowRight}" || key === "{ArrowDown}" ? 1 : -1
        expect(
          (horizontal ? target.centerX - start.centerX : target.centerY - start.centerY) * sign,
        ).toBeGreaterThan(0)

        await press(key)

        await expectSelected(to)
      })
    }

    it("does nothing outside navigate mode", async () => {
      await openCanvas()
      await terminal("Checkout implementation").click({ position: { x: 150, y: 150 } })
      await expectSelected("Checkout implementation")
      await focusStage()
      const before = boxesOf(names)

      await press("{ArrowRight}{ArrowDown}")

      await expectSelected("Checkout implementation")
      const after = await settled(() => boxesOf(names))
      for (const name of names) expect(sameBox(after[name]!, before[name]!)).toBe(true)
    })

    it("does nothing when no terminal lies on that side", async () => {
      await openCanvas()
      await terminal("Checkout implementation").click({ position: { x: 150, y: 150 } })
      await expectSelected("Checkout implementation")
      await enterNavigateMode()
      await press("{ArrowLeft}")
      await expectSelected("Checkout implementation")

      await terminal("Dev server").click({ position: { x: 150, y: 150 } })
      await expectSelected("Dev server")
      await enterNavigateMode()
      await press("{ArrowUp}")

      await expect.element(terminalTab("Dev server")).toHaveAttribute("aria-current", "true")
    })
  })

  context("when selecting an off-screen terminal", () => {
    it("pans to reveal it when chosen from its sidebar tab, keeping the zoom", async () => {
      await openCanvas()
      await pushTestsOffScreen("Checkout implementation")
      const before = boxOf(terminal("Tests"))

      await terminalTab("Tests").click()

      await expectSelected("Tests")
      await expect.poll(() => insideView(boxOf(terminal("Tests")))).toBe(true)
      const after = await settled(() => boxOf(terminal("Tests")))
      expect(near(after.width, before.width) && near(after.height, before.height)).toBe(true)
    })

    it("pans to reveal it when reached with Right", async () => {
      await openCanvas()
      await pushTestsOffScreen("Dev server")
      await terminal("Dev server").click({ position: { x: 150, y: 150 } })
      await expectSelected("Dev server")
      expect(insideView(await settled(() => boxOf(terminal("Tests"))))).toBe(false)
      await enterNavigateMode()

      await press("{ArrowRight}")

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
    it("flies to the terminal again after opening it in Focus and back in Canvas", async () => {
      await openCanvas()
      await doubleClickHeader("Checkout implementation")
      expect(await flownTo("Checkout implementation")).toBe(true)
      await terminal("Checkout implementation")
        .getByRole("button", { name: labelled("Focus ", "Checkout implementation") })
        .click()
      await expect.element(view("Focus")).toBeChecked()

      await page.getByRole("button", { name: "Open in Canvas" }).click()
      await expect.element(view("Canvas")).toBeChecked()
      const back = await settled(() => boxOf(terminal("Checkout implementation")))
      expect(fillsView(back)).toBe(false)

      await doubleClickHeader("Checkout implementation")
      expect(await flownTo("Checkout implementation")).toBe(true)
      await doubleClickHeader("Checkout implementation")
      const returned = await settled(() => boxOf(terminal("Checkout implementation")))
      expect(sameBox(returned, back)).toBe(true)
    })

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
        .getByRole("button", { name: labelled("Focus ", "Checkout review") })
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

      await expect.element(terminal(newTerminalName)).toBeVisible()
      const after = await settled(() => boxesOf([...names, newTerminalName]))
      const created = after[newTerminalName]!
      expect(insideView(created)).toBe(true)
      for (const name of names) {
        expect(sameBox(after[name]!, before[name]!)).toBe(true)
        expect(overlaps(asRect(created), asRect(after[name]!))).toBe(false)
      }
    })
  })
})

describe("Canvas's team wire", () => {
  const wire = () => document.querySelectorAll(".canvas-team-wire-tick").length
  const wireOpacity = () =>
    Number(getComputedStyle(document.querySelector(".canvas-team-wire")!).opacity)
  const opacityOf = (name: string) =>
    Number(getComputedStyle(terminal(name).element().closest(".canvas-node")!).opacity)

  it("joins the lead and its worker, who stay as bright as the selection, while one of the team is selected", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout review").click()
    await chooseView("Canvas")
    await expect.poll(wire).toBe(1)
    expect(document.querySelectorAll(".canvas-team-wire-cursor")).toHaveLength(1)
    // The wire is only drawn, and sits beneath the windows.
    const drawn = document.querySelector(".canvas-team-wire")!
    expect(getComputedStyle(drawn).pointerEvents).toBe("none")
    expect(drawn.getAttribute("aria-hidden")).toBe("true")
    const node = terminal("Checkout review").element().closest<HTMLElement>(".react-flow__node")!
    expect(Number(getComputedStyle(drawn).zIndex)).toBeLessThan(0)
    expect(Number(getComputedStyle(node).zIndex)).toBeGreaterThanOrEqual(0)
    await expect.poll(() => opacityOf("Checkout implementation")).toBe(1)
    await expect.poll(() => opacityOf("Checkout review")).toBe(1)
    // Terminals outside the team still recede.
    await expect.poll(() => opacityOf("Dev server")).toBeLessThan(1)
  })

  it("stays, receded with its windows, while a terminal in no team is selected", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout review").click()
    await chooseView("Canvas")
    await expect.poll(wire).toBe(1)
    await expect.poll(() => wireOpacity()).toBe(1)
    await terminalTab("Dev server").click()
    await expect.poll(() => opacityOf("Checkout implementation")).toBeLessThan(1)
    await expect.poll(() => wireOpacity()).toBeLessThan(1)
    expect(wire()).toBe(1)
    expect(document.querySelectorAll(".canvas-team-wire-cursor")).toHaveLength(1)
    // Still beneath the windows.
    const node = terminal("Dev server").element().closest<HTMLElement>(".react-flow__node")!
    expect(
      Number(getComputedStyle(document.querySelector(".canvas-team-wire")!).zIndex),
    ).toBeLessThan(0)
    expect(Number(getComputedStyle(node).zIndex)).toBeGreaterThanOrEqual(0)
  })

  it("plays its pulse once for each selection into the team, and again on coming back to it", async () => {
    const pulsing = () => document.querySelector(".canvas-team-wire[data-pulsing]") !== null
    await openMessagesDemo()
    await terminalTab("Checkout review").click()
    await chooseView("Canvas")
    await expect.poll(pulsing).toBe(true)
    // It is over once played, and stays over while the selection stays.
    await expect.poll(pulsing, { timeout: 4000 }).toBe(false)
    await expectStaysAbsent({ shown: pulsing, name: "the pulse" }, { ms: 1500 })
    await terminalTab("Dev server").click()
    await terminalTab("Checkout review").click()
    await expect.poll(pulsing).toBe(true)
  })

  it("is drawn from the start, without any team selected", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    await chooseView("Canvas")
    await expect.poll(wire).toBe(1)
  })
})
