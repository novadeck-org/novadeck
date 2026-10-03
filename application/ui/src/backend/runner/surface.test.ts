import type { AttachedTerminal } from "@novadeck/protocol/client"
import { Terminal } from "@xterm/xterm"
import { act, createElement, type ReactNode } from "react"
import { afterEach, vi } from "vitest"

import { createStore } from "../../model/store"
import type { TerminalMetadata } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { terminalFixture } from "../../test/fixtures"
import { render, type Rendered } from "../../test/render"
import { themeChangeEvent } from "../../theme/apply"
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
// A screen closes a moment after its last surface goes; it closes here instead, while
// the file's DOM is still there to take its listeners off.
afterEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  try {
    mounted.splice(0).forEach((page) => page.unmount())
    vi.runOnlyPendingTimers()
  } finally {
    vi.useRealTimers()
  }
})

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
    shown: () => false,
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
      renderWindow: (content) => content,
    }),
  )
  mounted.push(page)
  return page
}

const input = (page: Rendered) =>
  page.container.querySelector<HTMLTextAreaElement>("[data-terminal-input]")!

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

// Two programs' bodies, each its own component, so switching remounts the content.
const Agent = (props: { children: ReactNode }) => createElement("section", props)
const Plain = (props: { children: ReactNode }) => createElement("article", props)

