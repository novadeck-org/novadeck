import type { IpcMainEvent } from "electron"

import { windowFocusRequestChannel } from "../bridge.js"

type WindowFocusIpc = {
  on(channel: string, listener: (event: IpcMainEvent) => void): unknown
}

/**
 * Answers the page's request to be told its window's focus, as it asks each time it starts
 * listening, so a page that loaded again learns the current state. `window` names the
 * window of a request from the app's own page, or undefined for any other sender, whose
 * requests are dropped. `request` gets the window.
 */
export const registerWindowFocusIpc = <Window>(
  ipc: WindowFocusIpc,
  {
    window,
    request,
  }: {
    readonly window: (event: IpcMainEvent) => Window | undefined
    readonly request: (window: Window) => void
  },
): void => {
  ipc.on(windowFocusRequestChannel, (event) => {
    const target = window(event)
    if (target !== undefined) request(target)
  })
}
