import type { IpcMainInvokeEvent } from "electron"

import { debugKillRunnerChannel } from "../bridge.js"
import { context, describe, expect, it } from "../test"
import { debugEnabled, registerDebugIpc } from "./debug"

const event = {} as IpcMainInvokeEvent

describe("debug panel gating", () => {
  context("in development", () => {
    it("is always on", () => {
      expect(debugEnabled({ argv: [], env: {}, packaged: false })).toBe(true)
    })
  })

  context("in a packaged app", () => {
    it("is off unless asked for", () => {
      expect(debugEnabled({ argv: ["novadeck"], env: {}, packaged: true })).toBe(false)
      expect(debugEnabled({ argv: [], env: { NOVADECK_DEBUG: "0" }, packaged: true })).toBe(false)
    })

    it("turns on with --debug-panel or NOVADECK_DEBUG=1", () => {
      expect(debugEnabled({ argv: ["novadeck", "--debug-panel"], env: {}, packaged: true })).toBe(
        true,
      )
      expect(debugEnabled({ argv: [], env: { NOVADECK_DEBUG: "1" }, packaged: true })).toBe(true)
    })
  })
})

// The debug handlers registered on a stand-in for ipcMain.
const registered = (enabled: boolean, allowed = true) => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>()
  let kills = 0
  registerDebugIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener) },
    { enabled, allowed: () => allowed, killRunner: () => (kills += 1) > 0 },
  )
  return { handlers, kills: () => kills }
}

describe("debug requests from the page", () => {
  it("are not handled at all while the panel is off", () => {
    expect([...registered(false).handlers.keys()]).toEqual([])
  })

  it("kill the runner for the app's own page", () => {
    const { handlers, kills } = registered(true)
    expect(handlers.get(debugKillRunnerChannel)?.(event)).toBe(true)
    expect(kills()).toBe(1)
  })

  it("do nothing for any other sender", () => {
    const { handlers, kills } = registered(true, false)
    expect(handlers.get(debugKillRunnerChannel)?.(event)).toBe(false)
    expect(kills()).toBe(0)
  })
})
