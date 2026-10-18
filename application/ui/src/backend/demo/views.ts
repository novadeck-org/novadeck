import type { Renderers } from "@novadeck/emulator/browser"
import type { AttachStream, TerminalEvent } from "@novadeck/terminal"
import {
  createTerminalViews,
  type PasteFailure,
  type TerminalViewOptions,
} from "@novadeck/terminal/view"

import { terminalKeyId } from "#core/registry"
import { createStore, type Store } from "#core/store"
import type { TerminalMetadata } from "#core/types"

import type { BackendConnectionState, TerminalKey, ThemeSource } from "../port"
import { openEmulator } from "../terminal-views/emulator"
import { createTerminalMount, screenMarkup } from "../terminal-views/mount"
import { pageRenderers } from "../terminal-views/renderers"
import { noTheme, terminalTheme } from "../terminal-views/theme"
import type { DemoAgentLink } from "./agent-link"
import type { DemoEngine } from "./engine"
import {
  createDemoTerminalScreen,
  type DemoIntro,
  type DemoTerminalScreen,
} from "./screen/terminal"
import type { DemoSurfaceRuntime } from "./surface"

// The demo's terminals, drawn as the runner's are: real terminals, through the same views and
// mount, each fed by a screen the demo writes as terminal output (see screen/terminal.ts).

// Where a demo terminal draws and what it opens with: the page's theme (none in tests), the
// WebGL pool (the page's), and a terminal's own opening output in place of its program's.
export type DemoTerminalSetup = {
  readonly theme?: ThemeSource
  readonly renderers?: Renderers
  readonly introOf?: (terminal: TerminalMetadata, key: TerminalKey) => DemoIntro | undefined
  // The debug layer's: what its terminals read of the connection, how they restart, and what
  // their screens are doing.
  readonly runtime?: DemoSurfaceRuntime
}

// The size a screen is written at until the views fit it: a terminal's usual one.
const opening = { cols: 80, rows: 24 }
// The most a pasted file may be, as the runner takes them.
const maxUploadBytes = 32 * 1024 * 1024

// What a failed paste tells the person, in the runner's words.
const pasteNotice = (failure: PasteFailure): string => {
  if (failure.kind === "clipboard") return "Novadeck can't read the clipboard"
  const pasted = failure.type.startsWith("image/") ? "image" : "file"
  return failure.tooLarge
    ? `Couldn't paste the ${pasted}: it's over ${maxUploadBytes / 1024 / 1024} MB`
    : `Couldn't paste the ${pasted}`
}

const always = createStore<BackendConnectionState>("connected")

// Resolves once `ready` holds of the store, at once where it already does.
const until = <S>(store: Store<S>, ready: (state: S) => boolean): Promise<void> =>
  new Promise((resolve) => {
    if (ready(store.getSnapshot())) return resolve()
    const stop = store.subscribe(() => {
      if (!ready(store.getSnapshot())) return
      stop()
      resolve()
    })
  })

