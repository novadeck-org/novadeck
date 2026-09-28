import type { IpcMainEvent } from "electron"

import { saveBeforeQuitChannel } from "../bridge.js"

type QuitIpc = {
  on(channel: string, listener: (event: IpcMainEvent) => void): unknown
  removeListener(channel: string, listener: (event: IpcMainEvent) => void): unknown
}

// The part of a page's WebContents that saving uses.
type Page = {
  send(channel: string): void
  once(event: "destroyed", listener: () => void): unknown
  once(event: "render-process-gone", listener: () => void): unknown
  removeListener(event: "destroyed", listener: () => void): unknown
  removeListener(event: "render-process-gone", listener: () => void): unknown
}

const stopListening = (page: Page, gone: () => void): void => {
  page.removeListener("destroyed", gone)
  page.removeListener("render-process-gone", gone)
}

/**
 * Asks each page to finish its saves while the runner's shells still run, so the saved
 * sessions name the programs in them. Resolves once every page answered or went away,
 * or after `timeoutMs`, so a hung page cannot hold quitting up. `sender` names the page
 * an answer came from, or undefined for one that is not the app's own.
 */
export const savePages = <P extends Page>(
  ipc: QuitIpc,
  pages: readonly P[],
  {
    sender,
    timeoutMs,
  }: { readonly sender: (event: IpcMainEvent) => P | undefined; readonly timeoutMs: number },
): Promise<void> =>
  new Promise((resolve) => {
    const waiting = new Map(pages.map((page) => [page, () => settled(page)] as const))
    const done = (): void => {
      clearTimeout(timer)
      ipc.removeListener(saveBeforeQuitChannel, answered)
      for (const [page, gone] of waiting) stopListening(page, gone)
      waiting.clear()
      resolve()
    }
    const settled = (page: P): void => {
      const gone = waiting.get(page)
      if (!gone) return
      stopListening(page, gone)
      waiting.delete(page)
      if (waiting.size === 0) done()
    }
    const answered = (event: IpcMainEvent): void => {
      const page = sender(event)
      if (page) settled(page)
    }
    const timer = setTimeout(done, timeoutMs)
    if (waiting.size === 0) {
      done()
      return
    }
    ipc.on(saveBeforeQuitChannel, answered)
    for (const [page, gone] of waiting) {
      // A page that crashes or goes away while asked has nothing left to save.
      page.once("destroyed", gone)
      page.once("render-process-gone", gone)
      page.send(saveBeforeQuitChannel)
    }
  })

// The part of Electron's powerMonitor that hears the system shutting down. Electron
// passes the event its documentation describes, which its typings leave out.
type Power = {
  on(event: "shutdown", listener: (event?: { preventDefault(): void }) => void): unknown
}

// The part of a BrowserWindow that hears Windows ending the session.
type SessionWindow = {
  on(event: "query-session-end" | "session-end", listener: () => void): unknown
}

/**
 * Saves before the operating system ends the session, not only when someone quits. On
 * Linux and macOS the system's shutdown asks the app to quit, which saves every page
 * and the runner on the way out; Electron holds the shutdown back meanwhile.
 */
export const quitOnShutdown = (power: Power, quit: () => void): void => {
  power.on("shutdown", (event) => {
    event?.preventDefault()
    quit()
  })
}

/**
 * On Windows a window hears that the session may end, and then that it ends: the
 * first saves while the shells still run, since the system may end the app without
 * waiting; the second quits, which saves again on the way out.
 */
export const saveOnSessionEnd = (
  window: SessionWindow,
  { save, quit }: { readonly save: () => void; readonly quit: () => void },
): void => {
  window.on("query-session-end", save)
  window.on("session-end", quit)
}

// The part of a BrowserWindow that closing uses.
type Closable = {
  on(event: "close", listener: (event: { preventDefault(): void }) => void): unknown
  close(): void
  isDestroyed(): boolean
}

/**
 * Lets a window's page save before the window closes, while the runner still takes
 * saves: the first close waits for `save`, closes after it once, and closes asked for
 * meanwhile only wait with it. Quitting saves every page itself first, so a close then
 * goes ahead at once.
 */
export const saveBeforeClose = (
  window: Closable,
  save: () => Promise<void>,
  quitting: () => boolean,
): void => {
  let state: "open" | "saving" | "saved" = "open"
  window.on("close", (event) => {
    if (state === "saved" || quitting()) return
    event.preventDefault()
    if (state === "saving") return
    state = "saving"
    void save().finally(() => {
      state = "saved"
      if (!window.isDestroyed()) window.close()
    })
  })
}
