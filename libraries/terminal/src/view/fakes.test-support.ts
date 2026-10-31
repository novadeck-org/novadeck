import { createView, type Terminal } from "@novadeck/emulator/browser"
import { vi } from "vitest"

import type { AttachStream, Exit, TerminalEvent } from "../contract.js"
import type { Lifecycle } from "./follow.js"
import {
  createTerminalScreens,
  type Hold,
  type ShowOptions,
  type TerminalScreensOptions,
  type TerminalScreens,
} from "./screens.js"
import { createStore, type ViewLink } from "./view-state.js"

// The fakes the view's tests build screens from, none of them an app's: string-keyed
// terminals, a theme the test changes, and streams the test feeds. The tests' DOM shims
// (canvas, observers, media queries) stay in each test file, which sets them up first.
// This file is a helper, not a suite: the build leaves out `*.test-support.ts`.

// How long the options keep a screen nobody shows, which the tests close past.
export const retainMs = 30 * 60 * 1000

// The emulator's terminal class is not exported; the tests spy on its prototype.
export const emulatorPrototype = (): Terminal => {
  const view = createView(document.createElement("div"), {
    fontSize: 13,
    fontFamily: "monospace",
    theme: {},
    scrollback: 0,
  })
  const prototype = Object.getPrototypeOf(view.terminal) as Terminal
  view.dispose()
  return prototype
}

// Records each terminal the emulator opens, in order, until the test ends.
export const openedTerminals = (): Terminal[] => {
  const opened: Terminal[] = []
  const prototype = emulatorPrototype()
  const open = prototype.open
  vi.spyOn(prototype, "open").mockImplementation(function (this: Terminal, element) {
    opened.push(this)
    return open.call(this, element)
  })
  return opened
}

// A shell that runs, or one that is still starting.
export const shell = (over: Partial<Lifecycle> = {}): Lifecycle => ({
  ready: Promise.resolve(true),
  revived: new Promise<void>(() => {}),
  closed: false,
  size: { cols: 80, rows: 24 },
  ...over,
})
export const starting = (over: Partial<Lifecycle> = {}): Lifecycle =>
  shell({ ready: new Promise<boolean>(() => {}), ...over })