// What the views draw the demo's terminals from: the options, and how its screens are
// linked to the agents' conversations.
export const demoViewOptions = (
  engine: DemoEngine,
  { theme = noTheme, renderers = pageRenderers(), introOf, runtime }: DemoTerminalSetup = {},
) => {
  let link: DemoAgentLink | undefined
  const screens = new Map<string, DemoTerminalScreen>()
  // Each terminal's stream that draws it now, which the debug layer ends to show its output
  // on the way again.
  const streams = new Map<string, { readonly key: TerminalKey; readonly end: () => void }>()
  const connection = runtime?.connection ?? always

  const screenOf = (key: TerminalKey): DemoTerminalScreen => {
    const id = terminalKeyId(key)
    const known = screens.get(id)
    if (known) return known
    const terminal = engine.terminal(key)
    const made = createDemoTerminalScreen({
      key,
      engine,
      intro: terminal && introOf?.(terminal, key),
      link: () => link,
      size: opening,
    })
    screens.set(id, made)
    // It goes with its terminal, and its stream with a shell that starts again, so the
    // views lock until it has.
    const stop = engine.subscribe(key, () => {
      if (engine.terminal(key)?.state === "starting") streams.get(id)?.end()
      if (engine.has(key)) return
      stop()
      made.dispose()
      screens.delete(id)
    })
    return made
  }

  // What the debug layer says a screen is doing: its output still on the way.
  const attaching = (key: TerminalKey): boolean =>
    runtime?.screens.getSnapshot().get(terminalKeyId(key))?.attaching === true
  runtime?.screens.subscribe(() => {
    for (const { key, end } of streams.values()) if (attaching(key)) end()
  })

  // A stream of the terminal's screen: the whole of it, then each change, until closed. Its
  // keys and sizes go back to the screen.
  const streamOf = (key: TerminalKey, screen: DemoTerminalScreen): AttachStream => {
    const id = terminalKeyId(key)
    const queue: TerminalEvent[] = []
    let sequence = 0
    let closed = false
    let wake: (() => void) | undefined
    let detach: (() => void) | undefined
    const push = (event: TerminalEvent): void => {
      queue.push(event)
      wake?.()
    }
    const close = (): void => {
      if (closed) return
      closed = true
      detach?.()
      if (streams.get(id)?.end === close) streams.delete(id)
      wake?.()
    }
    streams.get(id)?.end()
    streams.set(id, { key, end: close })
    // Bracketed paste, so a paste reaches the line editor whole rather than line by line;
    // the views reset the emulator before a snapshot, so each one sets it again.
    const { cols, rows } = screen.size()
    push({
      sequence: (sequence += 1),
      type: "snapshot",
      data: `\x1b[?2004h${screen.snapshot()}`,
      cols,
      rows,
      exit: null,
    })
    detach = screen.attach((data) => push({ sequence: (sequence += 1), type: "output", data }))
    return {
      mode: "control",
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<TerminalEvent, undefined>> => {
          // Waits for the next event, or the end; `close` wakes it too.
          const idle = (): boolean => queue.length === 0 && !closed
          while (idle())
            // eslint-disable-next-line no-await-in-loop -- One event at a time, in order.
            await new Promise<void>((resolve) => (wake = resolve))
          const event = queue.shift()
          return event ? { value: event, done: false } : { value: undefined, done: true }
        },
        return: (): Promise<IteratorResult<TerminalEvent, undefined>> => {
          close()
          return Promise.resolve({ value: undefined, done: true })
        },
      }),
      write: (data) => {
        if (!closed) screen.input(data)
        return Promise.resolve()
      },
      resize: (nextCols, nextRows) => {
        if (!closed) screen.resize({ cols: nextCols, rows: nextRows })
        return Promise.resolve()
      },
      close,
    }
  }

  // Whether the terminal's screen can be shown: its shell has started, as the debug layer may
  // hold one starting, and its output isn't on its way.
  const showable = (key: TerminalKey): boolean =>
    engine.terminal(key)?.state !== "starting" && !attaching(key)
  // Resolves once it can be shown, or its terminal is gone: one wait for each terminal while
  // it lasts, as the views ask on every key and every second.
  const waits = new Map<string, Promise<boolean>>()
  const shown = (key: TerminalKey): Promise<boolean> => {
    if (showable(key) || !engine.has(key)) return Promise.resolve(engine.has(key))
    const id = terminalKeyId(key)
    const known = waits.get(id)
    if (known) return known
    const waiting = new Promise<boolean>((resolve) => {
      const check = (): void => {
        if (!showable(key) && engine.has(key)) return
        stopEngine()
        stopScreens?.()
        waits.delete(id)
        resolve(engine.has(key))
      }
      const stopEngine = engine.subscribe(key, check)
      const stopScreens = runtime?.screens.subscribe(check)
    })
    waits.set(id, waiting)
    return waiting
  }

  const options: TerminalViewOptions<TerminalKey> = {
    keyOf: terminalKeyId,
    emulator: openEmulator({ renderers, screenReaderMode: true }),
    theme: terminalTheme(theme),
    store: createStore,
    markup: screenMarkup,
    attach: async (key) => {
      if (!(await shown(key))) throw new Error("The terminal closed")
      return streamOf(key, screenOf(key))
    },
    // A stream ends only for a screen held back a while, so the views attach again once it
    // can be shown.
    lifecycle: (key) =>
      engine.has(key)
        ? {
            ready: shown(key),
            get revived() {
              return shown(key).then(() => {})
            },
            get closed() {
              return !engine.has(key)
            },
            get size() {
              return screenOf(key).size()
            },
          }
        : undefined,
    connection,
    reconnected: () => until(connection, (state) => state === "connected"),
    classify: () => "fatal",
    waitsAfter: () => false,
    restart: (key) => runtime?.restart(key),
    // A demo screen costs nothing to keep while its terminal lasts.
    retain: { afterMs: Number.POSITIVE_INFINITY, shown: () => true },
    paste: {
      // Saved nowhere, the demo says where it would be, or fails where the debug layer asks.
      upload: (key, file) =>
        runtime?.failPaste?.(key)
          ? Promise.reject(new Error("The debug panel failed this paste"))
          : Promise.resolve(`/tmp/novadeck-paste/${file.name}`),
      maxBytes: maxUploadBytes,
      trustedClipboard: false,
      notice: pasteNotice,
    },
  }

  return {
    options,
    // Links the terminals' screens to the agents' conversations, as `withConversations` does.
    link: (next: DemoAgentLink): void => {
      link = next
      screens.forEach((screen) => screen.refresh())
    },
  }
}

export const createDemoTerminals = (engine: DemoEngine, setup: DemoTerminalSetup = {}) => {
  const { options, link } = demoViewOptions(engine, setup)
  const views = createTerminalViews(options)
  return {
    mountTerminal: createTerminalMount(views),
    setFont: views.setFont,
    typeInto: views.typeInto,
    link,
  }
}

export type DemoTerminals = ReturnType<typeof createDemoTerminals>
