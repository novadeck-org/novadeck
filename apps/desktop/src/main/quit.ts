import type { IpcMainEvent } from "electron"

import { saveBeforeQuitChannel } from "../bridge.js"
import type { Quitting } from "./quitting.js"
import type { RunnerEnd } from "./runner.js"

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

/**
 * Every page saves before the runner ends its shells, so the saves name what still runs.
 * The runner and the server then close side by side, and one's close failing leaves the
 * other's to finish. Says how the runner ended, a close that failed saying nothing of that,
 * so it counts as one that didn't end.
 */
export const shutDownInOrder = async ({
  platform,
  persist,
  save,
  closeRunner,
  closeServer,
}: {
  readonly platform: NodeJS.Platform
  readonly persist: () => void
  readonly save: () => Promise<void>
  readonly closeRunner: () => Promise<RunnerEnd> | undefined
  readonly closeServer: () => Promise<void> | undefined
}): Promise<RunnerEnd> => {
  // On Windows the runner hears at once that the app is going, as at the session's end, so
  // no agent the system ends meanwhile counts as ended by the person.
  if (platform === "win32") persist()
  await save()
  const [runner] = await Promise.allSettled([closeRunner(), closeServer()])
  return runner.status === "rejected" ? "abandoned" : (runner.value ?? "closed")
}

/** What a quit runs; `beforeQuit` holds their order. */
export type QuitSteps = {
  readonly quitting: Quitting
  /** Whether an update going into place holds this quit back. */
  readonly held: () => boolean
  /** Says that the app is quitting, unless it is already stopping. */
  readonly announce: () => void
  /** Runs on every pass that isn't held, the last too. */
  readonly begin: () => void
  /** Whether the app has a runner or a server to shut down. */
  readonly hosting: () => boolean
  readonly shutDown: () => Promise<RunnerEnd>
  readonly installMacUpdate: () => Promise<void>
  readonly reopenAppImage: () => Promise<void>
  /** Leaves a waiting update for a later quit, and installs and opens nothing on this one. */
  readonly keepUpdate: () => void
  /** Quits again, which comes back here with nothing left to do and lets the app end. */
  readonly quit: () => void
}

/**
 * The app's `before-quit`: holds the quit back until everything that ends with the app has
 * ended, and quits again whatever failed on the way, so a failure never leaves the app
 * running with its shells gone. A runner that didn't exit even when killed may still hold
 * the data folder and the install folder, so no update goes in and no new copy opens beside
 * it; one that was killed and did exit is gone, and the quit goes on as usual. Returns that
 * work, which ends with the failure if one came, or nothing when this pass lets the quit go
 * on or holds it.
 */
export const beforeQuit = (
  event: { preventDefault(): void },
  steps: QuitSteps,
): Promise<void> | undefined => {
  const { quitting } = steps
  // The quit already under way ends the app once the update is in place.
  if (steps.held()) {
    event.preventDefault()
    return undefined
  }
  if (!quitting.stopping) steps.announce()
  steps.begin()
  if (!steps.hosting() || quitting.stopping) return undefined

  event.preventDefault()
  quitting.stopping = true
  return steps
    .shutDown()
    .then(async (ended) => {
      if (ended === "abandoned") return steps.keepUpdate()
      await steps.installMacUpdate()
      await steps.reopenAppImage()
    })
    .finally(steps.quit)
}
