import {
  parseProjectWindowShown,
  parseProjectWindowTarget,
  type ProjectWindowSwap,
  windowIdOf,
  type ProjectWindowTarget,
} from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

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
  handle(channel: string, listener: (event: IpcMainInvokeEvent, value: unknown) => unknown): unknown
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
    readonly window: (event: IpcMainEvent | IpcMainInvokeEvent) => Window | undefined
    /** The page starts listening, and wants the current state. */
    readonly ask: (window: Window) => void
    /** The window's page shows this project now, or none. */
    readonly show: (window: Window, projectId: string | undefined, known: readonly string[]) => void
    /** The person turned project windows on or off. */
    readonly use: (on: boolean) => void
    readonly open: (window: Window, projectId: string) => void
    /** How the swap went (see `ProjectWindowSwap`). */
    readonly swap: (window: Window, projectId: string) => ProjectWindowSwap
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
  from(projectWindowsUseChannel, (_target, value) => {
    if (typeof value === "boolean") use(value)
  })
  from(projectWindowOpenChannel, (target, value) => {
    const id = windowIdOf(value)
    if (id !== undefined) open(target, id)
  })
  ipc.handle(projectWindowSwapChannel, async (event, value) => {
    const target = window(event)
    const id = windowIdOf(value)
    return target !== undefined && id !== undefined ? swap(target, id) : "alone"
  })
  from(projectWindowHandOffChannel, (target, value) => {
    const place = parseProjectWindowTarget(value)
    if (place) handOff(target, place)
  })
}
