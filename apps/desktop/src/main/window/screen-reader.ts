import type { IpcMainEvent } from "electron"

import { screenReaderChannel, screenReaderRequestChannel } from "../../bridge.js"

type ScreenReaderIpc = {
  on(channel: string, listener: (event: IpcMainEvent) => void): unknown
}

/**
 * Where the app learns whether a screen reader may run: `running` says it now, and `watch`
 * calls `changed` whenever it may have changed, until the stop it returns. A source that can't
 * tell says true, so terminals keep a reader's text.
 */
export type ReaderSource = {
  readonly running: () => boolean
  readonly watch: (changed: () => void) => () => void
}

// What the app knows of assistive technology on macOS and Windows: Electron's `app`, which says
// whether Chromium's accessibility support is on, as it turns on once a screen reader or other
// assistive technology is detected.
type Accessibility = {
  isAccessibilitySupportEnabled(): boolean
  on(event: "accessibility-support-changed", listener: () => void): unknown
}

// Calls `check` every `ms` until the stop it returns, without keeping the app alive.
export type Every = (check: () => void, ms: number) => () => void

const every: Every = (check, ms) => {
  const timer = setInterval(check, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

// How often the app asks Electron again. Its event misses changes: on macOS, VoiceOver turned
// on while the app runs turns support on without it, and the event other assistive technology
// brings says false, with support turning on 2 s later; on Windows it comes once per window.
export const screenReaderPollMs = 2_000

/** Electron's word on macOS and Windows: asked again on its event, whose value isn't trusted, and every `screenReaderPollMs`. */
export const electronReaders = (app: Accessibility, repeat: Every = every): ReaderSource => ({
  running: () => app.isAccessibilitySupportEnabled(),
  watch: (changed) => {
    app.on("accessibility-support-changed", changed)
    return repeat(changed, screenReaderPollMs)
  },
})

/**
 * Tells the app's pages whether a screen reader may run, from `source`: each page that asks,
 * as it does when it starts listening, and every page whenever the answer changes. `page`
 * names the page of a request from the app's own window, or undefined for any other sender,
 * whose requests are dropped; `pages` are the app's pages alive now. Returns the stop.
 */
export const registerScreenReaderIpc = <
  P extends { send(channel: string, running: boolean): void },
>(
  ipc: ScreenReaderIpc,
  source: ReaderSource,
  {
    page,
    pages,
  }: {
    readonly page: (event: IpcMainEvent) => P | undefined
    readonly pages: () => readonly P[]
  },
): (() => void) => {
  let running = source.running()
  const check = (): void => {
    const now = source.running()
    if (now === running) return
    running = now
    for (const each of pages()) each.send(screenReaderChannel, running)
  }
  ipc.on(screenReaderRequestChannel, (event) => {
    check()
    page(event)?.send(screenReaderChannel, running)
  })
  return source.watch(check)
}
