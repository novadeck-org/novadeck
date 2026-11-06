import { onTestFinished } from "vitest"
import { page, type Locator } from "vitest/browser"

import {
  boxesOf,
  boxOf,
  clickBackground,
  doubleClickHeader,
  dragBackground,
  dragBy,
  dragHeader,
  fillsView,
  insideView,
  near,
  sameBox,
  scrollCanvas,
  scrollOver,
  settled,
  terminalAt,
  viewBox,
  type Box,
} from "../support/canvas"
import { newTerminalName } from "../support/keyboard"
import { openMessagesDemo } from "../support/messages"
import {
  chooseView,
  enterNavigateMode,
  expectSelected,
  focusStage,
  labelled,
  openWorkspace,
  press,
  sidebarPanel,
  terminal,
  terminalTab,
  view,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

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

// A flown-to window fills the view but for a strip along its top: the only bare Canvas there.
const bareStrip = { x: 600, y: 4 }

const flownTo = (name: string): Promise<boolean> =>
  settled(() => boxOf(terminal(name))).then(fillsView)

const focusButton = (name: string): Locator =>
  terminal(name).getByRole("button", { name: labelled("Focus ", name) })

/** Opens `name` in Focus from its header and comes back with Open in Canvas, to the same camera. */
const expectRoundTripKeepsCamera = async (name: string): Promise<void> => {
  const before = await settled(() => boxesOf(names))
  await focusButton(name).click()
  await expect.element(view("Focus")).toBeChecked()
  await page.getByRole("button", { name: "Open in Canvas" }).click()

  await expect.element(view("Canvas")).toBeChecked()
  const after = await settled(() => boxesOf(names))
  for (const each of names) expect(sameBox(after[each]!, before[each]!)).toBe(true)
}

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

      await dragHeader("Checkout implementation", { x: -96, y: 120 })

      const after = await settled(() => boxesOf(names))
      const moved = after["Checkout implementation"]!
      const origin = before["Checkout implementation"]!
      // The terminal lands on the canvas grid, so allow for snapping and drag slop.
      expect(near(moved.left, origin.left - 96, 20)).toBe(true)
      expect(near(moved.top, origin.top + 120, 20)).toBe(true)
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
      await dragBackground(bareStrip, { x: 150, y: 40 })
      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(false)

      await doubleClickHeader("Checkout implementation")

      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(true)
    })

    it("flies to the terminal again after zooming with the keyboard instead of returning", async () => {
      await openCanvas()
      await doubleClickHeader("Checkout implementation")
      await expect.poll(() => fillsView(boxOf(terminal("Checkout implementation")))).toBe(true)
      await clickBackground(bareStrip)
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

      await doubleClickHeader("Tests")
      await expect.poll(() => fillsView(boxOf(terminal("Tests")))).toBe(true)
      await doubleClickHeader("Tests")

      await expect
        .poll(() => sameBox(boxOf(terminal("Checkout implementation")), visited))
        .toBe(true)
    })
  })

  context("when going to a terminal from its Inbox row", () => {
    it("flies the camera in to it, as a double-click on its header does", async () => {
      await openWorkspace("/?demo=agents")
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

    it("flies in from the framing of its windows, when the row is from another session", async () => {
      await openWorkspace("/projects/storefront/sessions/initial/canvas?demo=agents")
      await expect.element(terminal("Checkout review")).toBeVisible()
      // To docs-site's Grid, leaving storefront's Canvas.
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
    // The demo's six windows are a block of two columns, in the sidebar's order, across:
    // Checkout implementation, Dev server; Tests, Checkout review; Runtime, Build.
    const picks: [string, string, string][] = [
      ["Checkout implementation", "{ArrowRight}", "Dev server"],
      ["Checkout implementation", "{ArrowDown}", "Tests"],
      ["Runtime", "{ArrowUp}", "Tests"],
      ["Runtime", "{ArrowRight}", "Build"],
      ["Checkout review", "{ArrowLeft}", "Tests"],
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

    it("pans to reveal it when reached with Down", async () => {
      await openCanvas()
      await pushTestsOffScreen("Checkout implementation")
      await terminal("Checkout implementation").click({ position: { x: 150, y: 150 } })
      await expectSelected("Checkout implementation")
      expect(insideView(await settled(() => boxOf(terminal("Tests"))))).toBe(false)
      await enterNavigateMode()

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
          await clickBackground(bareStrip)
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

    it("comes back to the camera it left with Open in Canvas", async () => {
      await openCanvas()
      await dragBackground({ x: 150, y: 100 }, { x: 120, y: 60 })
      await settled(() => boxesOf(names))
      expect(insideView(boxOf(focusButton("Checkout review")))).toBe(true)

      await expectRoundTripKeepsCamera("Checkout review")
    })

    it("comes back to that camera with the terminal hanging off the left edge", async () => {
      await openCanvas()
      const { left, width } = boxOf(terminal("Checkout implementation"))
      // From the bare Canvas right of the block, the windows' framing leaves room beside it.
      await dragBackground(
        { x: viewBox().width - 20, y: 100 },
        { x: -Math.round(left + width * 0.7), y: 0 },
      )
      await settled(() => boxesOf(names))
      expect(boxOf(terminal("Checkout implementation")).left).toBeLessThan(-width / 2)

      await expectRoundTripKeepsCamera("Checkout implementation")
    })

    it("comes back to that camera with the terminal's end past the right edge", async () => {
      await openCanvas()
      const { left, width } = boxOf(terminal("Dev server"))
      await dragBackground(
        { x: 20, y: 100 },
        { x: Math.round(viewBox().width + 20 - left - width), y: 0 },
      )
      await settled(() => boxesOf(names))
      const devServer = boxOf(terminal("Dev server"))
      expect(devServer.left + devServer.width).toBeGreaterThan(viewBox().width)
      expect(insideView(boxOf(focusButton("Dev server")))).toBe(true)

      await expectRoundTripKeepsCamera("Dev server")
    })

    it("reveals a terminal out of sight that Focus moved to", async () => {
      await openCanvas()
      await pushTestsOffScreen("Checkout implementation")
      // Zoomed in further, until Tests' Focus button is below the view.
      for (
        let steps = 0;
        steps < 6 && boxOf(focusButton("Tests")).top <= viewBox().height;
        steps++
      ) {
        // eslint-disable-next-line no-await-in-loop -- One zoom step after another.
        await scrollOver(
          terminal("Checkout implementation").getByRole("heading", {
            name: "Checkout implementation",
          }),
          -300,
        )
        // eslint-disable-next-line no-await-in-loop -- The camera settles before the next.
        await settled(() => boxesOf(names))
      }
      expect(boxOf(focusButton("Tests")).top).toBeGreaterThan(viewBox().height)
      await focusButton("Checkout implementation").click()
      await expect.element(view("Focus")).toBeChecked()
      await terminalTab("Tests").click()
      await expectSelected("Tests")

      await page.getByRole("button", { name: "Open in Canvas" }).click()

      await expect.element(view("Canvas")).toBeChecked()
      // Zoomed in past the view's size, it comes back in the middle rather than inside.
      await expect
        .poll(() => {
          const { centerX, centerY } = boxOf(terminal("Tests"))
          return near(centerX, viewBox().centerX, 3) && near(centerY, viewBox().centerY, 3)
        })
        .toBe(true)
    })
  })
})

describe("Canvas's team wire", () => {
  const wire = () => document.querySelectorAll(".canvas-team-wire-tick").length
  const wireOpacity = () =>
    Number(getComputedStyle(document.querySelector(".canvas-team-wire")!).opacity)
  // How faded the window shows: its fade sits on what it holds, under its node.
  const opacityOf = (name: string) => {
    let shown = 1
    for (
      let each: Element | null = terminal(name).element();
      each && !each.matches(".react-flow__node");
      each = each.parentElement
    )
      shown *= Number(getComputedStyle(each).opacity)
    return shown
  }
  const lit = () => document.querySelectorAll(".canvas-team-wire-shape[data-lit]").length

  it("joins the lead and its worker, who stay as bright as the selection, while one of the team is selected", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout review").click()
    await chooseView("Canvas")
    await expect.poll(wire).toBe(1)
    expect(document.querySelectorAll(".canvas-team-wire-cursor")).toHaveLength(1)
    expect(lit()).toBe(1)
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

  it("stays, at rest and receded with its windows, while a terminal in no team is selected", async () => {
    await openMessagesDemo()
    await terminalTab("Checkout review").click()
    await chooseView("Canvas")
    await expect.poll(wire).toBe(1)
    await expect.poll(() => wireOpacity()).toBe(1)
    await terminalTab("Dev server").click()
    await expect.poll(() => opacityOf("Checkout implementation")).toBeLessThan(1)
    await expect.poll(() => wireOpacity()).toBeLessThan(1)
    expect(wire()).toBe(1)
    expect(lit()).toBe(0)
    expect(document.querySelectorAll(".canvas-team-wire-cursor")).toHaveLength(1)
    // Still beneath the windows.
    const node = terminal("Dev server").element().closest<HTMLElement>(".react-flow__node")!
    expect(
      Number(getComputedStyle(document.querySelector(".canvas-team-wire")!).zIndex),
    ).toBeLessThan(0)
    expect(Number(getComputedStyle(node).zIndex)).toBeGreaterThanOrEqual(0)
  })

  it("lights while one of the team is selected, its cursor drawn anew for each member selected", async () => {
    const cursor = () =>
      document.querySelector(".canvas-team-wire-shape[data-lit] .canvas-team-wire-cursor")
    await openMessagesDemo()
    await terminalTab("Checkout review").click()
    await chooseView("Canvas")
    await expect.poll(lit).toBe(1)
    const first = cursor()
    expect(first).not.toBeNull()
    // Another member of the same team: still lit, and its cursor blinks again.
    await terminalTab("Checkout implementation").click()
    await expect.poll(cursor).not.toBe(first)
    expect(lit()).toBe(1)
    await terminalTab("Dev server").click()
    await expect.poll(lit).toBe(0)
  })

  it("is drawn from the start, at rest, without any team selected", async () => {
    await openMessagesDemo()
    await terminalTab("Dev server").click()
    await chooseView("Canvas")
    await expect.poll(wire).toBe(1)
    expect(lit()).toBe(0)
  })

  it("tints the selected terminal's teammates' windows, as their tabs, its lead's too", async () => {
    const tinted = (name: string) =>
      getComputedStyle(terminal(name).element(), "::after").backgroundColor !== "rgba(0, 0, 0, 0)"
    const outline = (name: string) => getComputedStyle(terminal(name).element()).borderTopColor
    await openMessagesDemo()
    await terminalTab("Checkout implementation").click()
    await chooseView("Canvas")
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
})
