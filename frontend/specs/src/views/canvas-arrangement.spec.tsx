import { page, userEvent, type Locator } from "vitest/browser"

import {
  boxesOf,
  boxOf,
  dragHeader,
  near,
  rightClickBackground,
  sameBox,
  settled,
  type Box,
} from "../support/canvas"
import { newTerminalName } from "../support/keyboard"
import { overlaps } from "../support/layouts"
import { openMessagesDemo } from "../support/messages"
import {
  confirmClose,
  headerAction,
  hiddenTerminalTab,
  visibilityToggle,
} from "../support/terminals"
import {
  chooseView,
  expectSelected,
  expectStaysAbsent,
  labelled,
  openWorkspace,
  terminal,
  terminalTab,
  terminalTabNames,
  view,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// Canvas arranges its windows itself, from the sidebar's order and who leads whom. These
// specs say what a person sees of that: where windows are, what moves when one opens or
// closes, and what a drag leaves behind. Places are read off the screen, relative to each
// other, so they hold whatever zoom Canvas framed everything at.

const storefront = [
  "Checkout implementation",
  "Dev server",
  "Tests",
  "Checkout review",
  "Runtime",
  "Build",
]

const asRect = (box: Box): DOMRect => new DOMRect(box.left, box.top, box.width, box.height)

const openCanvas = async (names: string[] = storefront): Promise<void> => {
  await chooseView("Canvas")
  await expect.element(terminal(names[0]!)).toBeVisible()
  await settled(() => boxesOf(names))
}

/** Where each window is, measured from `from`'s top left, so a camera that moves does not show. */
const placesFrom = (names: string[], from: string): Record<string, { x: number; y: number }> => {
  const origin = boxOf(terminal(from))
  return Object.fromEntries(
    names.map((name) => {
      const box = boxOf(terminal(name))
      return [name, { x: box.left - origin.left, y: box.top - origin.top }]
    }),
  )
}

const samePlaces = (
  actual: Record<string, { x: number; y: number }>,
  expected: Record<string, { x: number; y: number }>,
): boolean =>
  Object.entries(expected).every(
    ([name, place]) => near(actual[name]!.x, place.x) && near(actual[name]!.y, place.y),
  )

/**
 * `next` follows `previous` in a block's reading order: beside it, or at the block's left
 * edge in the row below. The block fills from its end, so only its first row can be short.
 */
const followsInBlock = (previous: Box, next: Box, block: readonly Box[]): boolean =>
  (near(next.top, previous.top) && next.left > previous.left + previous.width) ||
  (next.top > previous.top + previous.height &&
    near(next.left, Math.min(...block.map((box) => box.left))))

/**
 * Drags a tab by pointer onto the top quarter of another tab, clearly past the
 * destination's leading edge. Interpolated moves let the list follow the drag.
 */
const dragTabOnto = async (source: string, destination: string): Promise<void> => {
  const target = terminalTab(destination)
  const { width, height } = target.element().getBoundingClientRect()
  await userEvent.dragAndDrop(terminalTab(source), target, {
    targetPosition: { x: width / 2, y: height / 4 },
    steps: 20,
  })
}

const focusButton = (name: string): Locator =>
  terminal(name).getByRole("button", { name: labelled("Focus ", name) })

describe("Canvas's arrangement", () => {
  context("when opened over windows on no team and one team", () => {
    // The messages demo: Checkout implementation leads Checkout review; the rest lead no one.
    const alone = ["Dev server", "Tests", "Runtime", "Build"]
    const team = ["Checkout implementation", "Checkout review"]

    it("puts the windows on no team in a block, in the sidebar's order", async () => {
      await openMessagesDemo()
      await openCanvas([...alone, ...team])

      const inOrder = terminalTabNames().filter((name) => alone.includes(name))
      expect(inOrder.toSorted()).toEqual(alone.toSorted())
      const boxes = boxesOf(inOrder)
      inOrder.slice(1).forEach((name, n) => {
        expect(
          followsInBlock(boxes[inOrder[n]!]!, boxes[name]!, Object.values(boxes)),
          `${name} follows ${inOrder[n]} in the block`,
        ).toBe(true)
      })
    })

    it("sets a team apart as an island, its lead left of its teammate", async () => {
      await openMessagesDemo()
      await openCanvas([...alone, ...team])

      const lead = boxOf(terminal("Checkout implementation"))
      const teammate = boxOf(terminal("Checkout review"))
      expect(near(teammate.top, lead.top)).toBe(true)
      expect(teammate.left).toBeGreaterThan(lead.left + lead.width)
      for (const name of alone) {
        const box = boxOf(terminal(name))
        expect(overlaps(asRect(box), asRect(lead))).toBe(false)
        expect(overlaps(asRect(box), asRect(teammate))).toBe(false)
      }
    })
  })

  context("when a terminal is opened while Canvas is open", () => {
    it("goes first in the sidebar and first in the block, and no other window moves", async () => {
      await openWorkspace()
      await openCanvas()
      const before = placesFrom(storefront, "Checkout implementation")

      await page.getByRole("button", { name: "New terminal", exact: true }).click()

      await expect.element(terminal(newTerminalName)).toBeVisible()
      await expectSelected(newTerminalName)
      expect(terminalTabNames()[0]).toBe(newTerminalName)
      const after = await settled(() => placesFrom(storefront, "Checkout implementation"))
      expect(samePlaces(after, before)).toBe(true)
      const boxes = await settled(() => boxesOf([newTerminalName, ...storefront]))
      expect(
        followsInBlock(
          boxes[newTerminalName]!,
          boxes["Checkout implementation"]!,
          Object.values(boxes),
        ),
      ).toBe(true)
    })

    it("is still first in the block the next time Canvas opens", async () => {
      await openWorkspace()
      await openCanvas()
      await page.getByRole("button", { name: "New terminal", exact: true }).click()
      await expect.element(terminal(newTerminalName)).toBeVisible()

      await chooseView("Grid")
      await chooseView("Canvas")

      const boxes = await settled(() => boxesOf([newTerminalName, ...storefront]))
      expect(
        followsInBlock(
          boxes[newTerminalName]!,
          boxes["Checkout implementation"]!,
          Object.values(boxes),
        ),
      ).toBe(true)
    })
  })

  context("when a terminal is closed while Canvas is open", () => {
    it("leaves every other window where it was", async () => {
      await openWorkspace()
      await openCanvas()
      const others = storefront.filter((name) => name !== "Tests")
      const before = placesFrom(others, "Checkout implementation")

      await headerAction("Tests", "Close Tests").click()
      await confirmClose()

      await expect.element(terminal("Tests")).not.toBeInTheDocument()
      const after = await settled(() => placesFrom(others, "Checkout implementation"))
      expect(samePlaces(after, before)).toBe(true)
    })
  })

  context("when a window is dragged by its header", () => {
    it("is back in its arranged place after leaving Canvas by the view switch and returning", async () => {
      await openWorkspace()
      await openCanvas()
      await expectSelected("Checkout implementation")
      const arranged = await settled(() => boxesOf(storefront))

      await dragHeader("Checkout implementation", { x: -96, y: 120 })

      const dragged = await settled(() => boxOf(terminal("Checkout implementation")))
      expect(sameBox(dragged, arranged["Checkout implementation"]!, 20)).toBe(false)
      await chooseView("Grid")
      await chooseView("Canvas")

      await expect.element(terminal("Checkout implementation")).toBeVisible()
      const back = await settled(() => boxesOf(storefront))
      for (const name of storefront) expect(sameBox(back[name]!, arranged[name]!)).toBe(true)
    })

    it("is where it was left, with the same camera, after Focus by its header button and back", async () => {
      await openWorkspace()
      await openCanvas()
      await expectSelected("Checkout implementation")
      const arranged = await settled(() => boxesOf(storefront))
      await dragHeader("Checkout implementation", { x: -96, y: 120 })
      const before = await settled(() => boxesOf(storefront))
      expect(
        sameBox(before["Checkout implementation"]!, arranged["Checkout implementation"]!, 20),
      ).toBe(false)

      await focusButton("Checkout implementation").click()
      await expect.element(view("Focus")).toBeChecked()
      await page.getByRole("button", { name: "Open in Canvas" }).click()

      await expect.element(view("Canvas")).toBeChecked()
      const after = await settled(() => boxesOf(storefront))
      for (const name of storefront) expect(sameBox(after[name]!, before[name]!)).toBe(true)
    })
  })

  context("when two tabs are reordered in the sidebar while Canvas is open", () => {
    it("swaps their windows, the others and the camera staying", async () => {
      await openWorkspace()
      await openCanvas()
      const before = await settled(() => boxesOf(storefront))
      expect(terminalTabNames().slice(0, 2)).toEqual(["Checkout implementation", "Dev server"])

      await dragTabOnto("Dev server", "Checkout implementation")
      await expect
        .poll(() => terminalTabNames().slice(0, 2))
        .toEqual(["Dev server", "Checkout implementation"])

      await expect
        .poll(() => {
          const now = boxesOf(storefront)
          return (
            sameBox(now["Dev server"]!, before["Checkout implementation"]!) &&
            sameBox(now["Checkout implementation"]!, before["Dev server"]!)
          )
        })
        .toBe(true)
      const after = await settled(() => boxesOf(storefront))
      for (const name of storefront.slice(2))
        expect(sameBox(after[name]!, before[name]!)).toBe(true)
    })
  })

  context("when a hidden terminal is looked at from the sidebar", () => {
    it("shows it without moving any other window, then or afterwards", async () => {
      await openWorkspace()
      await visibilityToggle("Tests", "Hide").click()
      const rest = storefront.filter((name) => name !== "Tests")
      await openCanvas(rest)
      const before = placesFrom(rest, "Checkout implementation")

      await hiddenTerminalTab("Tests").click()
      await expect.element(terminal("Tests")).toBeVisible()
      const during = await settled(() => placesFrom(rest, "Checkout implementation"))
      expect(samePlaces(during, before)).toBe(true)
      // It shows where it would go, first in the block, over no other window.
      const shown = boxOf(terminal("Tests"))
      for (const name of rest)
        expect(overlaps(asRect(shown), asRect(boxOf(terminal(name))))).toBe(false)

      await terminalTab("Dev server").click()
      await expectSelected("Dev server")
      const after = await settled(() => placesFrom(rest, "Checkout implementation"))
      expect(samePlaces(after, before)).toBe(true)
    })
  })

  context("when a hidden lead is looked at from the sidebar", () => {
    it("leaves its team where it is", async () => {
      // The messages demo: Checkout implementation leads Checkout review.
      await openMessagesDemo()
      await visibilityToggle("Checkout implementation", "Hide").click()
      const rest = storefront.filter((name) => name !== "Checkout implementation")
      await openCanvas(rest)
      const before = placesFrom(rest, "Dev server")

      await hiddenTerminalTab("Checkout implementation").click()
      await expect.element(terminal("Checkout implementation")).toBeVisible()

      const during = await settled(() => placesFrom(rest, "Dev server"))
      expect(samePlaces(during, before)).toBe(true)
    })
  })

  context("when looking for ways to rearrange the windows by hand", () => {
    it("offers no resize corner, and gives every window the same size", async () => {
      await openWorkspace()
      await openCanvas()

      expect(
        document.querySelector(".terminal-resize-grip, .react-flow__resize-control"),
      ).toBeNull()
      const boxes = await settled(() => boxesOf(storefront))
      const first = boxes["Checkout implementation"]!
      for (const name of storefront) {
        expect(near(boxes[name]!.width, first.width)).toBe(true)
        expect(near(boxes[name]!.height, first.height)).toBe(true)
      }
      expect(near(first.width / first.height, 864 / 576, 0.01)).toBe(true)
    })

    it("offers no context menu on the empty canvas", async () => {
      await openWorkspace()
      await openCanvas()

      await rightClickBackground({ x: 100, y: 120 })

      await expectStaysAbsent(page.getByRole("menu"))
    })
  })
})
