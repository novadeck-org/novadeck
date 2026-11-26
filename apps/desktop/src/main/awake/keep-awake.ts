import type { IpcMainEvent } from "electron"

import { keepAwakeChannel } from "../../bridge.js"

/** A hold that keeps the computer from sleeping on its own until it is released. */
export type Hold = { release(): void }

/**
 * Keeps the computer awake while the person wants it (Preferences, which the page reports)
 * and an agent is at work (which the runner reports): `hold` takes a hold once both are
 * true, and it is released as soon as either isn't, or at `end`. The screen still dims, turns
 * off and locks as it would; only the computer's own sleep waits.
 */
export const createKeepAwake = (hold: () => Hold) => {
  let wanted = false
  let working = false
  let held: Hold | undefined
  const settle = (): void => {
    if (wanted && working) held ??= hold()
    else {
      held?.release()
      held = undefined
    }
  }
  return {
    /** Whether the person wants it, as the page last said. */
    wanted(value: boolean): void {
      wanted = value
      settle()
    },
    /** Whether an agent is at work, as the runner last said. */
    working(value: boolean): void {
      working = value
      settle()
    },
    /** Whether a hold is taken now. */
    holding: (): boolean => held !== undefined,
    /** Releases any hold, as the app quits. */
    end(): void {
      wanted = false
      settle()
    },
  }
}

type KeepAwakeIpc = {
  on(channel: string, listener: (event: IpcMainEvent, value: unknown) => void): unknown
}

/**
 * Follows the page's word on whether the person wants the computer kept awake. `fromApp`
 * tells a report of the app's own page from any other's, which is dropped, as is anything
 * but a boolean.
 */
export const registerKeepAwakeIpc = (
  ipc: KeepAwakeIpc,
  fromApp: (event: IpcMainEvent) => boolean,
  wanted: (value: boolean) => void,
): void => {
  ipc.on(keepAwakeChannel, (event, value) => {
    if (fromApp(event) && typeof value === "boolean") wanted(value)
  })
}
