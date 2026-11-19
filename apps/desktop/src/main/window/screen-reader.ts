import type { IpcMainEvent } from "electron"

import { screenReaderChannel, screenReaderRequestChannel } from "../../bridge.js"

type ScreenReaderIpc = {
  on(channel: string, listener: (event: IpcMainEvent) => void): unknown
}

// What the app knows of assistive technology: Electron's `app`, which says whether Chromium's
// accessibility support is on, as it turns on once a screen reader or other assistive
// technology is detected. Electron tells of it on macOS and Windows only.
type Accessibility = {
  isAccessibilitySupportEnabled(): boolean
  on(event: "accessibility-support-changed", listener: () => void): unknown
}

type Page = { send(channel: string, running: boolean): void }

// How often the app asks again. Electron's event misses changes: on macOS, VoiceOver turned on
// while the app runs turns support on without it, and the event other assistive technology
// brings says false, with support turning on 2 s later; on Windows it comes once per window.
export const screenReaderPollMs = 2_000

/**
 * Tells the app's pages whether a screen reader is running: each page that asks, as it does
 * when it starts listening, and every page whenever the answer changes. The answer is asked
 * again every `screenReaderPollMs` and on Electron's event, whose own value isn't trusted.
 * `page` names the page of a request from the app's own window, or undefined for any other
 * sender, whose requests are dropped; `pages` are the app's pages alive now. Returns the stop.
 */
export const registerScreenReaderIpc = <P extends Page>(
  ipc: ScreenReaderIpc,
  app: Accessibility,
  {
    page,
    pages,
    every = (check, ms) => {
      const timer = setInterval(check, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }: {
    readonly page: (event: IpcMainEvent) => P | undefined
    readonly pages: () => readonly P[]
    readonly every?: (check: () => void, ms: number) => () => void
  },
): (() => void) => {
  let running = app.isAccessibilitySupportEnabled()
  const check = (): void => {
    const now = app.isAccessibilitySupportEnabled()
    if (now === running) return
    running = now
    for (const each of pages()) each.send(screenReaderChannel, running)
  }
  ipc.on(screenReaderRequestChannel, (event) => {
    check()
    page(event)?.send(screenReaderChannel, running)
  })
  app.on("accessibility-support-changed", check)
  return every(check, screenReaderPollMs)
}
