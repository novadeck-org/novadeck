import type {
  AgentFeedbackDraft,
  Feedback,
  FeedbackNote,
  FeedbackOutcome,
} from "@novadeck/core/feedback"
import { nextFrame, render, type Rendered } from "@novadeck/test-kit/render"
import { Bot } from "lucide-react"
import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { FeedbackButton } from "./FeedbackButton"

Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

const mounted: Rendered[] = []
const extra: HTMLElement[] = []
beforeEach(() => localStorage.clear())
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  extra.splice(0).forEach((each) => each.remove())
  localStorage.clear()
})

let counter = 0
const draftOf = (change: Partial<AgentFeedbackDraft> = {}): AgentFeedbackDraft => {
  counter += 1
  return {
    id: `draft-${counter}`,
    terminal: { projectId: "p", workspaceSessionId: "s", terminalId: `t${counter}` },
    handle: "owl",
    agent: "claude",
    kind: "bug",
    text: "It froze.",
    asked: false,
    at: counter,
    ...change,
  }
}

type Fake = Feedback & {
  readonly sent: FeedbackNote[]
  readonly settled: [string, FeedbackOutcome][]
  readonly push: (drafts: AgentFeedbackDraft[]) => void
  readonly release: () => void
  hold: boolean
  settleFails: boolean
}
const fake = (): Fake => {
  const sent: FeedbackNote[] = []
  const settled: [string, FeedbackOutcome][] = []
  let listener: ((drafts: readonly AgentFeedbackDraft[]) => void) | undefined
  let held: AgentFeedbackDraft[] = []
  const waiting: (() => void)[] = []
  const backend: Fake = {
    sent,
    settled,
    hold: false,
    settleFails: false,
    push: (drafts) => {
      held = drafts
      act(() => listener?.(drafts))
    },
    release: () => waiting.splice(0).forEach((resolve) => resolve()),
    about: () => Promise.resolve({ version: "0.15.0", os: "Linux x64" }),
    send: (note) => {
      sent.push(note)
      return backend.hold
        ? new Promise<void>((resolve) => waiting.push(resolve))
        : Promise.resolve()
    },
    ask: () => Promise.resolve(),
    drafts: {
      watch: (next) => {
        listener = next
        next(held)
        return () => (listener = undefined)
      },
      settle: (id, outcome) => {
        if (backend.settleFails) return Promise.reject(new Error("down"))
        settled.push([id, outcome])
        return Promise.resolve()
      },
    },
  }
  return backend
}

const show = (feedback: Fake = fake(), titleOf?: () => string | undefined) => {
  const page = render(
    createElement(FeedbackButton, {
      feedback,
      iconOf: () => Bot,
      ...(titleOf ? { titleOf } : {}),
    }),
  )
  mounted.push(page)
  const button = () => page.container.querySelector<HTMLButtonElement>(".feedback-button")!
  const card = () => document.querySelector<HTMLElement>(".feedback-card")
  const field = () => document.querySelector<HTMLTextAreaElement>(".feedback-input")!
  const sendButton = () => document.querySelector<HTMLButtonElement>(".feedback-send")!
  const discardButton = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".feedback-foot button")).find(
      (each) => each.textContent === "Discard",
    )
  const settle = async () => {
    await act(() => Promise.resolve())
    await nextFrame()
  }
  const type = (text: string) => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
      setter.call(field(), text)
      field().dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  const close = async () => {
    act(() => card()!.querySelector<HTMLButtonElement>(".icon-button")!.click())
    await nextFrame()
  }
  const caption = () => card()?.querySelector(".ask-agent-line")?.textContent
  const title = () => card()?.querySelector(".feedback-title")?.textContent
  const kindChecked = () =>
    card()?.querySelector<HTMLInputElement>('.feedback-kinds input[type="radio"]:checked')?.value
  return {
    feedback,
    button,
    card,
    field,
    sendButton,
    discardButton,
    settle,
    type,
    close,
    caption,
    title,
    kindChecked,
  }
}

// A stand-in for the terminal, which has the keystrokes.
const terminal = (): HTMLInputElement => {
  const input = document.createElement("input")
  document.body.append(input)
  extra.push(input)
  input.focus()
  return input
}

