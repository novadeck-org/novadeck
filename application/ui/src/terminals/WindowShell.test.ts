import { createElement } from "react"
import { afterEach } from "vitest"

import type { TerminalMetadata } from "../model/types"
import { context, describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import { render } from "../test/render"
import { WindowShell, type WindowShellProps } from "./WindowShell"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const ignore = (): void => {}

const renderFrame = (
  terminal: TerminalMetadata,
  extra: Partial<WindowShellProps> = {},
): HTMLElement => {
  const props: WindowShellProps = {
    ...extra,
    terminal,
    icon: null,
    children: null,
    rename: null,
    onBeginRename: ignore,
    onRenameDraft: ignore,
    onRenameSave: ignore,
    onRenameCancel: ignore,
  }
  const { container, unmount } = render(createElement(WindowShell, props))
  unmounts.push(unmount)
  return container
}

const chatButton = (frame: HTMLElement): HTMLButtonElement | null =>
  frame.querySelector('button[aria-label="Chat view: Terminal 01"]')

describe("terminal frame header", () => {
  context("when the shell ended", () => {
    it("leaves how it ended to the terminal's own bar and names only the terminal", () => {
      const frame = renderFrame({
        ...terminalFixture(1, "~/p"),
        state: "exited",
        exitCode: 1,
        signal: null,
      })
      expect(frame.querySelector(".terminal-title")?.textContent).toBe("Terminal 01")
      expect(frame.querySelector("section")?.getAttribute("aria-label")).toBe(
        "Terminal 01 terminal",
      )
    })
  })

  context("when its agent has a conversation", () => {
    it("offers the chat as a toggle that says whether it shows", () => {
      const toggles: string[] = []
      const frame = renderFrame(terminalFixture(1, "~/p"), {
        chat: { on: true, onToggle: () => toggles.push("toggle") },
      })
      expect(chatButton(frame)?.getAttribute("aria-pressed")).toBe("true")
      chatButton(frame)!.click()
      expect(toggles).toEqual(["toggle"])
    })

    it("offers nothing where there is none", () => {
      expect(chatButton(renderFrame(terminalFixture(1, "~/p")))).toBeNull()
    })
  })
})

const mic = (frame: HTMLElement): HTMLButtonElement | null =>
  frame.querySelector<HTMLButtonElement>('button[aria-label^="Dictate into"]')

describe("terminal frame mic button", () => {
  it("is absent unless the window is given dictation controls", () => {
    expect(mic(renderFrame(terminalFixture(1, "~/p")))).toBeNull()
  })

  it("shows as an unpressed toggle named for the terminal, and starts dictation on click", () => {
    const calls: string[] = []
    const frame = renderFrame(terminalFixture(1, "~/p"), {
      dictation: { recording: false, onToggle: () => void calls.push("toggle") },
    })
    const button = mic(frame)!
    expect(button.getAttribute("aria-label")).toBe("Dictate into Terminal 01")
    expect(button.getAttribute("aria-pressed")).toBe("false")
    button.click()
    expect(calls).toEqual(["toggle"])
  })

  it("shows as pressed while its terminal records", () => {
    const frame = renderFrame(terminalFixture(1, "~/p"), {
      dictation: { recording: true, onToggle: ignore },
    })
    expect(mic(frame)!.getAttribute("aria-pressed")).toBe("true")
    expect(mic(frame)!.classList.contains("dictation-active")).toBe(true)
  })
})
