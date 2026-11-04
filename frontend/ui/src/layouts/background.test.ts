import type { PointerEvent } from "react"
import { afterEach, expect, test } from "vitest"

import { backgroundPointerHandlers } from "./background"

afterEach(() => {
  document.body.replaceChildren()
})

const element = (className: string, attributes: Record<string, string> = {}) => {
  const made = document.createElement("div")
  made.className = className
  for (const [name, value] of Object.entries(attributes)) made.setAttribute(name, value)
  return made
}

// A view's ground holding its spotlight's dot layer and one window, and a spot inside
// the window the pointer can be over.
const ground = (surface: HTMLElement, window: HTMLElement, holder: HTMLElement = surface) => {
  const spotlight = element("workspace-dots canvas-grid-spotlight")
  const content = element("terminal-content")
  window.append(content)
  holder.append(window)
  surface.prepend(spotlight)
  document.body.append(surface)
  return { surface: surface as HTMLDivElement, spotlight, content }
}

const focus = () =>
  ground(element("focus-stage workspace-background"), element("terminal-visibility"))

const grid = (cell: Record<string, string> = {}, className = "grid-terminal") => {
  const surface = element("grid-viewport workspace-background")
  const layout = element("terminal-grid")
  surface.append(layout)
  const window = element(className, cell)
  window.append(element("grid-terminal-body terminal-visibility"))
  return ground(surface, window, layout)
}

const canvas = (hasSelection: boolean, node: string, attributes: Record<string, string> = {}) => {
  const surface = element("canvas-viewport workspace-background", {
    "data-has-selection": String(hasSelection),
  })
  const pane = element("react-flow__pane")
  surface.append(pane)
  const wrapper = element("react-flow__node")
  wrapper.append(element(node, attributes))
  const placed = ground(surface, wrapper, pane)
  return { ...placed, content: wrapper.querySelector(".canvas-node")! }
}

const move = (surface: HTMLDivElement, target: Element, x: number, y: number) =>
  backgroundPointerHandlers.onPointerMove({
    pointerType: "mouse",
    currentTarget: surface,
    target,
    clientX: x,
    clientY: y,
  } as unknown as PointerEvent<HTMLDivElement>)

const at = (spotlight: HTMLElement) => [
  spotlight.style.getPropertyValue("--canvas-pointer-x"),
  spotlight.style.getPropertyValue("--canvas-pointer-y"),
]

// The pointer reaches the ground at (40, 30), then moves to (300, 200) over `over`.
const crossInto = (placed: { surface: HTMLDivElement; spotlight: HTMLElement }, over: Element) => {
  move(placed.surface, placed.surface, 40, 30)
  move(placed.surface, over, 300, 200)
  return { at: at(placed.spotlight), shown: placed.surface.dataset.pointerInside === "true" }
}

const rests = { at: ["40px", "30px"], shown: false }
const follows = { at: ["300px", "200px"], shown: true }

test("the spotlight follows the pointer over the ground", () => {
  const { surface, spotlight } = focus()
  move(surface, surface, 40, 30)
  expect(at(spotlight)).toEqual(["40px", "30px"])
  expect(surface.dataset.pointerInside).toBe("true")
})

test("over Focus's window it fades out where it was and stops moving", () => {
  const placed = focus()
  expect(crossInto(placed, placed.content)).toEqual(rests)
})

test("back on the ground it comes back under the pointer", () => {
  const { surface, spotlight, content } = focus()
  move(surface, content, 300, 200)
  move(surface, surface, 8, 500)
  expect(at(spotlight)).toEqual(["8px", "500px"])
  expect(surface.dataset.pointerInside).toBe("true")
})

test("over a Grid cell it rests, and between cells it follows", () => {
  const placed = grid()
  expect(crossInto(placed, placed.content)).toEqual(rests)
  expect(crossInto(placed, placed.surface.querySelector(".terminal-grid")!)).toEqual(follows)
})

test("over a selected preview in Grid, which lets the ground show through, it follows", () => {
  const placed = grid({ "data-preview": "true" }, "grid-terminal selected")
  expect(crossInto(placed, placed.content)).toEqual(follows)
})

test("over a Canvas node it rests when the node is opaque", () => {
  for (const [hasSelection, node, attributes] of [
    [false, "canvas-node", {}],
    [true, "canvas-node selected", {}],
    [true, "canvas-node", { "data-team": "lead" }],
  ] as const) {
    const placed = canvas(hasSelection, node, attributes)
    expect(crossInto(placed, placed.content)).toEqual(rests)
    document.body.replaceChildren()
  }
})

test("over a Canvas node that recedes, which lets the ground show through, it follows", () => {
  for (const [node, attributes] of [
    ["canvas-node", {}],
    ["canvas-node selected", { "data-preview": "true" }],
  ] as const) {
    const placed = canvas(true, node, attributes)
    expect(crossInto(placed, placed.content)).toEqual(follows)
    document.body.replaceChildren()
  }
})

test("over a portal, such as a terminal's menu, it rests", () => {
  const placed = focus()
  const menu = element("menu-content")
  document.body.append(menu)
  expect(crossInto(placed, menu)).toEqual(rests)
})