describe("an agent's draft in the feedback card", () => {
  context("when it arrives", () => {
    it("opens the card by itself without taking focus from the terminal", async () => {
      const typing = terminal()
      const view = show()
      view.feedback.push([draftOf()])
      await view.settle()
      await nextFrame()
      expect(view.card()).not.toBeNull()
      expect(view.button().getAttribute("aria-expanded")).toBe("true")
      expect(document.activeElement).toBe(typing)
      // A click on the button, closed and opened again by the person, takes focus in.
      await view.close()
      act(() => view.button().click())
      await view.settle()
      await nextFrame()
      expect(document.activeElement).toBe(view.field())
    })

    it("presets the kind and fills the text with what feedback-scrub struck replaced", async () => {
      const view = show()
      view.feedback.push([
        draftOf({ kind: "idea", text: "Saw it in ~/Work/app/a.ts and mail me@mail.dev" }),
      ])
      await view.settle()
      expect(view.kindChecked()).toBe("idea")
      expect(view.field().value).toBe("Saw it in [path] and mail [email]")
      expect(view.card()!.querySelector(".feedback-scrubbed")!.textContent).toBe(
        "Replaced 1 home path and 1 email address.",
      )
    })

    it("says nothing of a replacement when nothing was", async () => {
      const view = show()
      view.feedback.push([draftOf()])
      await view.settle()
      expect(view.card()!.querySelector(".feedback-scrubbed")).toBeNull()
    })

    it("heads the card with the agent's mark and handle, and offers Discard for the issues link", async () => {
      const view = show()
      view.feedback.push([draftOf({ handle: "owl" })])
      await view.settle()
      expect(view.title()).toBe("Feedback from @owl")
      expect(view.card()!.querySelector(".feedback-title svg")).not.toBeNull()
      expect(view.card()!.querySelector(".handle-chip")!.getAttribute("data-terminal-handle")).toBe(
        "owl",
      )
      expect(view.discardButton()).toBeDefined()
      expect(view.card()!.querySelector(".feedback-link")).toBeNull()
    })

    it("words the caption for each case, and drops the window once it is gone", async () => {
      const cases: [Partial<AgentFeedbackDraft>, string | undefined, string][] = [
        [{ asked: true }, "Refactor auth", "The feedback you asked for."],
        [{ kind: "bug" }, "Refactor auth", "A possible Novadeck bug, from “Refactor auth”."],
        [{ kind: "idea" }, "Refactor auth", "An idea for Novadeck, from “Refactor auth”."],
        [{ kind: "other" }, "Refactor auth", "A note about Novadeck, from “Refactor auth”."],
        [{ kind: "bug" }, undefined, "A possible Novadeck bug."],
        [{ asked: true }, undefined, "The feedback you asked for."],
      ]
      for (const [change, windowTitle, words] of cases) {
        const view = show(fake(), () => windowTitle)
        view.feedback.push([draftOf(change)])
        // eslint-disable-next-line no-await-in-loop -- Each case is its own card.
        await view.settle()
        expect(view.caption()).toBe(words)
        mounted.pop()!.unmount()
      }
    })

    it("opens for an asked draft the same way", async () => {
      const view = show()
      view.feedback.push([draftOf({ asked: true })])
      await view.settle()
      expect(view.card()).not.toBeNull()
    })
  })

  context("when it is sent or discarded", () => {
    it("sends the person's edited text and kind, then settles it as sent and clears the card", async () => {
      const view = show()
      const draft = draftOf()
      view.feedback.push([draft])
      await view.settle()
      view.type("It froze for a while.")
      act(() => view.sendButton().click())
      await view.settle()
      expect(view.feedback.sent).toEqual([{ kind: "bug", text: "It froze for a while." }])
      expect(view.feedback.settled).toEqual([[draft.id, "sent"]])
      expect(view.card()).toBeNull()
      expect(view.button().textContent).toContain("Sent")
      // The listing then drops it: nothing comes back.
      view.feedback.push([])
      await view.settle()
      expect(view.card()).toBeNull()
    })

    it("keeps the draft and says why when the note could not go, and settles nothing", async () => {
      const view = show()
      view.feedback.push([draftOf()])
      await view.settle()
      vi.spyOn(view.feedback, "send").mockRejectedValueOnce(new Error("offline"))
      act(() => view.sendButton().click())
      await view.settle()
      expect(view.card()!.querySelector(".feedback-failed")).not.toBeNull()
      expect(view.field().value).toBe("It froze.")
      expect(view.feedback.settled).toEqual([])
      // Retried, it goes and settles.
      act(() => view.sendButton().click())
      await view.settle()
      expect(view.feedback.settled).toHaveLength(1)
    })

    it("sends nothing on the network's return after a failed send whose draft was replaced", async () => {
      const view = show()
      const first = draftOf({ text: "First" })
      view.feedback.push([first])
      await view.settle()
      const send = vi.spyOn(view.feedback, "send").mockRejectedValueOnce(new Error("offline"))
      act(() => view.sendButton().click())
      await view.settle()
      expect(view.button().textContent).toContain("Not sent")
      // A newer draft from the same terminal replaces it.
      const second = draftOf({ terminal: first.terminal, text: "Second" })
      view.feedback.push([second])
      await view.settle()
      expect(view.field().value).toBe("Second")
      expect(view.button().textContent).not.toContain("Not sent")
      expect(view.button().textContent).toContain("Draft from @owl")
      expect(view.card()!.querySelector(".feedback-failed")).toBeNull()
      act(() => void window.dispatchEvent(new Event("online")))
      await view.settle()
      expect(send).toHaveBeenCalledTimes(1)
      expect(view.feedback.sent).toEqual([])
    })

    it("sends nothing on the network's return after a failed send whose draft left", async () => {
      const view = show()
      view.feedback.push([draftOf()])
      await view.settle()
      const send = vi.spyOn(view.feedback, "send").mockRejectedValueOnce(new Error("offline"))
      act(() => view.sendButton().click())
      await view.settle()
      view.feedback.push([])
      await view.settle()
      expect(view.button().textContent).not.toContain("Not sent")
      act(() => void window.dispatchEvent(new Event("online")))
      await view.settle()
      expect(send).toHaveBeenCalledTimes(1)
      expect(view.feedback.sent).toEqual([])
    })

    it("sends the note once when Send is pressed again while it is on its way", async () => {
      const view = show()
      view.feedback.hold = true
      view.feedback.push([draftOf()])
      await view.settle()
      act(() => view.sendButton().click())
      act(() => view.sendButton().click())
      view.feedback.release()
      await view.settle()
      expect(view.feedback.sent).toHaveLength(1)
      expect(view.feedback.settled).toHaveLength(1)
    })

    it("sends the note once when the card is made again while the first is on its way", async () => {
      const first = show()
      first.feedback.hold = true
      const draft = draftOf()
      first.feedback.push([draft])
      await first.settle()
      act(() => first.sendButton().click())
      // The backend was made again: another card over its feedback, holding the same draft.
      const again = fake()
      again.hold = true
      const second = show(again)
      again.push([draft])
      await second.settle()
      act(() => second.sendButton().click())
      first.feedback.release()
      again.release()
      await first.settle()
      expect(first.feedback.sent.length + again.sent.length).toBe(1)
      expect(first.feedback.settled.length + again.settled.length).toBe(1)
    })

    it("settles a note that went but whose settle failed again with the next listing, never sending twice", async () => {
      const view = show()
      const draft = draftOf()
      view.feedback.settleFails = true
      view.feedback.push([draft])
      await view.settle()
      act(() => view.sendButton().click())
      await view.settle()
      expect(view.feedback.sent).toHaveLength(1)
      expect(view.card()).toBeNull()
      view.feedback.settleFails = false
      view.feedback.push([draft])
      await view.settle()
      expect(view.feedback.settled).toEqual([[draft.id, "sent"]])
      expect(view.card()).toBeNull()
      expect(view.feedback.sent).toHaveLength(1)
    })

    it("discards: settles it as discarded, clears the card and closes it", async () => {
      const view = show()
      const draft = draftOf()
      view.feedback.push([draft])
      await view.settle()
      act(() => view.discardButton()!.click())
      await view.settle()
      expect(view.feedback.settled).toEqual([[draft.id, "discarded"]])
      expect(view.feedback.sent).toEqual([])
      expect(view.card()).toBeNull()
      expect(view.button().textContent).not.toContain("Draft from")
    })
  })

  context("when the card is closed", () => {
    it("keeps the draft, says so on the button, and shows it again when clicked", async () => {
      const view = show()
      view.feedback.push([draftOf({ handle: "owl" })])
      await view.settle()
      view.type("edited")
      await view.close()
      expect(view.card()).toBeNull()
      expect(view.button().textContent).toContain("Draft from @owl")
      expect(view.button().getAttribute("data-send")).toBe("draft")
      act(() => view.button().click())
      await view.settle()
      expect(view.field().value).toBe("edited")
      expect(view.title()).toBe("Feedback from @owl")
    })

    it("does not open again by itself for a listing that changes nothing about it", async () => {
      const view = show()
      const draft = draftOf()
      view.feedback.push([draft])
      await view.settle()
      await view.close()
      view.feedback.push([draft])
      await view.settle()
      expect(view.card()).toBeNull()
    })
  })

  context("with the person's own note in the card", () => {
    it("never overwrites it, and leaves the card shut, the button saying a draft waits", async () => {
      const view = show()
      act(() => view.button().click())
      await view.settle()
      view.type("my own note")
      await view.close()
      view.feedback.push([draftOf({ handle: "fox" })])
      await view.settle()
      expect(view.card()).toBeNull()
      expect(view.button().textContent).toContain("Draft from @fox")
      act(() => view.button().click())
      await view.settle()
      expect(view.field().value).toBe("my own note")
      expect(view.title()).toBe("Send feedback")
      expect(view.discardButton()).toBeUndefined()
    })

    it("opens the draft once their note is sent", async () => {
      const view = show()
      act(() => view.button().click())
      await view.settle()
      view.type("my own note")
      view.feedback.push([draftOf({ text: "Agent's words." })])
      await view.settle()
      expect(view.field().value).toBe("my own note")
      act(() => view.sendButton().click())
      await view.settle()
      expect(view.feedback.sent).toEqual([{ kind: null, text: "my own note" }])
      expect(view.feedback.settled).toEqual([])
      expect(view.field().value).toBe("Agent's words.")
      expect(view.title()).toBe("Feedback from @owl")
    })

    it("opens the draft once their note is emptied", async () => {
      const view = show()
      act(() => view.button().click())
      await view.settle()
      view.type("my own note")
      view.feedback.push([draftOf({ text: "Agent's words." })])
      await view.settle()
      view.type("")
      await view.settle()
      expect(view.field().value).toBe("Agent's words.")
    })
  })

  context("with more than one draft", () => {
    it("shows the oldest first, and the next opens by itself after a send or a discard", async () => {
      const typing = terminal()
      const view = show()
      const [a, b, c] = [draftOf({ text: "A" }), draftOf({ text: "B" }), draftOf({ text: "C" })]
      view.feedback.push([a, b, c])
      await view.settle()
      expect(view.field().value).toBe("A")
      act(() => view.sendButton().click())
      await view.settle()
      view.feedback.push([b, c])
      await view.settle()
      expect(view.card()).not.toBeNull()
      expect(view.field().value).toBe("B")
      expect(document.activeElement).toBe(typing)
      act(() => view.discardButton()!.click())
      await view.settle()
      view.feedback.push([c])
      await view.settle()
      expect(view.field().value).toBe("C")
      expect(view.feedback.settled).toEqual([
        [a.id, "sent"],
        [b.id, "discarded"],
      ])
    })
  })

  context("when a draft leaves the listing", () => {
    it("clears the card and closes it when the person had not changed it", async () => {
      const view = show()
      view.feedback.push([draftOf()])
      await view.settle()
      view.feedback.push([])
      await view.settle()
      expect(view.card()).toBeNull()
      expect(view.button().textContent).not.toContain("Draft from")
    })

    it("moves on to the newer draft of the same terminal that replaced it", async () => {
      const view = show()
      const old = draftOf({ text: "Old" })
      const other = draftOf({ text: "Other" })
      view.feedback.push([old, other])
      await view.settle()
      expect(view.field().value).toBe("Old")
      const fresh = draftOf({ terminal: old.terminal, text: "Fresh" })
      view.feedback.push([other, fresh])
      await view.settle()
      expect(view.field().value).toBe("Fresh")
    })

    it("keeps what the person changed as their own note, with no agent head", async () => {
      const view = show()
      view.feedback.push([draftOf()])
      await view.settle()
      view.type("My version of it")
      view.feedback.push([])
      await view.settle()
      expect(view.card()).not.toBeNull()
      expect(view.field().value).toBe("My version of it")
      expect(view.title()).toBe("Send feedback")
      expect(view.discardButton()).toBeUndefined()
      act(() => view.sendButton().click())
      await view.settle()
      expect(view.feedback.sent).toEqual([{ kind: "bug", text: "My version of it" }])
      expect(view.feedback.settled).toEqual([])
    })
  })

  it("leaves the card alone where the backend has no drafts", async () => {
    const view = show({ ...fake(), drafts: undefined } as unknown as Fake)
    act(() => view.button().click())
    await view.settle()
    expect(view.title()).toBe("Send feedback")
  })
})
