import type { IpcMainEvent } from "electron"

import {
  projectWindowHandOffChannel,
  projectWindowOpenChannel,
  projectWindowShowChannel,
  projectWindowsRequestChannel,
  projectWindowsUseChannel,
  projectWindowSwapChannel,
} from "../../bridge.js"
import { describe, expect, it } from "../../test"
import { registerProjectWindowsIpc } from "./project-windows-ipc"

const registered = (own: boolean) => {
  const listeners = new Map<string, (event: IpcMainEvent, value: unknown) => void>()
  const calls: unknown[][] = []
  registerProjectWindowsIpc(
    { on: (channel, listener) => void listeners.set(channel, listener) },
    {
      window: () => (own ? "window" : undefined),
      ask: (window) => void calls.push(["ask", window]),
      show: (window, id, known) => void calls.push(["show", window, id, known]),
      use: (on) => void calls.push(["use", on]),
      open: (window, id) => void calls.push(["open", window, id]),
      swap: (window, id) => void calls.push(["swap", window, id]),
      handOff: (window, target) => void calls.push(["handOff", window, target]),
    },
  )
  const send = (channel: string, value?: unknown): void =>
    listeners.get(channel)?.({} as IpcMainEvent, value)
  return { send, calls }
}

describe("the pages' project window requests", () => {
  it("reach the app for the window they came from", () => {
    const { send, calls } = registered(true)
    send(projectWindowsRequestChannel)
    send(projectWindowShowChannel, { projectId: "p1", known: ["p1", "p2"] })
    send(projectWindowShowChannel, { projectId: null, known: [] })
    send(projectWindowsUseChannel, true)
    send(projectWindowOpenChannel, "p2")
    send(projectWindowSwapChannel, "p3")
    send(projectWindowHandOffChannel, { projectId: "p4", terminalId: "t" })
    expect(calls).toEqual([
      ["ask", "window"],
      ["show", "window", "p1", ["p1", "p2"]],
      ["show", "window", undefined, []],
      ["use", true],
      ["open", "window", "p2"],
      ["swap", "window", "p3"],
      ["handOff", "window", { projectId: "p4", terminalId: "t" }],
    ])
  })

  it("are dropped from any other sender", () => {
    const { send, calls } = registered(false)
    send(projectWindowsRequestChannel)
    send(projectWindowOpenChannel, "p2")
    expect(calls).toEqual([])
  })

  it("are dropped when what they carry is not what the contract allows", () => {
    const { send, calls } = registered(true)
    send(projectWindowShowChannel, 7)
    send(projectWindowShowChannel, { projectId: "", known: [] })
    send(projectWindowsUseChannel, "yes")
    send(projectWindowOpenChannel, "")
    send(projectWindowSwapChannel, { id: "p" })
    send(projectWindowHandOffChannel, { terminalId: "t" })
    expect(calls).toEqual([])
  })
})
