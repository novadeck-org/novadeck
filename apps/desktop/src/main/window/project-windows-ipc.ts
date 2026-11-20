import {
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
  projectWindowsUseChannel,
  projectWindowSwapChannel,
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
    use,
    open,
    swap,
    handOff,
  }: {
    readonly window: (event: IpcMainEvent) => Window | undefined
    /** The page starts listening, and wants the current state. */
    readonly ask: (window: Window) => void
    /** The window's page shows this project now, or none. */
    readonly show: (window: Window, projectId: string | undefined) => void
    /** The person turned project windows on or off. */
    readonly use: (on: boolean) => void
    readonly open: (window: Window, projectId: string) => void
    readonly swap: (window: Window, projectId: string) => void
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
    if (value === null) return show(target, undefined)
    const id = windowIdOf(value)
    if (id !== undefined) show(target, id)
  })
  from(projectWindowsUseChannel, (_target, value) => {
    if (typeof value === "boolean") use(value)
  })
  from(projectWindowOpenChannel, (target, value) => {
    const id = windowIdOf(value)
    if (id !== undefined) open(target, id)
  })
  from(projectWindowSwapChannel, (target, value) => {
    const id = windowIdOf(value)
    if (id !== undefined) swap(target, id)
  })
  from(projectWindowHandOffChannel, (target, value) => {
    const place = parseProjectWindowTarget(value)
    if (place) handOff(target, place)
  })
}
