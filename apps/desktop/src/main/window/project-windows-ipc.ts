import {
  parseProjectWindowShown,
  parseProjectWindowTarget,
  windowIdOf,
  type ProjectWindowTarget,
} from "@novadeck/protocol/bridge"
import type { IpcMainEvent } from "electron"

import {
  projectWindowHandOffChannel,
  projectWindowOpenChannel,
  projectWindowShowChannel,
  projectWindowsRequestChannel,
} from "../../bridge.js"

type ProjectWindowsIpc = {
  on(channel: string, listener: (event: IpcMainEvent, value: unknown) => void): unknown
}

/**
 * Takes the pages' reports and requests about project windows. `window` names the window of a
 * request from the app's own page, or undefined for any other sender, whose requests are
 * dropped; every value is checked here again, as the preload checked it.
 */
export const registerProjectWindowsIpc = <Window>(
  ipc: ProjectWindowsIpc,
  {
    window,
    ask,
    show,
    open,
    handOff,
  }: {
    readonly window: (event: IpcMainEvent) => Window | undefined
    /** The page starts listening, and wants the current state. */
    readonly ask: (window: Window) => void
    /** The window's page shows this project now, or none. */
    readonly show: (window: Window, projectId: string | undefined, known: readonly string[]) => void
    readonly open: (window: Window, projectId: string) => void
    readonly handOff: (window: Window, target: ProjectWindowTarget) => void
  },
): void => {
  const from = (channel: string, run: (window: Window, value: unknown) => void): void => {
    ipc.on(channel, (event, value) => {
      const target = window(event)
      if (target !== undefined) run(target, value)
    })
  }
  from(projectWindowsRequestChannel, (target) => ask(target))
  from(projectWindowShowChannel, (target, value) => {
    const shown = parseProjectWindowShown(value)
    if (shown) show(target, shown.projectId ?? undefined, shown.known)
  })
  from(projectWindowOpenChannel, (target, value) => {
    const id = windowIdOf(value)
    if (id !== undefined) open(target, id)
  })
  from(projectWindowHandOffChannel, (target, value) => {
    const place = parseProjectWindowTarget(value)
    if (place) handOff(target, place)
  })
}
