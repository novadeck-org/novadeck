import { render } from "@novadeck/test-kit/render"
import { act, createElement, type ComponentProps } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { HoverCard } from "./HoverCard"
import { Shown } from "./shown"
import { context, describe, expect, it } from "./test"

// jsdom has no layout: an open peek's positioning observes no resizes.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

const mounted: (() => void)[] = []
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }))
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  vi.useRealTimers()
})

type Props = ComponentProps<typeof HoverCard>

const card = (name: string, onOpenChange: NonNullable<Props["onOpenChange"]>, shown = true) => {
  const props: Props = {
    trigger: createElement("button", { type: "button", "data-name": name }, name),
    children: `${name}'s peek`,
    onOpenChange,
  }
  return createElement(Shown.Provider, { value: shown }, createElement(HoverCard, props))
}

const mount = (element: ReturnType<typeof card>) => {
  const view = render(element)
  mounted.push(view.unmount)
  return view
}

// The pointer comes to rest on a trigger, so its peek opens.
const rest = (name: string) => {
  const trigger = document.querySelector<HTMLElement>(`[data-name="${name}"]`)!
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }))
  })
  act(() => vi.advanceTimersByTime(250))
}

describe("a peek", () => {
  it("opens once the pointer rests on its trigger, and says so", () => {
    const told: boolean[] = []
    mount(card("a", (open) => void told.push(open)))
    rest("a")
    expect(told).toEqual([true])
  })

  context("handed over to the next one", () => {
    it("tells the latest of what its owner gave it that it closed", () => {
      const first: boolean[] = []
      const latest: boolean[] = []
      const others: boolean[] = []
      const a = mount(card("a", (open) => void first.push(open)))
      mount(card("b", (open) => void others.push(open)))
      rest("a")
      a.rerender(card("a", (open) => void latest.push(open)))
      rest("b")
      expect(first).toEqual([true])
      expect(latest).toEqual([false])
      expect(others).toEqual([true])
    })
  })

  context("whose trigger goes out of sight", () => {
    it("closes, telling the latest of what its owner gave it", () => {
      const first: boolean[] = []
      const latest: boolean[] = []
      const a = mount(card("a", (open) => void first.push(open)))
      rest("a")
      // Given another as it goes out of sight, in the same render.
      a.rerender(card("a", (open) => void latest.push(open), false))
      expect(first).toEqual([true])
      expect(latest).toEqual([false])
    })
  })
})
