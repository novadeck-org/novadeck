import type { TerminalEvent } from "@novadeck/protocol"
import { RunnerError, type AttachedTerminal } from "@novadeck/protocol/client"
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
import { ctrlVHoldMs } from "./paste"
import { createRunnerTerminal } from "./RunnerTerminal"
import { createScreens, pasteNoticeMs } from "./screens"

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
// A screen closes once its session has stayed off screen for its retention; it closes
// here instead, while the file's DOM is still there to take its listeners off.
afterEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  try {
    mounted.splice(0).forEach((page) => page.unmount())
    vi.advanceTimersByTime(31 * 60 * 1000)
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
    upload: () => new Promise(() => {}),
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

// An image on the clipboard.
const clipboardImage = () => ({
  types: ["image/png"],
  getType: async () => new Blob([new Uint8Array([1])], { type: "image/png" }),
})
// An answer the test gives when it chooses.
const later = <T>() => {
  let give: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => (give = resolve))
  return { promise, give: (value: T) => give?.(value) }
}

// The notice of a failed paste, while it shows.
const notice = (page: Rendered) => page.container.querySelector("[data-paste-notice]")

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

// The page's font set while the bundled mono is on its way: it arrives, or fails to, when
// the test says.
const loading = () => {
  const arrival = later<FontFace[]>()
  let refuse: ((reason: Error) => void) | undefined
  const loaded = new Promise<FontFace[]>((resolve, reject) => {
    refuse = reject
    void arrival.promise.then(resolve)
  })
  const original = Object.getOwnPropertyDescriptor(document, "fonts")
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { check: () => false, load: () => loaded },
  })
  const restore = () => {
    if (original) Object.defineProperty(document, "fonts", original)
    else delete (document as { fonts?: unknown }).fonts
  }
  return {
    arrive: () => arrival.give([]),
    fail: () => refuse?.(new Error("The font did not load")),
    restore,
  }
}
// Records each font family xterm is told to use after it opens, in order: every
// terminal's, or only those `counts` picks.
const fontChanges = (counts: (terminal: Terminal) => boolean = () => true) => {
  const changes: string[] = []
  const options = Object.getOwnPropertyDescriptor(Terminal.prototype, "options")!.get!
  vi.spyOn(Terminal.prototype, "options", "get").mockImplementation(function (this: Terminal) {
    return new Proxy(options.call(this), {
      set: (target, name, value) => {
        if (name === "fontFamily" && counts(this)) changes.push(value as string)
        return Reflect.set(target, name, value)
      },
    })
  })
  return changes
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
      let onScreen = shown
      let terminalEnd: "open" | "closed" | "removed" = "open"
      const Surface = createRunnerTerminal({
        ...runtime,
        entry: () =>
          terminalEnd === "removed"
            ? undefined
            : {
                ready: Promise.resolve(true),
                revived: new Promise<void>(() => {}),
                closed: terminalEnd === "closed",
                size: { cols: 80, rows: 24 },
              },
        attach,
        screen,
        shown: () => onScreen,
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
      const putOnScreen = (value: boolean): void => {
        onScreen = value
      }
      const end = (how: "closed" | "removed"): void => {
        terminalEnd = how
      }
      return { opened, open, attach, detach, screen, inView, putOnScreen, end }
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

    it("lets its screen go once its session has stayed off screen for a long while", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const { open, screen, inView } = following(false)
      try {
        const page = render(inView("grid"))
        page.unmount()
        await vi.advanceTimersByTimeAsync(29 * 60 * 1000)
        expect(screen.mock.calls.map((call) => call[1])).not.toContain("gone")
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
        expect(screen.mock.calls.map((call) => call[1])).toContain("gone")
      } finally {
        vi.useRealTimers()
        open.mockRestore()
      }
    })

    it("hands the same screen back to a session left a few minutes ago", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const { open, opened, attach, screen, inView } = following(false)
      try {
        const page = render(inView("grid"))
        await vi.advanceTimersByTimeAsync(0)
        page.unmount()
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        mounted.push(render(inView("focus")))
        expect(opened).toHaveLength(1)
        expect(attach).toHaveBeenCalledTimes(1)
        expect(screen.mock.calls.map((call) => call[1])).not.toContain("gone")
      } finally {
        vi.useRealTimers()
        open.mockRestore()
      }
    })

    it("counts the time away from the last moment its session was on screen", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const { open, screen, inView, putOnScreen } = following(false)
      try {
        const page = render(inView("grid"))
        page.unmount()
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
        putOnScreen(true)
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
        putOnScreen(false)
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
        expect(screen.mock.calls.map((call) => call[1])).not.toContain("gone")
        await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
        expect(screen.mock.calls.map((call) => call[1])).toContain("gone")
      } finally {
        vi.useRealTimers()
        open.mockRestore()
      }
    })

    it("lets its screen go after the time away even when timers ran late", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const { open, screen, inView } = following(false)
      try {
        const page = render(inView("grid"))
        page.unmount()
        await vi.advanceTimersByTimeAsync(1_000)
        vi.setSystemTime(Date.now() + 31 * 60 * 1000)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(screen.mock.calls.map((call) => call[1])).toContain("gone")
      } finally {
        vi.useRealTimers()
        open.mockRestore()
      }
    })

    it.each(["closed", "removed"] as const)(
      "lets its screen go at the next check once its terminal is %s, even on screen",
      async (how) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
        const { open, screen, detach, inView, end } = following(true)
        try {
          const page = render(inView("grid"))
          await vi.advanceTimersByTimeAsync(0)
          page.unmount()
          await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
          expect(screen.mock.calls.map((call) => call[1])).not.toContain("gone")
          end(how)
          await vi.advanceTimersByTimeAsync(1_000)
          expect(screen.mock.calls.map((call) => call[1])).toContain("gone")
          expect(detach).toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
          open.mockRestore()
        }
      },
    )

    it("keeps its screen while its session stays on screen", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const { open, screen, inView } = following(true)
      try {
        const page = render(inView("grid"))
        page.unmount()
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
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

  context("while a running shell's screen has not arrived", () => {
    it("says its output is loading, not that the shell is starting", () => {
      const page = show(starting().runtime, { ...terminalFixture(1, "~"), state: "running" })
      expect(page.container.querySelector("[role=status]")?.textContent).toBe("Loading output…")
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

  context("while its bundled monospace font is still loading", () => {
    it("measures again in the font once it arrives", async () => {
      const font = loading()
      const changes = fontChanges()
      const root = document.documentElement
      root.style.setProperty("--font-mono", "Bundled Mono")
      try {
        show(starting().runtime)
        const before = changes.length

        await act(async () => font.arrive())

        // The family is unchanged, so xterm is told another one first: only a change
        // makes it measure its cells again.
        expect(changes.slice(before)).toEqual(["monospace", "Bundled Mono"])
      } finally {
        root.style.removeProperty("--font-mono")
        font.restore()
      }
    })

    it("keeps its font until a new theme's font arrives, then measures once", async () => {
      const opened: Terminal[] = []
      const originalOpen = Terminal.prototype.open
      vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: Terminal, element) {
        opened.push(this)
        return originalOpen.call(this, element)
      })
      const root = document.documentElement
      root.style.setProperty("--font-mono", "Old Mono")
      // Screens earlier tests left open take the theme too; only this one counts.
      const changes = fontChanges((terminal) => opened.includes(terminal))
      let font: ReturnType<typeof loading> | undefined
      try {
        show(starting().runtime)
        font = loading()
        const before = changes.length

        root.style.setProperty("--font-mono", "New Mono")
        act(() => void window.dispatchEvent(new CustomEvent(themeChangeEvent)))
        act(() => void window.dispatchEvent(new CustomEvent(themeChangeEvent)))
        expect(changes.slice(before)).toEqual([])

        await act(async () => font?.arrive())

        expect(changes.slice(before)).toEqual(["New Mono"])
      } finally {
        root.style.removeProperty("--font-mono")
        font?.restore()
      }
    })

    it("takes a new theme's font that fails to load, so the family falls back", async () => {
      const opened: Terminal[] = []
      const originalOpen = Terminal.prototype.open
      vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: Terminal, element) {
        opened.push(this)
        return originalOpen.call(this, element)
      })
      const root = document.documentElement
      root.style.setProperty("--font-mono", "Old Mono")
      const changes = fontChanges((terminal) => opened.includes(terminal))
      let font: ReturnType<typeof loading> | undefined
      try {
        show(starting().runtime)
        font = loading()
        const before = changes.length

        root.style.setProperty("--font-mono", "New Mono")
        act(() => void window.dispatchEvent(new CustomEvent(themeChangeEvent)))
        await act(async () => font?.fail())

        expect(changes.slice(before)).toEqual(["New Mono"])
      } finally {
        root.style.removeProperty("--font-mono")
        font?.restore()
      }
    })

    it("leaves a screen alone that closed before the font arrived", async () => {
      const font = loading()
      const changes = fontChanges()
      const root = document.documentElement
      root.style.setProperty("--font-mono", "Bundled Mono")
      try {
        const page = show(starting().runtime)
        mounted.splice(mounted.indexOf(page), 1)
        // A screen closes once its session has stayed off screen for its retention.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
        try {
          page.unmount()
          vi.advanceTimersByTime(31 * 60 * 1000)
        } finally {
          vi.useRealTimers()
        }
        const before = changes.length

        await act(async () => font.arrive())

        expect(changes.slice(before)).toEqual([])
      } finally {
        root.style.removeProperty("--font-mono")
        font.restore()
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
    // How it ended, in full in its tooltip when the bar is too narrow.
    const ending = '[data-scope="tooltip"][data-part="trigger"]'

    it("says how under its output, in honey for an exit code, and announces it", () => {
      const { page, bar } = ended({ state: "exited", exitCode: 3, signal: null })
      expect(bar?.dataset.terminalEnding).toBe("warning")
      // The announcer sits outside the bar, which is inert while hidden.
      const announcer = page.container.querySelector("[aria-live=polite]")
      expect(announcer?.textContent).toBe("Exited · code 3")
      expect(announcer?.closest("[inert]")).toBeNull()
      expect(bar?.querySelector(ending)?.textContent).toBe("Exited · code 3")
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
      expect(bar?.querySelector(ending)?.textContent).toBe("Failed to start · Folder not found")
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

  context("when a pasted image can't be saved", () => {
    // Pastes an image into the surface, whose runner refuses it with `error`.
    const pasteRefused = (error: Error) => {
      const { runtime } = starting()
      const page = show({ ...runtime, upload: () => Promise.reject(error) })
      vi.spyOn(console, "error").mockImplementation(() => {})
      const event = new Event("paste", { bubbles: true, cancelable: true })
      const image = new File([new Uint8Array([1])], "", { type: "image/png" })
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          items: [{ kind: "file", getAsFile: () => image }],
          getData: () => "",
        },
      })
      act(() => void input(page).dispatchEvent(event))
      return page
    }

    it("says why at the top of the surface, then lets the notice go", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const page = pasteRefused(new RunnerError("UPLOAD_TOO_LARGE"))
        await act(() => vi.advanceTimersByTimeAsync(0))
        expect(notice(page)?.textContent).toBe("Couldn't paste the image: it's over 32 MB")
        expect(page.container.querySelector("[aria-live]:last-of-type")?.textContent).toBe(
          "Couldn't paste the image: it's over 32 MB",
        )
        await act(() => vi.advanceTimersByTimeAsync(pasteNoticeMs))
        expect(notice(page)).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it("says only that it failed when the runner is unreachable", async () => {
      const page = pasteRefused(new RunnerError("DISCONNECTED"))
      await vi.waitFor(() => expect(notice(page)?.textContent).toBe("Couldn't paste the image"))
    })
  })

  context("when a file copied in a file manager is pasted in the desktop app", () => {
    afterEach(() => void Reflect.deleteProperty(globalThis, "novadeck"))

    it("pastes the file's own path, as the desktop host names it, without uploading", async () => {
      const file = new File(["x"], "notes.txt")
      Object.defineProperty(globalThis, "novadeck", {
        configurable: true,
        value: { pathForFile: (pasted: File) => (pasted === file ? "/home/me/notes.txt" : "") },
      })
      const { runtime } = starting()
      const upload = vi.fn<SurfaceRuntime["upload"]>(async () => "/u/copy.txt")
      const paste = vi.spyOn(Terminal.prototype, "paste")
      const page = show({ ...runtime, upload })
      const event = new Event("paste", { bubbles: true, cancelable: true })
      Object.defineProperty(event, "clipboardData", {
        value: { files: [file], items: [], getData: () => "" },
      })
      act(() => void input(page).dispatchEvent(event))
      await vi.waitFor(() => expect(paste).toHaveBeenCalledWith("/home/me/notes.txt "))
      expect(upload).not.toHaveBeenCalled()
    })
  })

  context("when Ctrl+V is pressed on Linux or Windows", () => {
    // A running shell's surface in a browser that lets the page read the clipboard,
    // recording what reaches the shell. `read` answers the clipboard, `upload` saves.
    const typing = (options: {
      read: () => Promise<unknown[]>
      upload?: SurfaceRuntime["upload"]
    }) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { read: options.read },
      })
      Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value: { query: async () => Object.assign(new EventTarget(), { state: "granted" }) },
      })
      const { runtime, connection } = starting()
      const opened: Terminal[] = []
      const originalOpen = Terminal.prototype.open
      vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: Terminal, element) {
        opened.push(this)
        return originalOpen.call(this, element)
      })
      const written: string[] = []
      let event: ((value: IteratorResult<TerminalEvent>) => void) | undefined
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
              data: "$ ",
              exit: null,
            },
            done: false,
          })
          .mockImplementation(() => new Promise((resolve) => (event = resolve))),
        return: async () => ({ value: undefined, done: true as const }),
        write: async (data) => void written.push(data),
        resize: async () => {},
        detach: async () => {},
      }
      const entry = { closed: false }
      const page = show(
        {
          ...runtime,
          entry: () => ({
            ready: Promise.resolve(true),
            revived: new Promise<void>(() => {}),
            closed: entry.closed,
            size: { cols: 80, rows: 24 },
          }),
          attach: async () => attachment,
          upload:
            options.upload ?? (async (_terminalId, file) => `/u/${file.name.replace(/\d/g, "0")}`),
        },
        { ...terminalFixture(1, "~"), state: "running" },
      )
      const xterm = () => opened[0]!
      const press = () =>
        input(page).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "v",
            code: "KeyV",
            keyCode: 86,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
      const ready = () =>
        vi.waitFor(() =>
          expect(xterm().buffer.active.getLine(0)?.translateToString()).toContain("$"),
        )
      // The shell's exit, as the stream tells it.
      const exit = () =>
        event?.({
          value: {
            terminalId: "01",
            sequence: 2,
            type: "exited",
            exit: { code: 1, signal: null, ranMs: 60_000 },
          },
          done: false,
        })
      return { page, written, press, ready, xterm, exit, connection, entry }
    }
    afterEach(() => {
      Reflect.deleteProperty(navigator, "clipboard")
      Reflect.deleteProperty(navigator, "permissions")
    })

    it("pastes an image-only clipboard's path, with what was typed meanwhile after it", async () => {
      const clipboard = later<unknown[]>()
      const shell = typing({ read: () => clipboard.promise })
      await shell.ready()
      expect(shell.press()).toBe(false)
      shell.xterm().input("ls")
      clipboard.give([clipboardImage()])
      await vi.waitFor(() => expect(shell.written).toHaveLength(2))
      expect(shell.written).toEqual(["/u/pasted-00000000-000000.png ", "ls"])
    })

    it("sends Ctrl+V, then what was typed, for a clipboard of text", async () => {
      const shell = typing({
        read: async () => [{ types: ["text/plain"], getType: async () => new Blob(["hi"]) }],
      })
      await shell.ready()
      shell.press()
      shell.xterm().input("w")
      await vi.waitFor(() => expect(shell.written).toEqual(["\u0016", "w"]))
      expect(notice(shell.page)).toBeNull()
    })

    it("queues mouse reports and pasted text behind it too", async () => {
      const clipboard = later<unknown[]>()
      const shell = typing({ read: () => clipboard.promise })
      await shell.ready()
      shell.press()
      // A mouse report, as xterm's own mouse handling sends it from its core.
      const core = Reflect.get(shell.xterm(), "_core") as {
        coreService: { triggerBinaryEvent: (data: string) => void }
      }
      core.coreService.triggerBinaryEvent("\u001b[M !!")
      // Ctrl+Shift+V of text, which the emulator pastes itself.
      const paste = new Event("paste", { bubbles: true, cancelable: true })
      Object.defineProperty(paste, "clipboardData", {
        value: {
          files: [],
          items: [],
          getData: (type: string) => (type === "text/plain" ? "echo" : ""),
        },
      })
      input(shell.page).dispatchEvent(paste)
      expect(shell.written).toEqual([])
      clipboard.give([])
      await vi.waitFor(() => expect(shell.written).toEqual(["\u0016", "\u001b[M !!", "echo"]))
    })

    it("lets typing go after a while when the image is slow to upload, pasting its path later", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const saved = later<string>()
        const shell = typing({ read: async () => [clipboardImage()], upload: () => saved.promise })
        await act(() => vi.advanceTimersByTimeAsync(0))
        await shell.ready()
        shell.press()
        shell.xterm().input("ls")
        await act(() => vi.advanceTimersByTimeAsync(1_000))
        expect(shell.written).toEqual([])
        await act(() => vi.advanceTimersByTimeAsync(ctrlVHoldMs))
        expect(shell.written).toEqual(["ls"])
        saved.give("/u/late.png")
        await act(() => vi.advanceTimersByTimeAsync(0))
        expect(shell.written).toEqual(["ls", "/u/late.png "])
      } finally {
        vi.useRealTimers()
      }
    })

    it("sends nothing it held once the shell exited meanwhile", async () => {
      const clipboard = later<unknown[]>()
      const shell = typing({ read: () => clipboard.promise })
      await shell.ready()
      shell.press()
      shell.xterm().input("ls")
      shell.exit()
      await new Promise((resolve) => setTimeout(resolve, 10))
      clipboard.give([])
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(shell.written).toEqual([])
    })

    it("holds back its Ctrl+V once typing is locked meanwhile", async () => {
      const clipboard = later<unknown[]>()
      const shell = typing({ read: () => clipboard.promise })
      await shell.ready()
      shell.press()
      act(() => void shell.connection.update(() => "reconnecting"))
      clipboard.give([])
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(shell.written).toEqual([])
    })

    it("pastes and sends nothing once the terminal's screen is gone", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const saved = later<string>()
        const shell = typing({ read: async () => [clipboardImage()], upload: () => saved.promise })
        await act(() => vi.advanceTimersByTimeAsync(0))
        await shell.ready()
        shell.press()
        shell.xterm().input("ls")
        await act(() => vi.advanceTimersByTimeAsync(0))
        // Nobody shows it and its terminal closes, so the screen closes a moment later, while
        // the image uploads.
        mounted.splice(mounted.indexOf(shell.page), 1)
        shell.page.unmount()
        shell.entry.closed = true
        await act(() => vi.advanceTimersByTimeAsync(1_000))
        saved.give("/u/late.png")
        await act(() => vi.advanceTimersByTimeAsync(ctrlVHoldMs))
        expect(shell.written).toEqual([])
      } finally {
        vi.useRealTimers()
      }
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

