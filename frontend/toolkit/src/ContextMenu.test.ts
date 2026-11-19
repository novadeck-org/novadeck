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

const mount = (items: readonly ContextMenuItem[], opensOn?: "context" | "click") => {
  const opener = document.createElement("input")
  document.body.append(opener)
  const view = render(
    createElement(ContextMenu, {
      label: "Actions",
      items,
      ...(opensOn ? { opensOn } : {}),
      trigger: createElement(
        opensOn === "click" ? "button" : "div",
        { "data-testid": "trigger" },
        "Row",
      ),
    }),
  )
  const trigger = () => view.container.querySelector<HTMLElement>('[data-testid="trigger"]')!
  const open = async () => {
    opener.focus()
    act(() => {
      if (opensOn === "click") trigger().click()
      else
        trigger().dispatchEvent(
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
  return { opener, trigger, open, choose }
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

  it("opens on a click where asked, and gives focus back to its trigger", async () => {
    const seen: (Element | null)[] = []
    const { opener, trigger, open, choose } = mount(
      [
        {
          value: "tour",
          label: "Take the tour",
          onSelect: () => void seen.push(document.activeElement),
        },
      ],
      "click",
    )
    await open()
    expect(menuOpen()).toBe(true)
    await choose("Take the tour")
    expect(menuOpen()).toBe(false)
    expect(seen).toEqual([trigger()])
    expect(seen[0]).not.toBe(opener)
  })

  it("opens on a right-click only, by default", async () => {
    const { trigger } = mount([{ value: "a", label: "A", onSelect: () => {} }])
    act(() => trigger().click())
    await settle()
    expect(menuOpen()).toBe(false)
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

describe("a menu at a point", () => {
  // A menu asked for where no element of the page can hear, as a live page's view: open at
  // `at` while it's set, telling its caller when the person closes it.
  const mountAt = (items: readonly ContextMenuItem[]) => {
    const opener = document.createElement("input")
    document.body.append(opener)
    const told: boolean[] = []
    let at: { x: number; y: number } | undefined
    const tree = () =>
      createElement(ContextMenu, {
        label: "Page",
        items,
        at,
        onOpenChange: (open: boolean) => {
          told.push(open)
          if (!open) at = undefined
        },
      })
    const view = render(tree())
    mounted.push(() => {
      view.unmount()
      opener.remove()
    })
    const openAt = async (point: { x: number; y: number }) => {
      opener.focus()
      at = point
      view.rerender(tree())
      await settle()
    }
    return { opener, told, openAt, rerender: () => view.rerender(tree()) }
  }

  it("opens there, runs the chosen item once closed, with focus back where it was", async () => {
    const seen: (Element | null)[] = []
    const { opener, told, openAt, rerender } = mountAt([
      { value: "copy", label: "Copy", onSelect: () => void seen.push(document.activeElement) },
    ])
    expect(menuOpen()).toBe(false)
    await openAt({ x: 40, y: 60 })
    expect(menuOpen()).toBe(true)
    const item = [
      ...document.querySelectorAll<HTMLElement>('[data-scope="menu"][data-part="item"]'),
    ].find((each) => each.textContent === "Copy")!
    act(() => item.click())
    await settle()
    rerender()
    await settle()
    expect(menuOpen()).toBe(false)
    expect(told).toContain(false)
    expect(seen).toEqual([opener])
  })

  it("closes on Escape, saying so", async () => {
    const { told, openAt, rerender } = mountAt([{ value: "a", label: "A", onSelect: () => {} }])
    await openAt({ x: 40, y: 60 })
    const content = document.querySelector<HTMLElement>(
      '[data-scope="menu"][data-part="content"][data-state="open"]',
    )!
    act(() => {
      content.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    await settle()
    rerender()
    await settle()
    expect(told.at(-1)).toBe(false)
    expect(menuOpen()).toBe(false)
  })
})
