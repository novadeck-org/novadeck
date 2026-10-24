import { itemFixture, terminalFixture } from "@novadeck/core/testing"
import type { AgentWaiting, Tile } from "@novadeck/core/types"
import { render } from "@novadeck/test-kit/render"
import { Portal } from "@novadeck/toolkit/Portal"
import { createElement } from "react"
import { afterEach, vi } from "vitest"

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

// An agent in its own terminal, its turn over, waiting as given.
const waiting = (agentWaiting: AgentWaiting): Tile => ({
  ...terminalFixture(1, "~/p"),
  state: "running",
  process: "claude",
  agent: { working: false, waiting: agentWaiting },
})

describe("terminal frame bar", () => {
  context("while the agent waits on a job it started", () => {
    const frame = () =>
      renderFrame(
        waiting({
          jobs: [
            {
              id: "j",
              description: "Watch CI checks for PR #436",
              command: "gh pr checks 436 --watch",
              since: Date.now() - 4 * 60_000,
              until: null,
            },
          ],
          wake: null,
        }),
      )

    it("reads waiting, minutes first and then the agent's own description", async () => {
      const window = frame()
      expect(window.querySelector("section")?.getAttribute("data-terminal-phase")).toBe("waiting")
      // Its words load when an agent waits.
      await vi.waitFor(() =>
        expect(window.querySelector(".window-wait")?.textContent).toBe(
          "4m·Watch CI checks for PR #436",
        ),
      )
    })

    it("says it in words to assistive technology", () => {
      expect(frame().querySelector("section")?.getAttribute("aria-description")).toBe(
        "Waiting on Watch CI checks for PR #436, 4 minutes",
      )
    })

    it("leaves the compact tiles of Grid and Canvas to their own look", () => {
      const tile = renderFrame(
        waiting({
          jobs: [
            { id: "j", description: null, command: "sleep 600", since: Date.now(), until: null },
          ],
          wake: null,
        }),
        { compact: true },
      )
      expect(tile.querySelector(".window-wait")).toBeNull()
    })
  })

  context("while the agent waits for a wake-up", () => {
    it("names its time and counts down to it", async () => {
      const at = Date.now() + 8 * 60_000 + 14_000
      const window = renderFrame(waiting({ jobs: [], wake: { at, reason: "Check the deploy" } }))
      await vi.waitFor(() =>
        expect(window.querySelector(".window-wait")?.textContent).toMatch(
          /^wakes at \d\d:\d\d · in 8:1\d$/,
        ),
      )
    })
  })

  context("once the wake-up has passed with no new turn", () => {
    it("reads idle again", () => {
      const window = renderFrame(
        waiting({ jobs: [], wake: { at: Date.now() - 10 * 60_000, reason: null } }),
      )
      expect(window.querySelector("section")?.getAttribute("data-terminal-phase")).toBe("idle")
      expect(window.querySelector(".window-wait")).toBeNull()
    })
  })
})
