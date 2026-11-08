import { SettleInTerminal, type ChatBox } from "@novadeck/core/conversation"
import { refusing } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement, useState } from "react"
import { afterEach } from "vitest"

import { boxNote, Composer } from "./Composer"
import { composerMode } from "./composer-mode"
import { describe, expect, it } from "./test"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const show = (
  draft: string,
  sent: string[] = [],
  {
    send = async (text: string) => void sent.push(text),
    onOpenTerminal = () => {},
    box = null,
    clearBox = async () => {},
    working = false,
  }: {
    readonly send?: (text: string) => Promise<void>
    readonly clearBox?: (seen: string) => Promise<void>
    readonly onOpenTerminal?: () => void
    readonly box?: ChatBox | null
    readonly working?: boolean
  } = {},
): HTMLElement => {
  const { container, unmount } = render(
    createElement(Composer, {
      label: "Claude",
      box,
      passing: false,
      onPress: () => false,
      draft,
      onDraft: () => {},
      mode: composerMode(draft, null, [], true),
      sending: false,
      replySending: false,
      working,
      onSend: send,
      onStop: async () => {},
      onClearBox: clearBox,
      focusInput: false,
      onInputFocused: () => {},
      onCancelReply: () => {},
      onOpenTerminal,
      // As the backend says of each text these cases give.
      history: [],
      refused: refusing("ask @alice ", "!", "!echo $", "hi\f"),
    }),
  )
  unmounts.push(unmount)
  return container
}