describe("runner terminal surface", () => {
  it("keeps one live xterm, its output and focus while the body around it changes", async () => {
    const { runtime } = starting()
    const views: Terminal[] = []
    const originalOpen = Terminal.prototype.open
    const open = vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element,
    ) {
      views.push(this)
      return originalOpen.call(this, element)
    })
    const attachment: AttachedTerminal = {
      id: "01",
      mode: "control",
      [Symbol.asyncIterator]: () => attachment,
      next: vi
        .fn<AttachedTerminal["next"]>()
        .mockResolvedValueOnce({
          value: {
            terminalId: "01",
            sequence: 1,
            type: "snapshot",
            cols: 80,
            rows: 24,
            data: "hello from the same shell\r\n",
            exit: null,
          },
          done: false,
        })
        .mockImplementation(() => new Promise(() => {})),
      return: async () => ({ value: undefined, done: true as const }),
      write: async () => {},
      resize: async () => {},
      detach: async () => {},
    }
    const attach = vi.fn<SurfaceRuntime["attach"]>(async () => attachment)
    const screen = vi.fn<SurfaceRuntime["screen"]>()
    const Surface = createRunnerTerminal({
      ...runtime,
      entry: () => ({
        ready: Promise.resolve(true),
        revived: new Promise<void>(() => {}),
        closed: false,
        size: { cols: 80, rows: 24 },
      }),
      attach,
      screen,
    })
    const external = document.createElement("button")
    external.textContent = "Outside"
    document.body.append(external)
    // Each program's body is its own component, so switching remounts the content inside it.
    const bodies = {
      terminal: (props: { children: ReactNode }) => createElement("section", props),
      claude: (props: { children: ReactNode }) =>
        createElement("section", { "data-body": "claude", ...props }),
      codex: (props: { children: ReactNode }) =>
        createElement("section", { "data-body": "codex", ...props }),
    }
    const props = (body: keyof typeof bodies) =>
      createElement(Surface, {
        terminalKey: key,
        terminal: { ...terminalFixture(1, "~"), state: "running" },
        projectName: "P",
        fontSize: 13,
        focusInput: false,
        onInputFocused: () => {},
        renderWindow: (content) => createElement(bodies[body], null, content),
      })
    try {
      const page = render(props("terminal"))
      mounted.push(page)
      await vi.waitFor(() =>
        expect(views[0]?.buffer.active.getLine(0)?.translateToString()).toContain(
          "hello from the same shell",
        ),
      )
      const textarea = input(page)
      const xterm = page.container.querySelector(".xterm")
      const content = page.container.querySelector("[data-terminal-content]")
      act(() => textarea.focus())
      expect(document.activeElement).toBe(textarea)

      page.rerender(props("claude"))
      expect(page.container.querySelector("[data-terminal-content]")).not.toBe(content)
      expect(page.container.querySelector("[data-body=claude]")?.contains(xterm)).toBe(true)
      expect(input(page)).toBe(textarea)
      expect(document.activeElement).toBe(textarea)
      page.rerender(props("codex"))
      expect(page.container.querySelector("[data-body=codex]")?.contains(xterm)).toBe(true)
      expect(document.activeElement).toBe(textarea)

      act(() => external.focus())
      page.rerender(props("terminal"))
      expect(document.activeElement).toBe(external)
      expect(input(page)).toBe(textarea)
      expect(page.container.querySelectorAll(".xterm")).toHaveLength(1)
      expect(views[0]?.buffer.active.getLine(0)?.translateToString()).toContain(
        "hello from the same shell",
      )
      expect(attach).toHaveBeenCalledTimes(1)
      expect(screen.mock.calls.map((call) => call[1])).toEqual(["mounted", "shown"])
    } finally {
      open.mockRestore()
      external.remove()
    }
  })

  context("when a view switch mounts it in another place", () => {
    // A live stream that drew one line and then waits, and a surface over it; `shown`
    // says whether the terminal's session is on screen.
    const following = (shown: boolean) => {
      const { runtime } = starting()
      const opened: Terminal[] = []
      const originalOpen = Terminal.prototype.open
      const open = vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
        this: Terminal,
        element,
      ) {
        opened.push(this)
        return originalOpen.call(this, element)
      })
      const detach = vi.fn<AttachedTerminal["detach"]>(async () => {})
      const attachment: AttachedTerminal = {
        id: "01",
        mode: "control",
        [Symbol.asyncIterator]: () => attachment,
        next: vi
          .fn<AttachedTerminal["next"]>()
          .mockResolvedValueOnce({
            value: {
              terminalId: "01",
              sequence: 1,
              type: "snapshot",
              cols: 80,
              rows: 24,
              data: "still the same shell\r\n",
              exit: null,
            },
            done: false,
          })
          .mockImplementation(() => new Promise(() => {})),
        return: async () => ({ value: undefined, done: true as const }),
        write: async () => {},
        resize: async () => {},
        detach,
      }
      const attach = vi.fn<SurfaceRuntime["attach"]>(async () => attachment)
      const screen = vi.fn<SurfaceRuntime["screen"]>()
      const Surface = createRunnerTerminal({
        ...runtime,
        entry: () => ({
          ready: Promise.resolve(true),
          revived: new Promise<void>(() => {}),
          closed: false,
          size: { cols: 80, rows: 24 },
        }),
        attach,
        screen,
        shown: () => shown,
      })
      // Each view places its terminals under its own element, so a switch remounts them.
      const inView = (view: string) =>
        createElement(
          "div",
          { key: view, "data-view": view },
          createElement(Surface, {
            terminalKey: key,
            terminal: { ...terminalFixture(1, "~"), state: "running" },
            projectName: "P",
            fontSize: 13,
            focusInput: false,
            onInputFocused: () => {},
            renderWindow: (content) => content,
          }),
        )
      return { opened, open, attach, detach, screen, inView }
    }

    it("keeps its one xterm, attachment, output and focus", async () => {
      const { opened, open, attach, screen, inView } = following(true)
      try {
        const page = render(inView("grid"))
        mounted.push(page)
        await vi.waitFor(() =>
          expect(opened[0]?.buffer.active.getLine(0)?.translateToString()).toContain(
            "still the same shell",
          ),
        )
        const textarea = input(page)
        act(() => textarea.focus())

        page.rerender(inView("canvas"))
        page.rerender(inView("focus"))

        const view = page.container.querySelector("[data-view=focus]")
        expect(view?.contains(textarea)).toBe(true)
        expect(page.container.querySelectorAll(".xterm")).toHaveLength(1)
        expect(document.activeElement).toBe(textarea)
        expect(opened).toHaveLength(1)
        expect(attach).toHaveBeenCalledTimes(1)
        expect(screen.mock.calls.map((call) => call[1])).toEqual(["mounted", "shown"])
      } finally {
        open.mockRestore()
      }
    })

    it("lets its screen go once no view shows it and its session is off screen", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const { open, screen, inView } = following(false)
      try {
        const page = render(inView("grid"))
        page.unmount()
        expect(screen.mock.calls.map((call) => call[1])).not.toContain("gone")
        await vi.advanceTimersByTimeAsync(1100)
        expect(screen.mock.calls.map((call) => call[1])).toContain("gone")
      } finally {
        vi.useRealTimers()
        open.mockRestore()
      }
    })

    it("keeps its screen while its session stays on screen", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const { open, screen, inView } = following(true)
      try {
        const page = render(inView("grid"))
        page.unmount()
        await vi.advanceTimersByTimeAsync(5000)
        expect(screen.mock.calls.map((call) => call[1])).not.toContain("gone")
      } finally {
        vi.useRealTimers()
        open.mockRestore()
      }
    })
  })

  context("while its shell has no stream yet", () => {
    it("refuses input where the person can see it", () => {
      const { runtime } = starting()
      const page = show(runtime)
      expect(input(page).getAttribute("aria-disabled")).toBe("true")
      expect(page.container.querySelector("[role=status]")?.textContent).toBe("Starting shell…")
    })
  })

  context("when the theme changes", () => {
    it("draws in the new theme's monospace font", () => {
      const opened: Terminal[] = []
      const originalOpen = Terminal.prototype.open
      vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: Terminal, element) {
        opened.push(this)
        return originalOpen.call(this, element)
      })
      const root = document.documentElement
      root.style.setProperty("--font-mono", "Old Mono")
      try {
        show(starting().runtime)
        expect(opened[0]?.options.fontFamily).toBe("Old Mono")

        root.style.setProperty("--font-mono", "New Mono")
        act(() => void window.dispatchEvent(new CustomEvent(themeChangeEvent)))

        expect(opened[0]?.options.fontFamily).toBe("New Mono")
      } finally {
        root.style.removeProperty("--font-mono")
      }
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
      const { page, bar } = ended({ state: "exited", exitCode: 3, signal: null })
      expect(bar?.dataset.terminalEnding).toBe("warning")
      // The announcer sits outside the bar, which is inert while hidden.
      const announcer = page.container.querySelector("[aria-live=polite]")
      expect(announcer?.textContent).toBe("Exited · code 3")
      expect(announcer?.closest("[inert]")).toBeNull()
      expect(bar?.querySelector("[title]")?.textContent).toBe("Exited · code 3")
    })

    it("announces it from a region that outlives the program's body changing", () => {
      const { runtime } = starting()
      const Surface = createRunnerTerminal(runtime)
      const surface = (terminal: TerminalMetadata, Body: typeof Agent) =>
        createElement(Surface, {
          terminalKey: key,
          terminal,
          projectName: "P",
          fontSize: 13,
          focusInput: false,
          onInputFocused: () => {},
          renderWindow: (content) => createElement(Body, null, content),
        })
      const page = render(surface({ ...terminalFixture(1, "~"), state: "running" }, Agent))
      mounted.push(page)
      const announcer = page.container.querySelector("[aria-live=polite]")
      const content = page.container.querySelector("[data-terminal-content]")
      expect(announcer?.textContent).toBe("")

      // The agent's shell is killed: the plain body replaces the agent's.
      const killed = { state: "exited", exitCode: null, signal: "SIGKILL" } as const
      page.rerender(surface({ ...terminalFixture(1, "~"), ...killed }, Plain))
      expect(page.container.querySelector("[data-terminal-content]")).not.toBe(content)
      expect(page.container.querySelector("[aria-live=polite]")).toBe(announcer)
      expect(announcer?.textContent).toBe("Killed · SIGKILL")
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
