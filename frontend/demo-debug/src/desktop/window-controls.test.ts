import { afterEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { clearDemoWindowControls, createDemoWindowControls } from "./window-controls"

const lights = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>("[data-demo-window-controls]"),
]

afterEach(() => {
  clearDemoWindowControls()
})

describe("demo window controls", () => {
  it("say the page is the title bar, its controls at the start", () => {
    const controls = createDemoWindowControls("inset")
    expect(controls.side).toBe("start")
    expect(document.documentElement.dataset.windowControls).toBe("start")
  })

  it("show the buttons on the line the page asks for, and hide them when it asks", () => {
    const controls = createDemoWindowControls("inset")
    const insets: number[] = []
    controls.onInset((inset) => insets.push(inset))
    controls.place(32)
    expect(lights()[0]?.style.display).toBe("flex")
    expect(lights()[0]?.style.top).toBe("26px")
    controls.place(null)
    expect(lights()[0]?.style.display).toBe("none")
    expect(insets).toEqual([74, 0])
  })

  context("when the boot makes its backend again", () => {
    it("shows the buttons of the one the page places, and only those", () => {
      const placed = createDemoWindowControls("inset")
      createDemoWindowControls("inset")
      placed.place(32)
      expect(lights()).toHaveLength(1)
      expect(lights()[0]?.style.display).toBe("flex")
    })
  })

  it("keep no buttons over the page in full screen", () => {
    const controls = createDemoWindowControls("fullScreen")
    const insets: number[] = []
    controls.onInset((inset) => insets.push(inset))
    controls.place(32)
    expect(lights()[0]?.style.display).toBe("none")
    expect(insets).toEqual([0])
  })
})
