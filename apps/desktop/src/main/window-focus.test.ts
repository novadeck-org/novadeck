import type { IpcMainEvent } from "electron"

import { windowFocusRequestChannel } from "../bridge.js"
import { describe, expect, it } from "../test"
import { registerWindowFocusIpc } from "./window-focus"

const registered = (own: boolean) => {
  const listeners = new Map<string, (event: IpcMainEvent) => void>()
  const requests: string[] = []
  registerWindowFocusIpc(
    { on: (channel, listener) => void listeners.set(channel, listener) },
    {
      window: () => (own ? "window" : undefined),
      request: (window) => void requests.push(window),
    },
  )
  const ask = (): void => listeners.get(windowFocusRequestChannel)?.({} as IpcMainEvent)
  return { ask, requests }
}

describe("answering the page's request for its window's focus", () => {
  it("is for the window the request came from", () => {
    const { ask, requests } = registered(true)
    ask()
    expect(requests).toEqual(["window"])
  })

  it("drops a request from any other sender", () => {
    const { ask, requests } = registered(false)
    ask()
    expect(requests).toEqual([])
  })
})
