import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement, type ComponentProps } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { ConfirmDialog } from "./ConfirmDialog"
import { context, describe, expect, it } from "./test"

type Asked = { readonly name: string }
type Props = ComponentProps<typeof ConfirmDialog<Asked>>

const a: Asked = { name: "a" }
const b: Asked = { name: "b" }

// Every dialog a test puts up, taken down after it, passed or not.
const mounted: (() => void)[] = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  vi.useRealTimers()
})

// The dialog animates out, as overlay.css has it, and jsdom never ends the animation, so it
// stays closing. A browser's computed style is live, and Ark reads it as the dialog closes;
// jsdom's is a snapshot, so here it is read afresh each time.
const animateClosing = (): void => {
  const animated = document.createElement("style")
  animated.textContent =
    '[data-scope="dialog"][data-part="content"][data-state="closed"] { animation-name: out; animation-duration: 1s }'
  beforeEach(() => {
    document.head.append(animated)
    const computed = window.getComputedStyle.bind(window)
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element, pseudo) =>
        new Proxy(computed(element, pseudo), {
          get: (_, key) => Reflect.get(computed(element, pseudo), key),
        }),
    )
  })
  afterEach(() => animated.remove())
}

const mount = (overrides: Partial<Props> = {}) => {
  const answers: string[] = []
  const props = (subject: Asked | null, more: Partial<Props> = {}): Props => ({
    subject,
    title: (shown) => `Close ${shown.name}?`,
    description: (shown) => `${shown.name} is running.`,
    confirmLabel: "Close",
    cancelLabel: "Cancel",
    onConfirm: () => void answers.push("confirm"),
    onCancel: () => void answers.push("cancel"),
    widthClassName: "",
    ...overrides,
    ...more,
  })
  const view = render(createElement(ConfirmDialog<Asked>, props(null)))
  mounted.push(view.unmount)
  const show = async (subject: Asked | null, more: Partial<Props> = {}) => {
    view.rerender(createElement(ConfirmDialog<Asked>, props(subject, more)))
    await nextFrame()
  }
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
  const button = (label: string): HTMLButtonElement | undefined =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (each) => each.textContent === label,
    )
  const press = (label: string) => act(() => button(label)!.click())
  const escape = () =>
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      )
    })
  return { show, dialog, button, press, escape, answers }
}

describe("a confirm dialog", () => {
  context("asked again after a confirm, while it still animates out", () => {
    animateClosing()

    it("cancels on Escape", async () => {
      const { show, dialog, press, escape, answers } = mount()
      await show(a)
      press("Close")
      await show(null)
      expect(dialog()?.dataset.state).toBe("closed")
      await show(b)
      await escape()
      expect(answers).toEqual(["confirm", "cancel"])
    })

    it("cancels on Escape when it asks the same thing again", async () => {
      const { show, press, escape, answers } = mount()
      await show(a)
      press("Close")
      await show(null)
      await show(a)
      await escape()
      expect(answers).toEqual(["confirm", "cancel"])
    })

    it("gives focus back where the page asks once cancelled", async () => {
      const input = document.createElement("input")
      document.body.append(input)
      const { show, press, escape } = mount({ returnFocus: () => input })
      await show(a)
      press("Close")
      await show(null)
      await show(b)
      await escape()
      await show(null)
      await nextFrame()
      expect(document.activeElement).toBe(input)
      input.remove()
    })
  })

  context("moving straight to another question after a confirm", () => {
    it("cancels the new one on Escape", async () => {
      const { show, press, escape, answers } = mount()
      await show(a)
      press("Close")
      await show(b)
      await escape()
      expect(answers).toEqual(["confirm", "cancel"])
    })
  })

  context("confirmed, before the page has taken the answer", () => {
    it("doesn't cancel too on Escape", async () => {
      const { show, press, escape, answers } = mount()
      await show(a)
      press("Close")
      await escape()
      expect(answers).toEqual(["confirm"])
    })
  })

  context("cancelled with its button", () => {
    it("cancels once and gives focus back where the page asks", async () => {
      const input = document.createElement("input")
      document.body.append(input)
      const { show, press, answers } = mount({ returnFocus: () => input })
      await show(a)
      press("Cancel")
      await show(null)
      await nextFrame()
      expect(answers).toEqual(["cancel"])
      expect(document.activeElement).toBe(input)
      input.remove()
    })
  })
})

describe("a confirm dialog's delay before confirming", () => {
  const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

  it("holds confirming back each time it shows, with the same key too", async () => {
    fakeTimers()
    const { show, button } = mount({ armMs: 1000, armKey: "one" })
    await show(a)
    expect(button("Close")!.disabled).toBe(true)
    act(() => vi.advanceTimersByTime(1000))
    expect(button("Close")!.disabled).toBe(false)
    await show(null)
    await show(a)
    expect(button("Close")!.disabled).toBe(true)
    act(() => vi.advanceTimersByTime(1000))
    expect(button("Close")!.disabled).toBe(false)
  })

  it("starts again when the key changes while open", async () => {
    fakeTimers()
    const { show, button } = mount({ armMs: 1000 })
    await show(a, { armKey: "one" })
    act(() => vi.advanceTimersByTime(1000))
    expect(button("Close")!.disabled).toBe(false)
    await show(b, { armKey: "two" })
    expect(button("Close")!.disabled).toBe(true)
    act(() => vi.advanceTimersByTime(999))
    expect(button("Close")!.disabled).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(button("Close")!.disabled).toBe(false)
  })

  context("as it animates out", () => {
    animateClosing()

    it("leaves the confirm button as it was", async () => {
      fakeTimers()
      const { show, dialog, button } = mount({ armMs: 1000, armKey: "one" })
      await show(a)
      act(() => vi.advanceTimersByTime(1000))
      await show(null)
      expect(dialog()?.dataset.state).toBe("closed")
      expect(button("Close")!.disabled).toBe(false)
    })
  })
})
