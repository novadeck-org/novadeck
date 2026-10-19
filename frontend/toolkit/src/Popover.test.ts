import { readFileSync } from "node:fs"
import { join } from "node:path"

import { nextFrame, render } from "@novadeck/test-kit/render"
import { createElement, type ComponentProps } from "react"

import { Popover } from "./Popover"
import { describe, expect, it } from "./test"

// jsdom has no layout: an open popover's positioning observes no resizes.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

// What icon-button.css styles as an open trigger: any select, menu or popover trigger
// that's open, whatever else wraps it.
const openTrigger = '.icon-button[aria-haspopup][aria-expanded="true"]'

const iconButtonCss = readFileSync(join(process.cwd(), "src", "icon-button.css"), "utf8")

describe("the icon button's open look", () => {
  it("keys on what every open select, menu or popover trigger says, not on Ark's state", () => {
    expect(iconButtonCss).toContain(`${openTrigger} {`)
  })
})

describe("a popover's trigger with a tooltip", () => {
  it("still reads as an open popover trigger, so its open look holds", async () => {
    const props: ComponentProps<typeof Popover> = {
      label: "Options",
      open: true,
      onOpenChange: () => {},
      tooltip: "More options",
      trigger: createElement("button", { type: "button", className: "icon-button" }, "…"),
      children: "Content",
    }
    const view = render(createElement(Popover, props))
    const trigger = view.container.querySelector<HTMLButtonElement>("button.icon-button")!
    // The tooltip around it takes the trigger's Ark data attributes.
    expect(trigger.getAttribute("data-scope")).toBe("tooltip")
    expect(trigger.matches(openTrigger)).toBe(true)
    await nextFrame()
    view.unmount()
  })
})
