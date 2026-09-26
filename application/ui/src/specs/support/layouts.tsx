import { expect } from "vitest"
import { page, type Locator } from "vitest/browser"

import { terminal } from "./workspace"

// Geometry vocabulary for Focus and Grid specs. Rendered rectangles are compared
// with each other rather than with fixed pixel values, so specs survive changes to
// spacing or breakpoints that keep the same visible arrangement.

export const focusView = (): Locator => page.getByRole("region", { name: "focus view" })

export const gridView = (): Locator => page.getByRole("region", { name: "grid view" })

export const bounds = (locator: Locator): DOMRect => locator.element().getBoundingClientRect()

/** Whether `inner` lies entirely inside `outer`, allowing a pixel of rounding. */
export const isInside = (inner: DOMRect, outer: DOMRect): boolean =>
  inner.top >= outer.top - 1 &&
  inner.bottom <= outer.bottom + 1 &&
  inner.left >= outer.left - 1 &&
  inner.right <= outer.right + 1

export const overlaps = (a: DOMRect, b: DOMRect): boolean =>
  a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1

/** Whether a terminal is fully shown inside the Grid's visible area. */
export const isShownInGrid = (name: string): boolean =>
  isInside(bounds(terminal(name)), bounds(gridView()))

/**
 * A point on a terminal's header between its name and its first header action,
 * relative to the terminal, for gestures "outside the name".
 */
export const headerGap = (name: string): { x: number; y: number } => {
  const region = terminal(name)
  const box = bounds(region)
  const heading = bounds(region.getByRole("heading", { name, exact: true }))
  const actions = region
    .getByRole("button")
    .elements()
    .map((button) => button.getBoundingClientRect())
    .filter((button) => button.left > heading.right && button.top < heading.bottom)
  const end = Math.min(...actions.map((button) => button.left))
  return {
    x: (heading.right + end) / 2 - box.left,
    y: (heading.top + heading.bottom) / 2 - box.top,
  }
}

const nextFrame = (): Promise<number> => new Promise(requestAnimationFrame)

/**
 * Confirms that something stays true: the check holds on every one of several
 * rendered frames, so a reaction the app defers by a frame or two still fails it.
 */
export const expectStaysTrue = async (
  check: () => boolean,
  description: string,
  frames = 10,
): Promise<void> => {
  let held = 0
  let broken = false
  await expect
    .poll(
      async () => {
        await nextFrame()
        broken ||= !check()
        held += 1
        return !broken && held >= frames
      },
      { message: `${description} changed` },
    )
    .toBe(true)
}

/** Whether two rectangles match in size and position within a pixel. */
export const sameBox = (a: DOMRect, b: DOMRect): boolean =>
  (["left", "top", "width", "height"] as const).every((key) => Math.abs(a[key] - b[key]) <= 1)
