import type { PointerEvent } from "react"
import { afterEach, expect, test } from "vitest"

import { backgroundPointerHandlers } from "./background"

afterEach(() => {
  document.body.replaceChildren()
})

// A view's ground: the spotlight's dot layer and one window, as Focus draws them.
const ground = () => {
  const surface = document.createElement("div")
  surface.className = "workspace-background"
  const spotlight = document.createElement("div")
  spotlight.className = "workspace-dots canvas-grid-spotlight"
  const window = document.createElement("div")
  window.className = "terminal-visibility"
  const content = document.createElement("div")
  window.append(content)
  surface.append(spotlight, window)
  document.body.append(surface)
  return { surface, spotlight, content }
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

test("the spotlight follows the pointer over the ground", () => {
  const { surface, spotlight } = ground()
  move(surface, surface, 40, 30)
  expect(at(spotlight)).toEqual(["40px", "30px"])
  expect(surface.dataset.pointerInside).toBe("true")
})

test("over a window the spotlight fades out where it was and stops moving", () => {
  const { surface, spotlight, content } = ground()
  move(surface, surface, 40, 30)
  move(surface, content, 300, 200)
  expect(at(spotlight)).toEqual(["40px", "30px"])
  expect(surface.dataset.pointerInside).toBeUndefined()
})

test("back on the ground it comes back under the pointer", () => {
  const { surface, spotlight, content } = ground()
  move(surface, content, 300, 200)
  move(surface, surface, 8, 500)
  expect(at(spotlight)).toEqual(["8px", "500px"])
  expect(surface.dataset.pointerInside).toBe("true")
})
