import {
  createRenderers,
  createView,
  type Drawing,
  type Terminal as EmulatorTerminal,
} from "@novadeck/emulator/browser"
import type { TerminalEvent, TerminalExit } from "@novadeck/protocol"
import { type AttachedTerminal } from "@novadeck/protocol/client"
import { ctrlVHoldMs } from "@novadeck/terminal/view"
import {
  createTerminalViews,
  pasteNoticeMs,
  type Hold,
  type TerminalViews,
} from "@novadeck/terminal/view"
import { WireError } from "@novadeck/wire"
import { afterEach, onTestFinished, vi } from "vitest"

import { createStore } from "#core/store"
import type { TerminalMetadata, ViewMode } from "#core/types"

import { context, describe, expect, it } from "../../test"
import { terminalFixture } from "../../test/fixtures"
import type {
  BackendConnectionState,
  TerminalKey,
  TerminalMount,
  TerminalMountProps,
  ThemeSource,
} from "../port"
import { createTerminalMount } from "../terminal-views/mount"
import { noTheme } from "../terminal-views/theme"
import type { SurfaceRuntime } from "./backend"
import { viewOptions } from "./view-options"

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

// The emulator's terminal class is not exported; the tests spy on its prototype.
type Terminal = EmulatorTerminal
const Terminal = {
  prototype: (() => {
    const view = createView(document.createElement("div"), {
      fontSize: 13,
      fontFamily: "monospace",
      theme: {},
      scrollback: 0,
    })
    const prototype = Object.getPrototypeOf(view.terminal) as Terminal
    view.dispose()
    return prototype
  })(),
}

// One mount in an element of its own, which the tests drive as the UI would.
type Mounted = {
  readonly container: HTMLElement
  readonly mount: TerminalMount
  // Updates the props it was last given.
  readonly update: (change: Partial<TerminalMountProps>) => void
  readonly unmount: () => void
}
const mounted: Mounted[] = []
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
// Lets the work a test started settle, as its promises and zero-delay timers do.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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

const startingTerminal = (): TerminalMetadata => ({
  ...terminalFixture(1, "~"),
  state: "starting",
})
const propsOf = (terminal: TerminalMetadata, view: ViewMode = "focus"): TerminalMountProps => ({
  name: terminal.name,
  status: terminal.state,
  view,
})

// Mounts a terminal in an element in the page, over `screens`.
const mountOver = (
  screens: TerminalViews<TerminalKey>,
  props: TerminalMountProps,
  terminalKey = key,
  mountTerminal = createTerminalMount(screens),
): Mounted => {
  const container = document.createElement("div")
  document.body.append(container)
  const mount = mountTerminal(container, terminalKey, props)
  let current = props
  const page: Mounted = {
    container,
    mount,
    update: (change) => mount.update((current = { ...current, ...change })),
    unmount: () => {
      mount.dispose()
      container.remove()
    },
  }
  mounted.push(page)
  return page
}

// The page's theme as the tests apply it: no colour tokens, and a change when they say.
const themeChanges = new Set<() => void>()
const theme: ThemeSource = {
  tokens: () => ({}),
  onChange: (listener) => {
    themeChanges.add(listener)
    return () => void themeChanges.delete(listener)
  },
}
const applyTheme = (): void => themeChanges.forEach((listener) => listener())

const show = (runtime: SurfaceRuntime, terminal: TerminalMetadata = startingTerminal()) =>
  mountOver(createTerminalViews(viewOptions(runtime, { theme })), propsOf(terminal))

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
const notice = (page: Mounted): string | null => page.mount.state.getSnapshot().notice

const input = (page: Mounted) =>
  page.container.querySelector<HTMLTextAreaElement>("[data-terminal-input]")!

