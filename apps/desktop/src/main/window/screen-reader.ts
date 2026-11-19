import type { IpcMainEvent } from "electron"

import { screenReaderChannel, screenReaderRequestChannel } from "../../bridge.js"

type ScreenReaderIpc = {
  on(channel: string, listener: (event: IpcMainEvent) => void): unknown
}

// What the app knows of assistive technology: Electron's `app`, which says whether
// Chromium's accessibility support is on, as it turns on once a screen reader or other
// assistive technology is detected, and tells of each change.
type Accessibility = {
  isAccessibilitySupportEnabled(): boolean
  on(
    event: "accessibility-support-changed",
    listener: (event: unknown, enabled: boolean) => void,
  ): unknown
}

type Page = { send(channel: string, running: boolean): void }

/**
 * Tells the app's pages whether a screen reader is running: each page that asks, as it
 * does when it starts listening, and every page on each change. `page` names the page of a
 * request from the app's own window, or undefined for any other sender, whose requests are
 * dropped; `pages` are the app's pages alive now.
 */
export const registerScreenReaderIpc = <P extends Page>(
  ipc: ScreenReaderIpc,
  app: Accessibility,
  {
    page,
    pages,
  }: {
    readonly page: (event: IpcMainEvent) => P | undefined
    readonly pages: () => readonly P[]
  },
): void => {
  ipc.on(screenReaderRequestChannel, (event) => {
    page(event)?.send(screenReaderChannel, app.isAccessibilitySupportEnabled())
  })
  app.on("accessibility-support-changed", (_event, running) => {
    for (const each of pages()) each.send(screenReaderChannel, running)
  })
}
