import { act, createElement } from "react"
import { afterEach } from "vitest"

import { SettleInTerminal } from "../../model/conversation"
import { describe, expect, it } from "../../test"
import { refusing } from "../../test/fixtures"
import { render } from "../../test/render"
import { Composer } from "./Composer"
import { composerState } from "./mode-state"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const show = (
  draft: string,
  sent: string[] = [],
  {
    send = async (text: string) => void sent.push(text),
    onOpenTerminal = () => {},
  }: {
    readonly send?: (text: string) => Promise<void>
    readonly onOpenTerminal?: () => void
  } = {},
): HTMLElement => {
  const { container, unmount } = render(
    createElement(Composer, {
      label: "Claude",
      draft,
      onDraft: () => {},
      mode: composerState(draft, null, [], true),
      sending: false,
      replySending: false,
      working: false,
      onSend: send,
      onStop: async () => {},
      focusInput: false,
      onInputFocused: () => {},
      onCancelReply: () => {},
      onOpenTerminal,
      // As the backend says of each text these cases give.
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
    expect(shell.querySelector(".chat-reply")?.textContent).toContain("Runs in Claude's shell")
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
      (each) => each.textContent === "Open terminal",
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