// A mount whose shell ended as `terminal` says, recording the restarts it asks for.
const ended = (terminal: Partial<TerminalMetadata>) => {
  const { runtime, connection } = starting()
  const restarts: string[] = []
  const page = show({ ...runtime, restart: ({ terminalId }) => restarts.push(terminalId) }, {
    ...terminalFixture(1, "~"),
    ...terminal,
  } as TerminalMetadata)
  return { page, restarts, connection }
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

describe("runner terminal mount", () => {
  context("when it is out of the person's sight", () => {
    // Mounts over screens that note each acquire and release. The timers are fake, so the
    // screen's parking and retention timers run out before the test ends, not after it.
    const watched = (test: (harness: ReturnType<typeof surfaces>) => void) => () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      try {
        test(surfaces())
        vi.advanceTimersByTime(31 * 60 * 1000)
      } finally {
        vi.useRealTimers()
      }
    }
    const surfaces = () => {
      const { runtime } = starting()
      const screens = createTerminalViews(viewOptions(runtime, { theme: noTheme }))
      const calls: string[] = []
      const watching: TerminalViews<TerminalKey> = {
        ...screens,
        acquire: (...args) => {
          calls.push("acquire")
          const hold = screens.acquire(...args)
          return {
            ...hold,
            release: (...options: Parameters<Hold["release"]>) => {
              calls.push("release")
              hold.release(...options)
            },
          }
        },
      }
      const open = (onScreen: boolean) =>
        mountOver(
          watching,
          { ...propsOf(startingTerminal(), "canvas"), onScreen },
          key,
          createTerminalMount(watching),
        )
      return { screens, calls, open }
    }

    it(
      "lets its screen go and takes it again, one release for each acquire",
      watched(({ calls, open }) => {
        const page = open(true)
        const xterm = page.container.querySelector(".xterm")
        expect(calls).toEqual(["acquire"])

        page.update({ onScreen: false })
        expect(calls).toEqual(["acquire", "release"])
        // It stays mounted, showing the element's last drawing.
        expect(page.container.querySelector(".xterm")).toBe(xterm)

        page.update({ onScreen: true })
        expect(calls).toEqual(["acquire", "release", "acquire"])
        expect(page.container.querySelector(".xterm")).toBe(xterm)
        expect(xterm?.isConnected).toBe(true)

        page.update({ onScreen: true })
        page.update({ name: "Renamed" })
        expect(calls).toEqual(["acquire", "release", "acquire"])
        page.unmount()
        expect(calls).toEqual(["acquire", "release", "acquire", "release"])
      }),
    )

    it(
      "leaves no refocus waiting when it takes back a screen that never left its element",
      watched(({ calls, open }) => {
        const page = open(true)
        input(page).focus()
        expect(document.activeElement).toBe(input(page))

        page.update({ onScreen: false })
        // Focus moved on while it was out of sight.
        input(page).blur()
        page.update({ onScreen: true })
        expect(calls).toEqual(["acquire", "release", "acquire"])
        // Nothing waited to refocus the screen: letting go of it out of sight is not an
        // unmount, so taking it again must not steal focus.
        expect(document.activeElement).not.toBe(input(page))
        // Only a dispose leaves focus for the next mount to restore.
        input(page).focus()
        page.unmount()
        const next = open(true)
        expect(document.activeElement).toBe(input(next))
      }),
    )

    it(
      "releases nothing again when it is disposed off screen",
      watched(({ calls, open }) => {
        const page = open(true)
        page.update({ onScreen: false })
        expect(calls).toEqual(["acquire", "release"])
        page.unmount()
        expect(calls).toEqual(["acquire", "release"])
      }),
    )

    it(
      "takes no screen while it has never been on screen",
      watched(({ calls, open }) => {
        const page = open(false)
        expect(calls).toEqual([])
        expect(page.container.querySelector(".xterm")).toBeNull()
        page.update({ onScreen: true })
        expect(calls).toEqual(["acquire"])
        expect(page.container.querySelector(".xterm")?.isConnected).toBe(true)
        page.unmount()
        expect(calls).toEqual(["acquire", "release"])
      }),
    )

    it(
      "tells its state again when it comes back to a screen in a new state",
      watched(({ open }) => {
        const page = open(true)
        const woken = vi.fn<() => void>()
        page.mount.state.subscribe(woken)
        expect(page.mount.state.getSnapshot().lock).toBe("starting")
        page.update({ onScreen: false })
        woken.mockClear()
        page.update({ status: "exited" })
        // Nothing is told while it is away.
        expect(woken).not.toHaveBeenCalled()
        page.update({ onScreen: true })
        expect(page.mount.state.getSnapshot().lock).toBeNull()
        expect(woken).toHaveBeenCalledTimes(1)
      }),
    )
  })

  it("takes focus asked for while off screen into the screen opened again when it's back", () => {
    // The parked-screen cap closed its screen while it was away: the one it comes back to is
    // a new one, which the focus must reach.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { runtime } = starting()
      const page = mountOver(
        createTerminalViews(viewOptions(runtime, { theme: noTheme, cap: 0 })),
        {
          ...propsOf(startingTerminal(), "canvas"),
          onScreen: true,
        },
      )
      const first = page.container.querySelector(".terminal-xterm")
      page.update({ onScreen: false })
      vi.advanceTimersByTime(6_000)
      expect(page.container.querySelector(".terminal-xterm")).toBeNull()
      expect(page.mount.focus()).toBe(false)
      page.update({ onScreen: true })
      const second = page.container.querySelector(".terminal-xterm")
      expect(second).not.toBe(first)
      expect(page.mount.focus()).toBe(true)
      expect(document.activeElement).toBe(input(page))
      page.unmount()
      vi.advanceTimersByTime(31 * 60 * 1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps one live xterm and its output while the UI moves its element", async () => {
    const { runtime } = starting()
    const views: Terminal[] = []
    const originalOpen = Terminal.prototype.open
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: Terminal, element) {
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
    const page = show(
      {
        ...runtime,
        entry: () => ({
          ready: Promise.resolve(true),
          revived: new Promise<void>(() => {}),
          closed: false,
          size: { cols: 80, rows: 24 },
        }),
        attach,
        screen,
      },
      { ...terminalFixture(1, "~"), state: "running" },
    )
    await vi.waitFor(() =>
      expect(views[0]?.buffer.active.getLine(0)?.translateToString()).toContain(
        "hello from the same shell",
      ),
    )
    const textarea = input(page)
    const xterm = page.container.querySelector(".xterm")
    // A different program body gives the UI another place for the element.
    for (const body of ["claude", "codex", "terminal"]) {
      const place = document.createElement("section")
      place.dataset.body = body
      document.body.append(place)
      place.append(page.container)
      expect(page.container.querySelector(".xterm")).toBe(xterm)
      expect(input(page)).toBe(textarea)
      place.remove()
    }
    document.body.append(page.container)
    expect(page.container.querySelectorAll(".xterm")).toHaveLength(1)
    expect(views[0]?.buffer.active.getLine(0)?.translateToString()).toContain(
      "hello from the same shell",
    )
    expect(attach).toHaveBeenCalledTimes(1)
    expect(screen.mock.calls.map((call) => call[1])).toEqual(["mounted", "shown"])
  })

  context("when a view switch mounts it in another place", () => {
    // A live stream that drew one line and then waits, and a mount over it; `shown`
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
      const screens = createTerminalViews(
        viewOptions(
          {
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
          },
          { theme: noTheme },
        ),
      )
      // Each view places its terminals in an element of its own, so a switch mounts them again.
      const inView = (view: string): Mounted => {
        const page = mountOver(screens, propsOf({ ...terminalFixture(1, "~"), state: "running" }))
        page.container.dataset.view = view
        return page
      }
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
        const grid = inView("grid")
        await vi.waitFor(() =>
          expect(opened[0]?.buffer.active.getLine(0)?.translateToString()).toContain(
            "still the same shell",
          ),
        )
        const textarea = input(grid)
        textarea.focus()

        // The next view's mount takes the screen as the last left it, and the focus with it.
        grid.unmount()
        const canvas = inView("canvas")
        canvas.unmount()
        const focus = inView("focus")

        expect(focus.container.dataset.view).toBe("focus")
        expect(focus.container.contains(textarea)).toBe(true)
        expect(focus.container.querySelectorAll(".xterm")).toHaveLength(1)
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
        inView("grid").unmount()
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
        const page = inView("grid")
        await vi.advanceTimersByTimeAsync(0)
        page.unmount()
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        inView("focus")
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
        inView("grid").unmount()
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
        inView("grid").unmount()
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
          const page = inView("grid")
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
        inView("grid").unmount()
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
      expect(page.mount.state.getSnapshot().lock).toBe("starting")
    })
  })

  context("while a running shell's screen has not arrived", () => {
    it("says its output is loading, not that the shell is starting", () => {
      const page = show(starting().runtime, { ...terminalFixture(1, "~"), state: "running" })
      expect(page.mount.state.getSnapshot().lock).toBe("loading")
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
        applyTheme()

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

        font.arrive()
        await settled()

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
        applyTheme()
        applyTheme()
        expect(changes.slice(before)).toEqual([])

        font?.arrive()
        await settled()

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
        applyTheme()
        font?.fail()
        await settled()

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
        // A screen closes once its session has stayed off screen for its retention.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
        try {
          page.unmount()
          vi.advanceTimersByTime(31 * 60 * 1000)
        } finally {
          vi.useRealTimers()
        }
        const before = changes.length

        font.arrive()
        await settled()

        expect(changes.slice(before)).toEqual([])
      } finally {
        root.style.removeProperty("--font-mono")
        font.restore()
      }
    })
  })

  context("while the runner reconnects", () => {
    it("locks its input, saying why", () => {
      const { runtime, connection } = starting()
      const page = show(runtime)
      connection.update(() => "reconnecting")
      expect(page.mount.state.getSnapshot().lock).toBe("reconnecting")
      connection.update(() => "unavailable")
      expect(page.mount.state.getSnapshot().lock).toBe("offline")
      expect(input(page).getAttribute("aria-disabled")).toBe("true")
    })
  })

  context("once its shell ended", () => {
    it.each([
      { state: "exited", exitCode: 3, signal: null },
      { state: "failed", message: "Folder not found" },
    ] as const)("takes input, for Enter alone, as %j", (status) => {
      const { page } = ended(status)
      expect(page.mount.state.getSnapshot().lock).toBeNull()
      expect(input(page).getAttribute("aria-disabled")).toBe("false")
    })

    it("starts a fresh shell from restart()", () => {
      const { page, restarts } = ended({ state: "exited", exitCode: null, signal: "SIGKILL" })
      page.mount.restart()
      expect(restarts).toEqual(["01"])
      expect(page.mount.state.getSnapshot().waits).toBe(false)
      expect(input(page).getAttribute("aria-disabled")).toBe("false")
    })

    it("starts a fresh shell at Enter, and sends nothing else", () => {
      const opened: Terminal[] = []
      const originalOpen = Terminal.prototype.open
      vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: Terminal, element) {
        opened.push(this)
        return originalOpen.call(this, element)
      })
      const { restarts } = ended({ state: "exited", exitCode: 1, signal: null })
      opened[0]!.input("ls")
      expect(restarts).toEqual([])
      opened[0]!.input("\r")
      expect(restarts).toEqual(["01"])
    })

    it("locks again when its status says a fresh shell is starting, until its screen arrives", () => {
      const { page } = ended({ state: "exited", exitCode: 1, signal: null })
      page.update({ status: "starting" })
      expect(page.mount.state.getSnapshot().lock).toBe("starting")
      expect(input(page).getAttribute("aria-disabled")).toBe("true")
    })
  })

  context("once its shell ended while the runner is away", () => {
    it("locks as the link does, and takes input again when it is back", () => {
      const { page, connection } = ended({ state: "exited", exitCode: 1, signal: null })
      connection.update(() => "unavailable")
      expect(page.mount.state.getSnapshot().lock).toBe("offline")
      connection.update(() => "connected")
      expect(page.mount.state.getSnapshot().lock).toBeNull()
    })
  })

  context("when a pasted image can't be saved", () => {
    // Pastes an image into the mount, whose runner refuses it with `error`.
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
      input(page).dispatchEvent(event)
      return page
    }

    it("says why in its state, then lets the notice go", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const page = pasteRefused(new WireError("UPLOAD_TOO_LARGE"))
        await vi.advanceTimersByTimeAsync(0)
        expect(notice(page)).toBe("Couldn't paste the image: it's over 32 MB")
        await vi.advanceTimersByTimeAsync(pasteNoticeMs)
        expect(notice(page)).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it("says only that it failed when the runner is unreachable", async () => {
      const page = pasteRefused(new WireError("DISCONNECTED"))
      await vi.waitFor(() => expect(notice(page)).toBe("Couldn't paste the image"))
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
      input(page).dispatchEvent(event)
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
        await vi.advanceTimersByTimeAsync(0)
        await shell.ready()
        shell.press()
        shell.xterm().input("ls")
        await vi.advanceTimersByTimeAsync(1_000)
        expect(shell.written).toEqual([])
        await vi.advanceTimersByTimeAsync(ctrlVHoldMs)
        expect(shell.written).toEqual(["ls"])
        saved.give("/u/late.png")
        await vi.advanceTimersByTimeAsync(0)
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
      shell.connection.update(() => "reconnecting")
      clipboard.give([])
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(shell.written).toEqual([])
    })

    it("pastes and sends nothing once the terminal's screen is gone", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const saved = later<string>()
        const shell = typing({ read: async () => [clipboardImage()], upload: () => saved.promise })
        await vi.advanceTimersByTimeAsync(0)
        await shell.ready()
        shell.press()
        shell.xterm().input("ls")
        await vi.advanceTimersByTimeAsync(0)
        // Nobody shows it and its terminal closes, so the screen closes a moment later, while
        // the image uploads.
        shell.page.unmount()
        shell.entry.closed = true
        await vi.advanceTimersByTimeAsync(1_000)
        saved.give("/u/late.png")
        await vi.advanceTimersByTimeAsync(ctrlVHoldMs)
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
  // A running shell whose first screen is `data`, or one that exited as `exit` says,
  // recording what is written to it. Each attachment draws that screen, then stays open
  // until detached, as a live shell's.
  const running = (data: string, exit: TerminalExit | null = null) => {
    const { runtime, connection } = starting()
    const written: string[] = []
    const attachments: AttachedTerminal[] = []
    const attachmentOf = (): AttachedTerminal => {
      let drawn = false
      let end: () => void = () => {}
      const closed = new Promise<void>((resolve) => {
        end = resolve
      })
      const attachment: AttachedTerminal = {
        id: "01",
        mode: "control",
        [Symbol.asyncIterator]: () => attachment,
        next: async () => {
          if (drawn) {
            await closed
            return { value: undefined, done: true as const }
          }
          drawn = true
          const event = { terminalId: "01", sequence: 1, cols: 80, rows: 24, data, exit }
          return { value: { ...event, type: "snapshot" as const }, done: false }
        },
        return: async () => ({ value: undefined, done: true as const }),
        write: async (text) => void written.push(text),
        resize: async () => {},
        detach: vi.fn<AttachedTerminal["detach"]>(async () => end()),
      }
      attachments.push(attachment)
      return attachment
    }
    const live = {
      ...runtime,
      entry: () => ({
        ready: Promise.resolve(true),
        revived: new Promise<void>(() => {}),
        closed: false,
        size: { cols: 80, rows: 24 },
      }),
      attach: async () => attachmentOf(),
    }
    const screens = createTerminalViews(viewOptions(live, { theme: noTheme }))
    const showAgain = () =>
      mountOver(screens, propsOf({ ...terminalFixture(1, "~"), state: "running" }))
    const page = showAgain()
    // Its first draw, which a slow runner (Windows in CI) may take seconds over.
    const ready = () =>
      vi.waitFor(() => expect(page.container.textContent).toContain("$"), { timeout: 5_000 })
    // Out of sight long enough for its screen to stop following the shell.
    const park = () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        page.unmount()
        vi.advanceTimersByTime(4_000)
        expect(attachments[0]!.detach).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1_000)
        expect(attachments[0]!.detach).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    }
    return { screens, written, ready, park, showAgain, attachments, connection }
  }

  it("types nothing into a terminal out of sight long enough to stop following it", async () => {
    const { screens, written, ready, park } = running("$ ")
    await ready()
    park()
    expect(screens.typeInto(key, "run the tests")).toBe(false)
    expect(written).toEqual([])
  })

  it("types nothing into a shell that exited and waits for Enter", async () => {
    const { screens, written, ready } = running("$ exit 1", { code: 1, signal: null, ranMs: 5_000 })
    await ready()
    expect(screens.typeInto(key, "run the tests")).toBe(false)
    expect(written).toEqual([])
  })

  it("types nothing while the runner is out of reach", async () => {
    const { screens, written, ready, connection } = running("$ ")
    await ready()
    connection.update(() => "reconnecting")
    expect(screens.typeInto(key, "run the tests")).toBe(false)
    connection.update(() => "unavailable")
    expect(screens.typeInto(key, "run the tests")).toBe(false)
    expect(written).toEqual([])
  })

  it("types into it again once shown and its screen has arrived", async () => {
    const { screens, written, ready, park, showAgain, attachments } = running("$ ")
    await ready()
    park()
    showAgain()
    // Shown, but its screen isn't there yet.
    expect(screens.typeInto(key, "too soon")).toBe(false)
    await vi.waitFor(() => expect(attachments).toHaveLength(2))
    await vi.waitFor(() => expect(screens.typeInto(key, "run the tests")).toBe(true))
    expect(written).toEqual(["run the tests"])
  })

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

describe("a terminal's screen resized out of view", () => {
  // Cells of 8 by 17, and a view of the screen that reports where the test says.
  const measured = () => {
    const reports: ((entries: { isIntersecting: boolean }[]) => void)[] = []
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(report: (entries: { isIntersecting: boolean }[]) => void) {
          reports.push(report)
        }
        observe(): void {}
        disconnect(): void {}
      },
    )
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(8 * 32)
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(17)
    return (isIntersecting: boolean) => reports.forEach((report) => report([{ isIntersecting }]))
  }
  afterEach(() => vi.unstubAllGlobals())

  it("keeps following its shell's output", async () => {
    const view = measured()
    const screens = createTerminalViews(viewOptions(starting().runtime, { theme: noTheme }))
    const terminal = { ...key, terminalId: "out-of-view" }
    const opened: Terminal[] = []
    const originalOpen = Terminal.prototype.open
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: Terminal, element) {
      opened.push(this)
      return originalOpen.call(this, element)
    })
    const hold = screens.acquire(terminal, { label: "Input for T", phase: "running", webgl: false })
    const xterm = opened[0]!
    // The screen closes once it has stayed off screen for its retention, as the file's own
    // do after each test.
    onTestFinished(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      try {
        hold.release()
        vi.advanceTimersByTime(31 * 60 * 1000)
      } finally {
        vi.useRealTimers()
      }
    })
    const write = (lines: number) =>
      new Promise<void>((resolve) => xterm.write("output\r\n".repeat(lines), resolve))
    view(true)
    await write(3)
    view(false)
    // The output is parsed before the renderer, which waits for an idle moment while the
    // screen is out of view, takes the new size.
    const drawn = write(40)
    xterm.resize(64, 19)
    await drawn
    expect(xterm.buffer.active.baseY).toBeGreaterThan(0)
    expect(xterm.buffer.active.viewportY).toBe(xterm.buffer.active.baseY)
  })
})

