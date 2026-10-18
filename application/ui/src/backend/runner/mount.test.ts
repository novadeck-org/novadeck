import { createRenderers, type Drawing, type Terminal } from "@novadeck/emulator/browser"
import { createTerminalViews, type Hold, type TerminalViews } from "@novadeck/terminal/view"
import { afterEach, vi } from "vitest"

import type {
  BackendConnectionState,
  TerminalKey,
  TerminalMount,
  TerminalMountProps,
} from "#core/port"
import { createStore } from "#core/store"
import type { TerminalMetadata, ViewMode } from "#core/types"

import { context, describe, expect, it } from "../../test"
import { terminalFixture } from "../../test/fixtures"
import { createTerminalMount } from "../terminal-views/mount"
import { noTheme } from "../terminal-views/theme"
import type { SurfaceRuntime } from "./backend"
import { viewOptions } from "./view-options"

// What the terminal library's own tests cover (what a screen keeps, tells and refuses) is
// not repeated here: these are the mount's, which turns the UI's props into the library's
// holds.

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

const show = (runtime: SurfaceRuntime, terminal: TerminalMetadata = startingTerminal()) =>
  mountOver(createTerminalViews(viewOptions(runtime, { theme: noTheme })), propsOf(terminal))

const input = (page: Mounted) =>
  page.container.querySelector<HTMLTextAreaElement>("[data-terminal-input]")!

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

  context("what its status says of the shell", () => {
    // The lock is the phase's: a starting shell is locked until its screen arrives, a running
    // one's screen is loading, and one that exited or failed takes Enter alone.
    it.each([
      [{ state: "starting" }, "starting"],
      [{ state: "running" }, "loading"],
      [{ state: "exited", exitCode: 3, signal: null }, null],
      [{ state: "failed", message: "Folder not found" }, null],
    ] as const)("opens with %j as the lock %s", (status, lock) => {
      const page = show(starting().runtime, { ...terminalFixture(1, "~"), ...status })
      expect(page.mount.state.getSnapshot().lock).toBe(lock)
    })

    it("follows its status as it changes", () => {
      const page = show(starting().runtime, {
        ...terminalFixture(1, "~"),
        state: "exited",
        exitCode: 1,
        signal: null,
      })
      expect(page.mount.state.getSnapshot().lock).toBeNull()
      page.update({ status: "starting" })
      expect(page.mount.state.getSnapshot().lock).toBe("starting")
    })

    it("asks the runtime to restart its terminal from restart()", () => {
      const restarts: string[] = []
      const { runtime } = starting()
      const page = show(
        { ...runtime, restart: ({ terminalId }) => restarts.push(terminalId) },
        { ...terminalFixture(1, "~"), state: "exited", exitCode: null, signal: "SIGKILL" },
      )
      page.mount.restart()
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

describe("a surface's renderer", () => {
  it("loads WebGL for Focus and nothing for Canvas", () => {
    const loaded: Terminal[] = []
    const drawings: { disposed: boolean }[] = []
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
      watchLigatures: () => () => {},
    })
    const page = mountOver(
      createTerminalViews(viewOptions(starting().runtime, { theme: noTheme, renderers })),
      propsOf(startingTerminal(), "canvas"),
    )
    expect(loaded).toHaveLength(0)
    page.update({ view: "focus" })
    expect(loaded).toHaveLength(1)
    page.update({ view: "canvas" })
    expect(drawings.map((drawing) => drawing.disposed)).toEqual([true])
  })
})
