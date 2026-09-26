import { expect } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { terminal } from "./workspace"

// Canvas vocabulary: where things appear on screen and the pointer gestures a person
// makes. Geometry is measured from rendered boxes, relative to the Canvas view.

type Point = { x: number; y: number }

export type Box = {
  left: number
  top: number
  width: number
  height: number
  centerX: number
  centerY: number
}

export const canvasView = (): Locator => page.getByRole("region", { name: "canvas view" })

/** The Canvas surface behind the terminals, which receives background gestures. */
export const canvasBackground = (): Locator => page.getByLabelText("Terminal canvas")

export const canvasMenu = (): Locator => page.getByRole("menu", { name: "Canvas actions" })

const screenBox = (locator: Locator): DOMRect => locator.element().getBoundingClientRect()

/** Where a terminal (or any element) appears on screen, relative to the Canvas view. */
export const boxOf = (locator: Locator): Box => {
  const view = screenBox(canvasView())
  const rect = screenBox(locator)
  return {
    left: rect.left - view.left,
    top: rect.top - view.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left - view.left + rect.width / 2,
    centerY: rect.top - view.top + rect.height / 2,
  }
}

export const viewBox = (): Box => {
  const { width, height } = screenBox(canvasView())
  return { left: 0, top: 0, width, height, centerX: width / 2, centerY: height / 2 }
}

/** The boxes of the named terminals, keyed by name. */
export const boxesOf = (names: string[]): Record<string, Box> =>
  Object.fromEntries(names.map((name) => [name, boxOf(terminal(name))]))

const allTerminals = (): Element[] => page.getByRole("region", { name: / terminal$/ }).elements()

/** The terminal a person sees at a point of the Canvas view, if any. */
export const terminalAt = (point: Point): string | undefined => {
  const view = screenBox(canvasView())
  const hit = document.elementFromPoint(view.left + point.x, view.top + point.y)
  const owner = allTerminals().find((element) => hit && element.contains(hit))
  return owner?.getAttribute("aria-label")?.replace(/ terminal$/, "")
}

/** Guards a gesture's starting point: it must be bare Canvas, not a terminal. */
export const expectBareCanvasAt = (point: Point): void => {
  expect(terminalAt(point), `a terminal covers ${point.x},${point.y}`).toBeUndefined()
}

const inBackground = (point: Point): Point => {
  const view = screenBox(canvasView())
  const background = screenBox(canvasBackground())
  return { x: point.x + view.left - background.left, y: point.y + view.top - background.top }
}

/**
 * Presses the mouse on `source` (at `at`, relative to its box, or its centre),
 * moves it by `by` in several steps, and releases it.
 */
export const dragBy = async (source: Locator, by: Point, at?: Point): Promise<void> => {
  const rect = screenBox(source)
  const view = screenBox(canvasView())
  const start = at ?? { x: rect.width / 2, y: rect.height / 2 }
  const end = inBackground({
    x: rect.left - view.left + start.x + by.x,
    y: rect.top - view.top + start.y + by.y,
  })
  await userEvent.dragAndDrop(source, canvasBackground(), {
    sourcePosition: start,
    targetPosition: end,
    steps: 8,
    scroll: "none",
  })
}

/** Drags the bare Canvas from `from` (relative to the Canvas view) by `by`. */
export const dragBackground = async (from: Point, by: Point): Promise<void> => {
  expectBareCanvasAt(from)
  await dragBy(canvasBackground(), by, inBackground(from))
}

/** Clicks bare Canvas, which also gives it keyboard focus. */
export const clickBackground = async (at: Point): Promise<void> => {
  expectBareCanvasAt(at)
  await canvasBackground().click({ position: inBackground(at), scroll: "none" })
}

export const rightClickBackground = async (at: Point): Promise<void> => {
  expectBareCanvasAt(at)
  await canvasBackground().click({ button: "right", position: inBackground(at), scroll: "none" })
}

/**
 * A point on a terminal's header between its name and its first header action,
 * relative to the terminal. A terminal partly outside the view uses only the part
 * of its header a person can see.
 */
export const besideName = (name: string): Point => {
  const region = screenBox(terminal(name))
  const heading = screenBox(terminal(name).getByRole("heading", { name, exact: true }))
  const actions = terminal(name)
    .getByRole("button")
    .elements()
    .map((button) => button.getBoundingClientRect())
    .filter((button) => button.left > heading.right && button.top < heading.bottom)
  const end = Math.min(screenBox(canvasView()).right, ...actions.map((button) => button.left))
  return {
    x: (heading.right + end) / 2 - region.left,
    y: (heading.top + heading.bottom) / 2 - region.top,
  }
}

/** Double-clicks a terminal's header between its name and its first header action. */
export const doubleClickHeader = async (name: string): Promise<void> => {
  await terminal(name).dblClick({ position: besideName(name), scroll: "none" })
}

export const dragHeader = async (name: string, by: Point): Promise<void> => {
  await dragBy(terminal(name), by, besideName(name))
}

/** Scrolls the mouse wheel with the pointer over the middle of `target`. */
export const scrollOver = async (target: Locator, deltaY: number): Promise<void> => {
  await userEvent.wheel(target, { delta: { y: deltaY } })
}

/** Scrolls the mouse wheel with the pointer over the middle of the Canvas. */
export const scrollCanvas = async (deltaY: number): Promise<void> => {
  const { centerX, centerY } = viewBox()
  expectBareCanvasAt({ x: centerX, y: centerY })
  await userEvent.wheel(canvasBackground(), { delta: { y: deltaY } })
}

const nextFrame = (): Promise<number> => new Promise(requestAnimationFrame)

/**
 * Resolves with the measurement once it has stayed the same for several rendered
 * frames. The app reacts to gestures frame by frame, so wall-clock gaps between polls
 * could see two identical frames before a pending reaction lands.
 */
export const settled = async <T,>(measure: () => T, frames = 5): Promise<T> => {
  let previous = JSON.stringify(measure())
  let still = 0
  await expect
    .poll(async () => {
      await nextFrame()
      const next = JSON.stringify(measure())
      still = next === previous ? still + 1 : 0
      previous = next
      return still >= frames
    })
    .toBe(true)
  return measure()
}

export const near = (actual: number, expected: number, tolerance = 2): boolean =>
  Math.abs(actual - expected) <= tolerance

export const sameBox = (actual: Box, expected: Box, tolerance = 2): boolean =>
  near(actual.left, expected.left, tolerance) &&
  near(actual.top, expected.top, tolerance) &&
  near(actual.width, expected.width, tolerance) &&
  near(actual.height, expected.height, tolerance)

/** The terminal is centred in the Canvas view and fills it along one side. */
export const fillsView = (box: Box, tolerance = 3): boolean => {
  const view = viewBox()
  return (
    near(box.centerX, view.centerX, tolerance) &&
    near(box.centerY, view.centerY, tolerance) &&
    box.width <= view.width + tolerance &&
    box.height <= view.height + tolerance &&
    (near(box.width, view.width, tolerance) || near(box.height, view.height, tolerance))
  )
}

export const insideView = (box: Box, tolerance = 1): boolean => {
  const view = viewBox()
  return (
    box.left >= -tolerance &&
    box.top >= -tolerance &&
    box.left + box.width <= view.width + tolerance &&
    box.top + box.height <= view.height + tolerance
  )
}
