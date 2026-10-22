import { itemFixture, terminalFixture } from "@novadeck/core/testing"
import type { Tile } from "@novadeck/core/types"
import { render } from "@novadeck/test-kit/render"
import { Portal } from "@novadeck/toolkit/Portal"
import { createElement } from "react"
import { afterEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { WindowShell, type WindowShellProps } from "./WindowShell"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const ignore = (): void => {}

const renderFrame = (terminal: Tile, extra: Partial<WindowShellProps> = {}): HTMLElement => {
  const props: WindowShellProps = {
    terminal,
    icon: null,
    children: null,
    rename: null,
    onBeginRename: ignore,
    onRenameDraft: ignore,
    onRenameSave: ignore,
    onRenameCancel: ignore,
    ...extra,
  }
  const { container, unmount } = render(createElement(WindowShell, props))
  unmounts.push(unmount)
  return container
}

describe("terminal frame header", () => {
  context("when the shell ended", () => {
    it("leaves how it ended to the terminal's own bar and names only the terminal", () => {
      const frame = renderFrame({
        ...terminalFixture(1, "~/p"),
        state: "exited",
        exitCode: 1,
        signal: null,
      })
      expect(frame.querySelector(".terminal-title")?.textContent).toBe("Terminal")
      expect(frame.querySelector("section")?.getAttribute("aria-label")).toBe("Terminal terminal")
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
    expect(button.getAttribute("aria-label")).toBe("Dictate into Terminal")
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

describe("terminal frame header and what a portal beside it holds", () => {
  it("ignores a double-click in a popover that only sits in its React tree", () => {
    const flown: string[] = []
    const inPortal = createElement(
      Portal,
      null,
      createElement("span", { id: "in-portal" }, "Offer"),
    )
    const frame = renderFrame(terminalFixture(1, "~/p"), {
      onFlyTo: () => void flown.push("fly"),
      titleExtra: inPortal,
    })

    document
      .querySelector("#in-portal")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    expect(flown).toEqual([])

    // The header itself still flies to the terminal.
    frame
      .querySelector(".terminal-actions")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    expect(flown).toEqual(["fly"])
  })
})

describe("terminal frame header and the name in it", () => {
  const nameOf = (frame: HTMLElement) => frame.querySelector("[data-terminal-name]")!
  const double = (element: Element) =>
    element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))

  it("starts a rename on a double-click on a terminal's name", () => {
    const calls: string[] = []
    const frame = renderFrame(terminalFixture(1, "~/p"), {
      onFlyTo: () => void calls.push("fly"),
      onBeginRename: () => void calls.push("rename"),
    })
    double(nameOf(frame))
    expect(calls).toEqual(["rename"])
  })

  it("leaves a double-click on the project window's name to the header's own action", () => {
    const calls: string[] = []
    const frame = renderFrame(
      {
        id: "pw",
        home: "project",
        itemId: itemFixture("readme", "01").id,
        name: "README.md",
        titleSource: { kind: "default" },
      },
      {
        onFlyTo: () => void calls.push("fly"),
        onBeginRename: () => void calls.push("rename"),
      },
    )
    double(nameOf(frame))
    expect(calls).toEqual(["fly"])
  })
})
