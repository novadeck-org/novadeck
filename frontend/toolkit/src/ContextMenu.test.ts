import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeEach } from "vitest"

import { ContextMenu, type ContextMenuItem } from "./ContextMenu"
import { describe, expect, it } from "./test"

// jsdom has no layout: an open menu's positioning observes no resizes.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

// A browser lets go of focus held in what it hides, as the closing menu does; jsdom keeps it
// there, and won't blur what is hidden, so the menu is shown again for the blur.
const fixup = new MutationObserver(() => {
  const active = document.activeElement
  const hidden = active instanceof HTMLElement ? active.closest<HTMLElement>("[hidden]") : null
  if (!hidden) return
  hidden.hidden = false
  ;(active as HTMLElement).blur()
  hidden.hidden = true
})
beforeEach(() =>
  fixup.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden"] }),
)
// Every menu and field a test puts up, taken down after it, passed or not.
const mounted: (() => void)[] = []
afterEach(() => {
  fixup.disconnect()
  for (const undo of mounted.splice(0)) undo()
})

const settle = async () => {
  for (let frame = 0; frame < 6; frame += 1)
    // eslint-disable-next-line no-await-in-loop -- Each frame comes after the one before.
    await nextFrame()
}

const mount = (items: readonly ContextMenuItem[]) => {
  const opener = document.createElement("input")
  document.body.append(opener)
  const view = render(
    createElement(ContextMenu, {
      label: "Actions",
      items,
      trigger: createElement("div", { "data-testid": "trigger" }, "Row"),
    }),
  )
  const open = async () => {
    opener.focus()
    const trigger = view.container.querySelector<HTMLElement>('[data-testid="trigger"]')!
    act(() => {
      trigger.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      )
    })
    await settle()
  }
  const item = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[data-scope="menu"][data-part="item"]')].find(
      (each) => each.textContent === label,
    )
  const choose = async (label: string) => {
    act(() => item(label)!.click())
    await settle()
  }
  mounted.push(() => {
    view.unmount()
    opener.remove()
  })
  return { opener, open, choose }
}

const menuOpen = (): boolean =>
  document.querySelector('[data-scope="menu"][data-part="content"][data-state="open"]') !== null

describe("a context menu", () => {
  it("runs the chosen item once it has closed, with focus back where it was", async () => {
    const seen: { readonly focused: Element | null; readonly open: boolean }[] = []
    const { opener, open, choose } = mount([
      {
        value: "rename",
        label: "Rename",
        onSelect: () => void seen.push({ focused: document.activeElement, open: menuOpen() }),
      },
    ])
    await open()
    expect(menuOpen()).toBe(true)
    await choose("Rename")
    expect(seen).toEqual([{ focused: opener, open: false }])
  })

  it("runs nothing for a disabled item", async () => {
    let ran = 0
    const { open, choose } = mount([
      { value: "move", label: "Move", disabled: true, onSelect: () => void (ran += 1) },
    ])
    await open()
    await choose("Move")
    expect(ran).toBe(0)
  })
})
