import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement, type ComponentProps } from "react"
import { afterEach } from "vitest"

import { Sheet } from "./Sheet"
import { context, describe, expect, it } from "./test"

// jsdom has no layout: an open sheet's positioning observes no resizes.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

const mounted: (() => void)[] = []
afterEach(() => {
  for (const undo of mounted.splice(0)) undo()
})

// A row of a list, standing where a test puts it; jsdom lays nothing out itself.
const row = (left: number, top: number): HTMLElement => {
  const element = document.createElement("div")
  mounted.push(() => element.remove())
  element.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: left, y: top, width: 200, height: 24 })
  document.body.append(element)
  return element
}

const sheet = (
  placement: Pick<ComponentProps<typeof Sheet>, "anchor" | "anchorKey" | "placeKey">,
) => {
  const props: ComponentProps<typeof Sheet> = {
    label: "Details",
    open: true,
    boundary: () => null,
    onInteractOutside: () => {},
    onDismiss: () => {},
    children: "Body",
    ...placement,
  }
  return createElement(Sheet, props)
}

// Where the sheet stands: what its placement wrote on the positioner.
const mount = (element: ReturnType<typeof sheet>) => {
  const view = render(element)
  mounted.unshift(view.unmount)
  return view
}

const placed = (): string => {
  const style = document.querySelector<HTMLElement>(
    '[data-scope="popover"][data-part="positioner"]',
  )?.style
  return style ? `${style.getPropertyValue("--x")} ${style.getPropertyValue("--y")}` : ""
}

const settle = async () => {
  for (let frame = 0; frame < 4; frame += 1)
    // eslint-disable-next-line no-await-in-loop -- Each frame comes after the one before.
    await nextFrame()
  await act(async () => {})
}

describe("a sheet", () => {
  context("whose row leaves the page", () => {
    it("stays where the row last was as it places itself again", async () => {
      const first = row(300, 400)
      const view = mount(sheet({ anchor: () => first, anchorKey: "a" }))
      await settle()
      expect(placed()).toBe("508px 400px")
      view.rerender(sheet({ anchor: () => null, anchorKey: "a", placeKey: "1" }))
      await settle()
      expect(placed()).toBe("508px 400px")
    })
  })

  context("anchored anew to another row", () => {
    it("stands beside that row", async () => {
      const rows: Record<string, HTMLElement> = { a: row(300, 400), b: row(300, 100) }
      const view = mount(sheet({ anchor: () => rows.a!, anchorKey: "a" }))
      await settle()
      expect(placed()).toBe("508px 400px")
      view.rerender(sheet({ anchor: () => rows.b!, anchorKey: "b" }))
      await settle()
      expect(placed()).toBe("508px 100px")
    })
  })

  context("anchored anew to a row that isn't on the page yet", () => {
    it("doesn't stand beside the last row", async () => {
      const first = row(300, 400)
      const view = mount(sheet({ anchor: () => first, anchorKey: "a" }))
      await settle()
      const besideFirst = placed()
      expect(besideFirst).toBe("508px 400px")
      view.rerender(sheet({ anchor: () => null, anchorKey: "b" }))
      await settle()
      expect(placed()).not.toBe(besideFirst)
    })
  })
})