describe("typing into a terminal's screen", () => {
  // A running shell whose first screen is `data`, recording what is written to it.
  const running = (data: string) => {
    const { runtime } = starting()
    const written: string[] = []
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
            data,
            exit: null,
          },
          done: false,
        })
        .mockImplementation(() => new Promise(() => {})),
      return: async () => ({ value: undefined, done: true as const }),
      write: async (text) => void written.push(text),
      resize: async () => {},
      detach: async () => {},
    }
    const live = {
      ...runtime,
      entry: () => ({
        ready: Promise.resolve(true),
        revived: new Promise<void>(() => {}),
        closed: false,
        size: { cols: 80, rows: 24 },
      }),
      attach: async () => attachment,
    }
    const screens = createScreens(live)
    const Surface = createRunnerTerminal(live, screens)
    const page = render(
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
    mounted.push(page)
    const ready = () => vi.waitFor(() => expect(page.container.textContent).toContain("$"))
    return { screens, written, ready }
  }

  it("pastes plain text as typed, without Enter", async () => {
    const { screens, written, ready } = running("$ ")
    await ready()
    screens.typeInto(key, "run the tests")
    expect(written).toEqual(["run the tests"])
  })

  it("puts a space between the text and a word the cursor follows", async () => {
    const { screens, written, ready } = running("$ git")
    await ready()
    screens.typeInto(key, "status of the branch")
    expect(written).toEqual([" status of the branch"])
  })

  it("brackets the paste once the program asked for that", async () => {
    const { screens, written, ready } = running("\u001b[?2004h$ ")
    await ready()
    screens.typeInto(key, "run the tests")
    expect(written).toEqual(["\u001b[200~run the tests\u001b[201~"])
  })

  it("does nothing for a terminal with no screen, and says so", async () => {
    const { screens, written, ready } = running("$ ")
    await ready()
    expect(screens.typeInto({ ...key, terminalId: "02" }, "run the tests")).toBe(false)
    expect(screens.typeInto(key, "run the tests")).toBe(true)
    expect(written).toEqual(["run the tests"])
  })

  it("turns line breaks and control characters into single spaces, never Enter", async () => {
    const { screens, written, ready } = running("$ ")
    await ready()
    expect(screens.typeInto(key, "\n one\r\ntwo\u001b[31m\tthree \n")).toBe(true)
    expect(written).toEqual(["one two [31m three"])
    expect(screens.typeInto(key, " \r\n ")).toBe(false)
  })
})