describe("the composer's warning about a message the agent would read as a command", () => {
  it("is a status the box is described by, with Send held back", () => {
    const container = show("ask @alice ")
    const hint = container.querySelector('[role="status"]')!
    expect(hint.textContent).toContain("Can't start with /")
    expect(container.querySelector("textarea")?.getAttribute("aria-describedby")).toBe(hint.id)
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(
      true,
    )
  })

  it("lets a shell command go, saying where it runs, and waits for a command after a lone !", () => {
    const shell = show("! git status")
    expect(shell.querySelector(".sr-only")?.textContent).toContain("Runs in Claude's shell")
    expect(shell.querySelector('[role="status"]')?.textContent).toBe("")
    expect(shell.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(
      false,
    )
    const lone = show("!")
    expect(lone.querySelector('[role="status"]')?.textContent).toBe("")
    expect(lone.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(true)
    const picker = show("!echo $")
    expect(picker.querySelector('[role="status"]')?.textContent).toContain("A shell command can't")
  })

  it("is absent for an ordinary message", () => {
    const container = show("ask alice")
    // The status is always there, empty, for a reader to announce what appears in it.
    expect(container.querySelector('[role="status"]')?.textContent).toBe("")
  })

  it("keeps Enter from sending what the warning holds back, a control character at an end included", () => {
    const sent: string[] = []
    const container = show("hi\f", sent)
    expect(container.querySelector('[role="status"]')?.textContent).not.toBe("")
    const box = container.querySelector("textarea")!
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(sent).toEqual([])
  })
})

describe("the composer's failed send", () => {
  it("says why, and offers the terminal where the person settles it there", async () => {
    const opened: string[] = []
    const container = show("go", [], {
      send: async () => {
        throw new SettleInTerminal("The agent's input box already holds text.")
      },
      onOpenTerminal: () => opened.push("terminal"),
    })
    await act(
      async () =>
        void container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
    )
    const alert = container.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain("already holds text")
    const open = [...alert.querySelectorAll("button")].find(
      (each) => each.getAttribute("aria-label") === "Open terminal",
    )!
    act(() => open.click())
    expect(opened).toEqual(["terminal"])
  })

  it("offers nothing more for a failure that clears by itself", async () => {
    const container = show("go", [], {
      send: async () => {
        throw new Error("Send again in a moment.")
      },
    })
    await act(
      async () =>
        void container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Send again in a moment.")
    expect(container.querySelector('[role="alert"] button')).toBeNull()
  })
})

describe("what the agent's own box holds", () => {
  const box = (over: Partial<ChatBox> = {}): ChatBox => ({
    text: "half a thought",
    mode: "prompt",
    tail: false,
    known: false,
    ...over,
  })

  it("shows over the composer, with what happens to it, its end marked when that's all it is", () => {
    const whole = show("", [], { box: box() })
    expect(whole.querySelector(".chat-box")?.textContent).toContain("half a thought")
    expect(whole.querySelector(".chat-box")?.textContent).toContain("goes with your next message")
    const end = show("", [], { box: box({ tail: true }) })
    expect(end.querySelector(".chat-box-text")?.textContent).toBe("…half a thought")
  })

  it("marks a command, which nothing is sent over", () => {
    expect(
      show("", [], { box: box({ text: "/model" }) })
        .querySelector(".chat-box")
        ?.hasAttribute("data-refused"),
    ).toBe(true)
    expect(
      show("", [], { box: box() }).querySelector(".chat-box")?.hasAttribute("data-refused"),
    ).toBe(false)
    // Only the end of it shows: what starts that end needn't start the input.
    const tail = box({ text: "/usr/lib", tail: true })
    expect(
      show("", [], { box: tail }).querySelector(".chat-box")?.hasAttribute("data-refused"),
    ).toBe(false)
    const shell = box({ text: "!ls", mode: "shell" })
    expect(
      show("", [], { box: shell }).querySelector(".chat-box")?.hasAttribute("data-refused"),
    ).toBe(false)
  })

  it("shows nothing where the box holds nothing", () => {
    expect(show("").querySelector(".chat-box")).toBeNull()
  })

  it("clears the box as the person asks, and says where it didn't", async () => {
    const asked: string[] = []
    const shown = show("", [], {
      box: box({ text: "/model" }),
      clearBox: async (seen) => {
        asked.push(seen)
        throw new SettleInTerminal("That didn't clear the agent's input box.")
      },
    })
    const clear = shown.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear Claude\'s terminal input"]',
    )!
    await act(async () => void clear.click())
    expect(asked).toEqual(["/model"])
    expect(shown.textContent).toContain("That didn't clear")
    expect(clear.disabled).toBe(false)
  })

  it("says what becomes of each kind of text", () => {
    expect(boxNote("Claude", box({ tail: true }))).toContain("ends with this")
    // Its words known, but it may hold more, so it doesn't come back: nothing takes such a box.
    expect(boxNote("Claude", box({ tail: true, known: true }))).toContain("ends with this")
    expect(boxNote("Claude", box({ known: true }))).toContain("comes back here")
    expect(boxNote("Claude", box({ mode: "shell" }))).toContain("shell mode")
    expect(boxNote("Claude", box({ text: "/model" }))).toContain("Clear it to send here")
  })
})

describe("the prompt", () => {
  const key = (container: HTMLElement, name: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)

  it("has the person's mark, and Send only with a draft", () => {
    expect(show("").querySelector(".chat-composer-box .chat-mark")).not.toBeNull()
    expect(key(show(""), "Send")).toBeNull()
    expect(key(show("hello"), "Send")?.textContent).toBe("⏎")
  })

  it("has Stop only while the agent works", () => {
    expect(key(show(""), "Stop")).toBeNull()
    expect(key(show("", [], { working: true }), "Stop")?.textContent).toBe("stop")
  })

  it("says it is in shell mode, with the sentence for a screen reader", () => {
    const shell = show("! git status")
    expect(shell.querySelector(".chat-composer")?.getAttribute("data-mode")).toBe("shell")
    expect(shell.querySelector(".chat-composer-actions")?.textContent).toContain("shell")
    const said = shell.querySelector("textarea")?.getAttribute("aria-describedby")?.split(" ")
    const sentence = shell.querySelector(".sr-only")
    expect(sentence?.textContent).toContain("Runs in Claude's shell")
    expect(said).toContain(sentence?.id)
    expect(show("hello").querySelector(".chat-composer")?.getAttribute("data-mode")).toBe("message")
  })

  it("keeps focus in the box as Send goes with the words", async () => {
    const shown = show("hello", [], { send: async () => {} })
    await act(async () => key(shown, "Send")!.click())
    expect(document.activeElement).toBe(shown.querySelector("textarea"))
  })
})

// A composer whose draft is kept as the app keeps it, with the history Up and Down walk.
const walking = (history: readonly string[], start = ""): HTMLTextAreaElement => {
  const Kept = (): React.JSX.Element => {
    const [draft, setDraft] = useState(start)
    return createElement(Composer, {
      label: "Claude",
      box: null,
      passing: false,
      onPress: () => false,
      draft,
      onDraft: setDraft,
      mode: composerMode(draft, null, [], true),
      sending: false,
      replySending: false,
      working: false,
      onSend: async () => {},
      onStop: async () => {},
      onClearBox: async () => {},
      focusInput: false,
      onInputFocused: () => {},
      onCancelReply: () => {},
      onOpenTerminal: () => {},
      refused: () => false,
      history,
    })
  }
  const { container, unmount } = render(createElement(Kept))
  unmounts.push(unmount)
  return container.querySelector("textarea")!
}

const press = async (
  field: HTMLTextAreaElement,
  key: string,
  init: KeyboardEventInit = {},
): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
  await act(async () => void field.dispatchEvent(event))
  return event
}

describe("the composer's history", () => {
  it("recalls earlier prompts with Up, newest first, the caret at the end", async () => {
    const field = walking(["first", "second"])
    const event = await press(field, "ArrowUp")
    expect(event.defaultPrevented).toBe(true)
    expect(field.value).toBe("second")
    expect(field.selectionStart).toBe(6)
    await press(field, "ArrowUp")
    expect(field.value).toBe("first")
    expect((await press(field, "ArrowUp")).defaultPrevented).toBe(false)
    expect(field.value).toBe("first")
  })

  it("walks back with Down and ends on the words that were being typed", async () => {
    const field = walking(["first", "second"], "draft so far")
    field.setSelectionRange(0, 0)
    await press(field, "ArrowUp")
    await press(field, "ArrowUp")
    await press(field, "ArrowDown")
    expect(field.value).toBe("second")
    await press(field, "ArrowDown")
    expect(field.value).toBe("draft so far")
    expect((await press(field, "ArrowDown")).defaultPrevented).toBe(false)
  })

  it("keeps walking from a caret anywhere while the recalled prompt is unedited", async () => {
    const field = walking(["old", "a long\nrecalled prompt"])
    await press(field, "ArrowUp")
    field.setSelectionRange(9, 9)
    await press(field, "ArrowUp")
    expect(field.value).toBe("old")
    field.setSelectionRange(1, 1)
    await press(field, "ArrowDown")
    expect(field.value).toBe("a long\nrecalled prompt")
  })

  it("starts only from the start of the box, so a long draft's rows keep their Up", async () => {
    const field = walking(["old"], "a long draft that wraps onto a second row of the box")
    field.setSelectionRange(30, 30)
    expect((await press(field, "ArrowUp")).defaultPrevented).toBe(false)
    expect(field.value).toBe("a long draft that wraps onto a second row of the box")
    field.setSelectionRange(0, 4)
    expect((await press(field, "ArrowUp")).defaultPrevented).toBe(false)
    field.setSelectionRange(0, 0)
    expect((await press(field, "ArrowUp")).defaultPrevented).toBe(true)
    expect(field.value).toBe("old")
  })

  it("ends the walk with an edit, which the next Up then starts from", async () => {
    const field = walking(["old", "newer"])
    await press(field, "ArrowUp")
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
      set.call(field, "newer!")
      field.dispatchEvent(new Event("input", { bubbles: true }))
    })
    field.setSelectionRange(3, 3)
    expect((await press(field, "ArrowUp")).defaultPrevented).toBe(false)
    expect((await press(field, "ArrowDown")).defaultPrevented).toBe(false)
    expect(field.value).toBe("newer!")
  })

  it("leaves a modified Up, and Up during IME composition, alone", async () => {
    const field = walking(["old"])
    await press(field, "ArrowUp", { shiftKey: true })
    await press(field, "ArrowUp", { altKey: true })
    await press(field, "ArrowUp", { isComposing: true })
    expect(field.value).toBe("")
  })

  it("does nothing with no history", async () => {
    const field = walking([])
    expect((await press(field, "ArrowUp")).defaultPrevented).toBe(false)
  })
})