// The page's theme as the tests apply it: a font family, and a change when they say.
export const themed = () => {
  const listeners = new Set<() => void>()
  let fontFamily = "monospace"
  return {
    theme: {
      resolve: () => ({ theme: {}, fontFamily }),
      changed: (listener: () => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
    listeners,
    // Applies a theme in `font`.
    apply: (font: string): void => {
      fontFamily = font
      listeners.forEach((listener) => listener())
    },
  }
}

// What the options say of a failed paste: enough to tell which failure it was.
const noticeOf: TerminalScreensOptions<string>["paste"]["notice"] = (failure) =>
  failure.kind === "clipboard"
    ? "clipboard"
    : `${failure.type}: ${
        failure.tooLarge
          ? "too large"
          : failure.error instanceof Error
            ? failure.error.message
            : "failed"
      }`

// Options for string-keyed terminals whose shells run and never get a stream, over a theme of
// no colours; `over` replaces whichever the test is about.
export const optionsOf = (over: Partial<TerminalScreensOptions<string>> = {}) =>
  ({
    keyOf: (key) => key,
    emulator: (container, open) => createView(container, { ...open, scrollback: 0 }),
    theme: themed().theme,
    attach: () => new Promise(() => {}),
    lifecycle: () => shell(),
    connection: createStore<ViewLink>("connected"),
    reconnected: async () => {},
    classify: () => "fatal",
    waitsAfter: () => false,
    restart: () => {},
    retain: { afterMs: retainMs, shown: () => false },
    paste: {
      upload: () => new Promise<string>(() => {}),
      maxBytes: 32 * 1024 * 1024,
      trustedClipboard: false,
      notice: noticeOf,
    },
    ...over,
  }) satisfies TerminalScreensOptions<string>

// What the tests close once they end: every hold they took, and every element they placed
// a screen in. A screen closes once its session has stayed off screen for its retention, so
// `closeScreens` runs the clock past it while the file's DOM is still there to take the
// screens' listeners off.
const closers: (() => void)[] = []
export const closeScreens = (): void => {
  const fake = vi.isFakeTimers()
  if (!fake) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  try {
    closers.splice(0).forEach((close) => close())
    vi.advanceTimersByTime(retainMs + 60_000)
  } finally {
    if (!fake) vi.useRealTimers()
  }
}

// Screens over `options`, whose holds the test ends with `closeScreens`.
export const screensOf = (options: TerminalScreensOptions<string>): TerminalScreens<string> => {
  const screens = createTerminalScreens(options)
  return {
    ...screens,
    acquire: (key, show) => {
      const hold = screens.acquire(key, show)
      closers.push(() => hold.release())
      return hold
    },
  }
}

// An element in the page for a screen, taken out again once the test ends.
export const slot = (): HTMLElement => {
  const element = document.createElement("div")
  document.body.append(element)
  closers.push(() => element.remove())
  return element
}

export const running: ShowOptions = { label: "Input for T", phase: "running", webgl: false }

// A terminal's screen held as a mount holds it: acquired, and placed in an element.
export const shown = (
  screens: TerminalScreens<string>,
  key: string,
  options: Partial<ShowOptions> = {},
  element: HTMLElement = slot(),
): { readonly hold: Hold; readonly element: HTMLElement } => {
  const hold = screens.acquire(key, { ...running, ...options })
  hold.place(element)
  return { hold, element }
}

// The input of the screen in `element`.
export const inputOf = (element: HTMLElement): HTMLTextAreaElement =>
  element.querySelector<HTMLTextAreaElement>("textarea")!

// Lets the work a test started settle, as its promises and zero-delay timers do.
export const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// An answer the test gives when it chooses.
export const later = <T>() => {
  let give: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => (give = resolve))
  return { promise, give: (value: T) => give?.(value) }
}

export const snapshot = (data: string, exit: Exit | null = null): TerminalEvent => ({
  sequence: 1,
  type: "snapshot",
  cols: 80,
  rows: 24,
  data,
  exit,
})
export const output = (data: string, sequence: number): TerminalEvent => ({
  sequence,
  type: "output",
  data,
})
export const exited = (exit: Exit, sequence: number): TerminalEvent => ({
  sequence,
  type: "exited",
  exit,
})

// A stream of `events`, recording what is written and resized through it. It then stays open
// until closed, as a live shell's does, or ends when `ends` says, as the host ends one
// after an exit; `push` gives it another event.
export const streamOf = (events: readonly TerminalEvent[] = [], { ends = false } = {}) => {
  const queue = [...events]
  const written: string[] = []
  const resized: string[] = []
  let closed = false
  let wake: (() => void) | undefined
  const close = vi.fn<() => void>(() => {
    closed = true
    wake?.()
  })
  const next = async (): Promise<IteratorResult<TerminalEvent>> => {
    if (!closed && queue.length) return { value: queue.shift()!, done: false }
    if (closed || ends) return { value: undefined, done: true }
    await new Promise<void>((resolve) => (wake = resolve))
    return next()
  }
  const attached: AttachStream = {
    mode: "control",
    [Symbol.asyncIterator]: () => ({ next }),
    write: async (data) => void written.push(data),
    resize: async (cols, rows) => void resized.push(`${cols}x${rows}`),
    close,
  }
  return {
    attached,
    close,
    written,
    resized,
    push: (event: TerminalEvent): void => {
      queue.push(event)
      wake?.()
    },
  }
}

// The page's font set while a bundled font is on its way: it arrives, or fails to, when the
// test says.
export const loading = () => {
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

// Records each font family xterm is told to use after it opens, in order: every terminal's,
// or only those `counts` picks.
export const fontChanges = (counts: (terminal: Terminal) => boolean = () => true): string[] => {
  const changes: string[] = []
  const prototype = emulatorPrototype()
  const options = Object.getOwnPropertyDescriptor(prototype, "options")!.get!
  vi.spyOn(prototype, "options", "get").mockImplementation(function (this: Terminal) {
    return new Proxy(options.call(this), {
      set: (target, name, value) => {
        if (name === "fontFamily" && counts(this)) changes.push(value as string)
        return Reflect.set(target, name, value)
      },
    })
  })
  return changes
}
