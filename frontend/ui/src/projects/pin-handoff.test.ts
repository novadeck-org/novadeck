import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement, useLayoutEffect, useRef } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { context, describe } from "../test"
import type { PinHandoff } from "./pin-drop"
import { arrivalFrames, usePinHandoff, type PinHandoffDrag } from "./pin-handoff"

// The bar's drag manager, named as the hook takes it: dnd-kit stays in the files that drag.
type DragDropManager = NonNullable<Parameters<PinHandoffDrag["takeManager"]>[0]>

const handoff: PinHandoff = { id: "p-1", point: { x: 40, y: 10 }, wasPinned: false }

// A drag manager whose drag gets under way only when the test says so.
const fakeManager = () => {
  const status = { dragging: false }
  const actions = { start: vi.fn(), move: vi.fn(), stop: vi.fn() }
  const manager = { actions, dragOperation: { status } } as unknown as DragDropManager
  return { manager, actions, status }
}

// Animation frames the test runs one at a time.
let frames: Map<number, FrameRequestCallback>
const runFrame = (): void =>
  act(() => {
    const due = [...frames]
    frames.clear()
    for (const [, callback] of due) callback(0)
  })

let listening: Set<string>
beforeEach(() => {
  // jsdom has neither; the pin's fade-in needs both.
  vi.stubGlobal("matchMedia", () => ({ matches: false }))
  Element.prototype.animate = vi.fn()
  frames = new Map()
  let next = 0
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    next += 1
    frames.set(next, callback)
    return next
  })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => void frames.delete(id))
  listening = new Set()
  const add = window.addEventListener.bind(window)
  const remove = window.removeEventListener.bind(window)
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    listening.add(type)
    add(type, listener, options)
  })
  vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, options) => {
    listening.delete(type)
    remove(type, listener, options)
  })
})

let rendered: Rendered | undefined
afterEach(() => {
  rendered?.unmount()
  rendered = undefined
  vi.unstubAllGlobals()
  delete (Element.prototype as { animate?: unknown }).animate
})

type Props = {
  readonly handoff: PinHandoff | null
  readonly manager: DragDropManager
  readonly onAbandon: () => void
}

// Hands the bar its manager from inside, as the bar's drag provider does: a child's layout
// effect runs before the handoff's own.
const ManagerOf = ({
  manager,
  onManager,
}: {
  readonly manager: DragDropManager
  readonly onManager: (manager: DragDropManager) => void
}): null => {
  useLayoutEffect(() => onManager(manager), [manager, onManager])
  return null
}

const Bar = ({ handoff, manager, onAbandon }: Props): React.JSX.Element => {
  const row = useRef<HTMLDivElement | null>(null)
  const { takeManager } = usePinHandoff(handoff, handoff !== null, row, onAbandon)
  return createElement(
    "div",
    { ref: row },
    createElement(ManagerOf, { manager, onManager: takeManager }),
    createElement("button", { className: "pin", "data-pin": "p-1" }, "p-1"),
  )
}

const pressEscape = (): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  window.dispatchEvent(event)
  return event
}

const followed = ["pointermove", "pointerup", "pointercancel", "keydown"]

describe("usePinHandoff", () => {
  context("when the handed-over drag gets under way", () => {
    it("follows the pointer and keeps the window's listeners", () => {
      const { manager, actions, status } = fakeManager()
      rendered = render(createElement(Bar, { handoff, manager, onAbandon: vi.fn() }))
      expect(actions.start).toHaveBeenCalledOnce()
      status.dragging = true
      for (let frame = 0; frame < arrivalFrames + 5; frame += 1) runFrame()
      expect(actions.move).toHaveBeenCalledWith({ to: handoff.point })
      expect([...listening]).toEqual(expect.arrayContaining(followed))
      expect(actions.stop).not.toHaveBeenCalled()
    })
  })

  context("when the handed-over drag never gets under way", () => {
    it("gives it up after a while, with no listener or frame left behind", () => {
      const { manager, actions } = fakeManager()
      const onAbandon = vi.fn()
      rendered = render(createElement(Bar, { handoff, manager, onAbandon }))
      expect([...listening]).toEqual(expect.arrayContaining(followed))
      for (let frame = 0; frame < arrivalFrames; frame += 1) runFrame()
      expect(onAbandon).toHaveBeenCalledOnce()
      expect(actions.stop).toHaveBeenCalledWith({ canceled: true })
      for (const type of followed) expect(listening).not.toContain(type)
      expect(frames.size).toBe(0)
      expect(pressEscape().defaultPrevented).toBe(false)
    })
  })

  context("when the handoff goes before its drag ends", () => {
    it("stops following it, and Escape is the app's again", () => {
      const { manager } = fakeManager()
      const onAbandon = vi.fn()
      rendered = render(createElement(Bar, { handoff, manager, onAbandon }))
      expect(pressEscape().defaultPrevented).toBe(true)
      rendered.rerender(createElement(Bar, { handoff: null, manager, onAbandon }))
      for (const type of followed) expect(listening).not.toContain(type)
      expect(frames.size).toBe(0)
      expect(pressEscape().defaultPrevented).toBe(false)
    })

    it("follows only the handoff in its place", () => {
      const { manager, actions } = fakeManager()
      const onAbandon = vi.fn()
      rendered = render(createElement(Bar, { handoff, manager, onAbandon }))
      const next: PinHandoff = { ...handoff, point: { x: 60, y: 10 } }
      rendered.rerender(createElement(Bar, { handoff: next, manager, onAbandon }))
      expect(actions.start).toHaveBeenCalledTimes(2)
      const added = vi.mocked(window.addEventListener).mock.calls
      const removed = vi.mocked(window.removeEventListener).mock.calls
      // Every listener the first handoff added is gone; the second's four are left.
      expect(added.filter(([type]) => followed.includes(type))).toHaveLength(8)
      expect(removed.filter(([type]) => followed.includes(type))).toHaveLength(4)
      expect(frames.size).toBe(1)
    })
  })
})
