import type { Feedback, FeedbackNote } from "@novadeck/core/feedback"
import { nextFrame, render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { openedStorageKey, sentForMs } from "./feedback-state"
import { FeedbackButton } from "./FeedbackButton"

// jsdom has no layout: an open popover's positioning observes no resizes.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

const mounted: Rendered[] = []
beforeEach(() => localStorage.clear())
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  vi.useRealTimers()
  localStorage.clear()
})

type Fake = Feedback & { readonly sent: FeedbackNote[]; failing: boolean }
const fake = (): Fake => {
  const sent: FeedbackNote[] = []
  const backend = {
    sent,
    failing: false,
    about: () => Promise.resolve({ version: "0.15.0", os: "Linux x64" }),
    send: (note: FeedbackNote) => {
      if (backend.failing) return Promise.reject(new Error("offline"))
      sent.push(note)
      return Promise.resolve()
    },
    ask: () => Promise.resolve(),
  }
  return backend
}

const show = (feedback: Feedback = fake()) => {
  const page = render(createElement(FeedbackButton, { feedback }))
  mounted.push(page)
  const button = () => page.container.querySelector<HTMLButtonElement>(".feedback-button")!
  const card = () => document.querySelector<HTMLElement>(".feedback-card")
  const field = () => document.querySelector<HTMLTextAreaElement>(".feedback-input")!
  const sendButton = () => document.querySelector<HTMLButtonElement>(".feedback-send")!
  const open = async () => {
    act(() => button().click())
    await nextFrame()
  }
  const type = (text: string) => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
      setter.call(field(), text)
      field().dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  const key = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    act(() => void field().dispatchEvent(event))
    return event
  }
  const settle = () => act(() => Promise.resolve())
  return { button, card, field, sendButton, open, type, key, settle }
}

describe("the footer's feedback button", () => {
  context("on a new install", () => {
    it("shows the word until the card is first opened, and never after", async () => {
      const view = show()
      expect(view.button().textContent).toContain("Feedback")
      await view.open()
      expect(localStorage.getItem(openedStorageKey)).toBe("1")
      expect(view.button().textContent).toBe("")
      expect(view.button().getAttribute("aria-label")).toBe("Send feedback")
      // Closed again, and hovered: still just the icon.
      act(() => view.button().click())
      act(() => void view.button().dispatchEvent(new MouseEvent("mouseover", { bubbles: true })))
      expect(view.button().textContent).toBe("")
    })

    it("is the icon alone where the card was opened before", () => {
      localStorage.setItem(openedStorageKey, "1")
      expect(show().button().textContent).toBe("")
    })
  })

  context("with the card open", () => {
    it("is pressed, and asks for the version and OS", async () => {
      const view = show()
      await view.open()
      expect(view.button().getAttribute("aria-expanded")).toBe("true")
      await view.settle()
      expect(view.card()!.querySelector(".feedback-privacy")!.textContent).toBe(
        "Anonymous. We get this note, 0.15.0, Linux x64.",
      )
    })

    it("asks for what the picked kind is about", async () => {
      const view = show()
      await view.open()
      expect(view.field().placeholder).toBe("What's broken, missing or good?")
      const bug = view.card()!.querySelector<HTMLInputElement>('input[aria-label="Bug"]')!
      act(() => bug.click())
      await nextFrame()
      expect(view.field().placeholder).toBe("What went wrong? What did you expect?")
    })

    it("counts only near the limit", async () => {
      const view = show()
      await view.open()
      view.type("short")
      expect(view.card()!.querySelector(".feedback-count")).toBeNull()
      view.type("x".repeat(1_850))
      expect(view.card()!.querySelector(".feedback-count")!.textContent).toBe("1,850 / 2,000")
    })

    it("keeps the draft when Esc closes it", async () => {
      const view = show()
      await view.open()
      view.type("keep me")
      act(
        () =>
          void view
            .field()
            .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      )
      await nextFrame()
      expect(view.card()).toBeNull()
      await view.open()
      expect(view.field().value).toBe("keep me")
    })
  })

  context("sending", () => {
    it("sends a one-line note on Enter, and types a new line once there is one", async () => {
      const backend = fake()
      const view = show(backend)
      await view.open()
      view.type("first\nsecond")
      expect(view.key({ key: "Enter" }).defaultPrevented).toBe(false)
      expect(backend.sent).toEqual([])
      view.type("one line")
      expect(view.key({ key: "Enter" }).defaultPrevented).toBe(true)
      await view.settle()
      expect(backend.sent).toEqual([{ kind: null, text: "one line" }])
    })

    it("sends a note with line breaks on Ctrl+Enter", async () => {
      const backend = fake()
      const view = show(backend)
      await view.open()
      view.type("first\nsecond")
      view.key({ key: "Enter", ctrlKey: true })
      await view.settle()
      expect(backend.sent).toEqual([{ kind: null, text: "first\nsecond" }])
    })

    it("closes the card on a send and says so for three seconds", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const view = show()
      await view.open()
      view.type("thanks")
      act(() => view.sendButton().click())
      await view.settle()
      expect(view.button().textContent).toBe("Sent · thanks")
      await nextFrame()
      expect(view.card()).toBeNull()
      act(() => void vi.advanceTimersByTime(sentForMs - 1))
      expect(view.button().textContent).toBe("Sent · thanks")
      act(() => void vi.advanceTimersByTime(1))
      expect(view.button().textContent).toBe("")
    })

    it("keeps the note of a send that is rejected, and sends it again on Retry", async () => {
      const backend = fake()
      backend.failing = true
      const view = show(backend)
      await view.open()
      view.type("flaky")
      act(() => view.sendButton().click())
      await view.settle()
      expect(view.button().textContent).toBe("Not sent · Retry")
      expect(view.card()).not.toBeNull()
      expect(view.field().value).toBe("flaky")
      backend.failing = false
      act(() => view.sendButton().click())
      await view.settle()
      expect(backend.sent).toEqual([{ kind: null, text: "flaky" }])
      expect(view.button().textContent).toBe("Sent · thanks")
    })

    it("opens the card from the failed button, and goes idle when the note is emptied", async () => {
      const backend = fake()
      backend.failing = true
      const view = show(backend)
      await view.open()
      view.type("later")
      act(() => view.sendButton().click())
      await view.settle()
      act(() => view.card()!.querySelector<HTMLButtonElement>(".icon-button")!.click())
      await nextFrame()
      expect(view.card()).toBeNull()
      await view.open()
      expect(view.card()).not.toBeNull()
      expect(view.field().value).toBe("later")
      view.type("")
      expect(view.button().textContent).toBe("")
      expect(backend.sent).toEqual([])
    })

    it("sends a failed note again once the network is back", async () => {
      const backend = fake()
      backend.failing = true
      const view = show(backend)
      await view.open()
      view.type("offline")
      act(() => view.sendButton().click())
      await view.settle()
      backend.failing = false
      act(() => void window.dispatchEvent(new Event("online")))
      await view.settle()
      expect(backend.sent).toEqual([{ kind: null, text: "offline" }])
      expect(view.button().textContent).toBe("Sent · thanks")
    })

    it("holds the text box read-only while the note goes", async () => {
      let release = (): void => {}
      const view = show({
        ...fake(),
        send: () => new Promise<void>((resolve) => (release = resolve)),
      })
      await view.open()
      view.type("going")
      act(() => view.sendButton().click())
      expect(view.field().readOnly).toBe(true)
      release()
      await view.settle()
      expect(view.field().value).toBe("")
    })
  })
})