describe("a surface's renderer", () => {
  // Surfaces over screens drawing through a pool of fake drawings, which record what loads
  // and goes. Every fit gives a size, so each refit tells the runtime.
  const wired = () => {
    const loaded: Terminal[] = []
    const drawings: { disposed: boolean }[] = []
    const watching = { count: 0 }
    const renderers = createRenderers<Terminal>({
      load: (xterm) => {
        loaded.push(xterm)
        const drawing = { disposed: false }
        drawings.push(drawing)
        return {
          onContextLoss: () => ({ dispose: () => {} }),
          clearTextureAtlas: () => {},
          dispose: () => void (drawing.disposed = true),
        } satisfies Drawing
      },
      supported: () => true,
      cap: 12,
      ligatures: () => false,
      watchLigatures: () => {
        watching.count += 1
        return () => void (watching.count -= 1)
      },
    })
    // The screens' hosts have a size, as laid out; nothing else in the page does.
    for (const [name, value] of [
      ["clientWidth", 800],
      ["clientHeight", 600],
    ] as const) {
      const original = Object.getOwnPropertyDescriptor(Element.prototype, name)!.get!
      vi.spyOn(Element.prototype, name, "get").mockImplementation(function (this: Element) {
        return this.classList.contains("terminal-xterm") ? value : original.call(this)
      })
    }
    const { runtime } = starting()
    const resized = vi.fn<SurfaceRuntime["resized"]>()
    const closed = new Set<string>()
    const screens = createTerminalViews(
      viewOptions(
        {
          ...runtime,
          resized,
          entry: ({ terminalId }) => ({
            ready: new Promise<boolean>(() => {}),
            revived: new Promise<void>(() => {}),
            closed: closed.has(terminalId),
            size: { cols: 80, rows: 24 },
          }),
        },
        { theme: noTheme, renderers },
      ),
    )
    // The fit addon is the view's own, so it is reached as the terminal loads it.
    const loadAddon = Terminal.prototype.loadAddon
    vi.spyOn(Terminal.prototype, "loadAddon").mockImplementation(function (
      this: Terminal,
      addon: Parameters<Terminal["loadAddon"]>[0],
    ) {
      if ("proposeDimensions" in addon && typeof addon.proposeDimensions === "function")
        vi.spyOn(
          addon as { proposeDimensions: () => unknown },
          "proposeDimensions",
        ).mockReturnValue({
          cols: 100,
          rows: 30,
        })
      return loadAddon.call(this, addon)
    })
    // Mounts the terminals `ids` in elements of their own, as a view places them.
    const mount = (view: ViewMode, ...ids: string[]) => {
      const pages = ids.map((id) =>
        mountOver(screens, propsOf(startingTerminal(), view), { ...key, terminalId: id }),
      )
      return {
        update: (change: Partial<TerminalMountProps>) =>
          pages.forEach((page) => page.update(change)),
        unmount: () => pages.forEach((page) => page.unmount()),
      }
    }
    const again = (
      pages: { update: (change: Partial<TerminalMountProps>) => void },
      view: ViewMode,
    ) => pages.update({ view })
    return { loaded, drawings, watching, resized, closed, mount, again }
  }

  it("loads WebGL for Focus and nothing for Canvas", () => {
    const { loaded, drawings, mount, again } = wired()
    const page = mount("canvas", "01")
    expect(loaded).toHaveLength(0)
    again(page, "focus")
    expect(loaded).toHaveLength(1)
    again(page, "canvas")
    expect(drawings.map((drawing) => drawing.disposed)).toEqual([true])
  })

  it("fits the screen again each time it changes renderer", () => {
    const { resized, mount, again } = wired()
    const page = mount("focus", "01")
    expect(resized).toHaveBeenCalledWith(key, { cols: 100, rows: 30 })
    resized.mockClear()
    again(page, "canvas")
    expect(resized).toHaveBeenCalledTimes(1)
    again(page, "focus")
    expect(resized).toHaveBeenCalledTimes(2)
  })

  it("fits the screen again once a font it waited for arrives", async () => {
    const { resized, mount } = wired()
    const root = document.documentElement
    root.style.setProperty("--font-mono", "Bundled Mono")
    const font = loading()
    // A resize's settling refit waits on a timer, and a placed host's second fit on the next
    // frame; with both held, only the font's refit counts.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    })
    try {
      mount("focus", "01")
      resized.mockClear()

      font.arrive()
      await vi.advanceTimersByTimeAsync(0)

      expect(resized).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      root.style.removeProperty("--font-mono")
      font.restore()
    }
  })

  it("gives the context back when the screen parks, not when a mount returns in time", () => {
    const { drawings, mount } = wired()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const page = mount("focus", "01")
      page.unmount()
      vi.advanceTimersByTime(4_000)
      expect(drawings[0]!.disposed).toBe(false)
      const back = mount("focus", "01")
      vi.advanceTimersByTime(10_000)
      expect(drawings).toHaveLength(1)
      expect(drawings[0]!.disposed).toBe(false)
      back.unmount()
      vi.advanceTimersByTime(4_999)
      expect(drawings[0]!.disposed).toBe(false)
      vi.advanceTimersByTime(1)
      expect(drawings[0]!.disposed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("watches the ligatures setting until the last screen goes", () => {
    const { watching, closed, mount } = wired()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const page = mount("focus", "01", "02")
      expect(watching.count).toBe(1)
      page.unmount()
      closed.add("01")
      vi.advanceTimersByTime(1_000)
      expect(watching.count).toBe(1)
      closed.add("02")
      vi.advanceTimersByTime(1_000)
      expect(watching.count).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
