import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { createStore } from "../../model/store"
import type { TerminalMetadata } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { terminalFixture } from "../../test/fixtures"
import { render, type Rendered } from "../../test/render"
import type { BackendConnectionState } from "../port"
import type { SurfaceRuntime } from "./backend"
import { createRunnerTerminal } from "./RunnerTerminal"

// jsdom has no layout observers, media queries or canvas; xterm falls back without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
})

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((page) => page.unmount()))

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

// A runtime whose shell is starting and never gets a stream, as while it respawns.
const starting = () => {
  const connection = createStore<BackendConnectionState>("connected")
  const entry = {
    ready: new Promise<boolean>(() => {}),
    revived: new Promise<void>(() => {}),
    closed: false,
    size: { cols: 80, rows: 24 },
  }
  const runtime: SurfaceRuntime = {
    entry: () => entry,
    attach: () => new Promise(() => {}),
    resized: () => {},
    attached: () => () => {},
    connected: async () => {},
    lost: () => {},
    restart: () => {},
    exited: () => {},
    connection,
    track: (work) => work,
    screen: () => {},
  }
  return { runtime, connection }
}

const show = (
  runtime: SurfaceRuntime,
  terminal: TerminalMetadata = { ...terminalFixture(1, "~"), state: "starting" },
) => {
  const Surface = createRunnerTerminal(runtime)
  const page = render(
    createElement(Surface, {
      terminalKey: key,
      terminal,
      projectName: "P",
      fontSize: 13,
      focusInput: false,
      onInputFocused: () => {},
    }),
  )
  mounted.push(page)
  return page
}

const input = (page: Rendered) => page.container.querySelector("[data-terminal-input]")!

// A surface whose shell ended as `terminal` says, recording the restarts it asks for.
const ended = (terminal: Partial<TerminalMetadata>) => {
  const { runtime, connection } = starting()
  const restarts: string[] = []
  const page = show({ ...runtime, restart: ({ terminalId }) => restarts.push(terminalId) }, {
    ...terminalFixture(1, "~"),
    ...terminal,
  } as TerminalMetadata)
  const bar = page.container.querySelector<HTMLElement>("[data-terminal-ending]")
  return { page, bar, restarts, connection }
}

describe("runner terminal surface", () => {
  context("while its shell has no stream yet", () => {
    it("refuses input where the person can see it", () => {
      const { runtime } = starting()
      const page = show(runtime)
      expect(input(page).getAttribute("aria-disabled")).toBe("true")
      expect(page.container.querySelector("[role=status]")?.textContent).toBe("Starting shell…")
    })
  })

  context("while the runner reconnects", () => {
    it("says so over the dimmed screen", () => {
      const { runtime, connection } = starting()
      const page = show(runtime)
      act(() => void connection.update(() => "reconnecting"))
      expect(page.container.querySelector("[role=status]")?.textContent).toBe("Reconnecting…")
    })
  })

  context("once its shell ended", () => {
    it("says how under its output, in honey for an exit code, and announces it", () => {
      const { bar } = ended({ state: "exited", exitCode: 3, signal: null })
      expect(bar?.dataset.terminalEnding).toBe("warning")
      // The announcer sits outside the bar, which is inert while hidden.
      const announcer = bar?.parentElement?.querySelector(":scope > [aria-live=polite]")
      expect(announcer?.textContent).toBe("Exited · code 3")
      expect(announcer?.closest("[inert]")).toBeNull()
      expect(bar?.querySelector("[title]")?.textContent).toBe("Exited · code 3")
    })

    it("names why it could not start, in rose", () => {
      const { bar } = ended({ state: "failed", message: "Folder not found" })
      expect(bar?.dataset.terminalEnding).toBe("danger")
      expect(bar?.querySelector("[title]")?.getAttribute("title")).toBe(
        "Failed to start · Folder not found",
      )
    })

    it("starts a fresh shell from its Restart button", () => {
      const { page, bar, restarts } = ended({ state: "exited", exitCode: null, signal: "SIGKILL" })
      act(() => bar!.querySelector("button")!.click())
      expect(restarts).toEqual(["01"])
      expect(input(page).getAttribute("aria-disabled")).toBe("false")
    })
  })

  context("once its shell ended while the runner is away", () => {
    it("holds Restart back until the runner is back", () => {
      const { bar, restarts, connection } = ended({ state: "exited", exitCode: 1, signal: null })
      act(() => void connection.update(() => "unavailable"))
      const button = bar!.querySelector("button")!
      expect(button.getAttribute("aria-disabled")).toBe("true")
      act(() => button.click())
      expect(restarts).toEqual([])
      act(() => void connection.update(() => "connected"))
      expect(button.hasAttribute("aria-disabled")).toBe(false)
      act(() => button.click())
      expect(restarts).toEqual(["01"])
    })
  })

  context("while its shell runs", () => {
    it("shows no ending", () => {
      const { runtime } = starting()
      const page = show(runtime)
      expect(page.container.querySelector("[data-terminal-ending]")).toBeNull()
    })
  })
})
