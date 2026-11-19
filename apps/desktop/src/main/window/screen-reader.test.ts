import type { IpcMainEvent } from "electron"

import { screenReaderChannel, screenReaderRequestChannel } from "../../bridge.js"
import { describe, expect, it } from "../../test"
import { registerScreenReaderIpc } from "./screen-reader"

type Told = { readonly page: string; readonly running: boolean }

const registered = ({ own = true, running = false }: { own?: boolean; running?: boolean }) => {
  const listeners = new Map<string, (event: IpcMainEvent) => void>()
  let changed: ((event: unknown, enabled: boolean) => void) | undefined
  let enabled = running
  const told: Told[] = []
  const pageNamed = (name: string) => ({
    send: (channel: string, value: boolean) => {
      if (channel === screenReaderChannel) told.push({ page: name, running: value })
    },
  })
  registerScreenReaderIpc(
    { on: (channel, listener) => void listeners.set(channel, listener) },
    {
      isAccessibilitySupportEnabled: () => enabled,
      on: (_event, listener) => {
        changed = listener
      },
    },
    {
      page: () => (own ? pageNamed("asking") : undefined),
      pages: () => [pageNamed("first"), pageNamed("second")],
    },
  )
  const ask = (): void => listeners.get(screenReaderRequestChannel)?.({} as IpcMainEvent)
  const change = (next: boolean): void => {
    enabled = next
    changed?.({}, next)
  }
  return { ask, change, told }
}

describe("telling the app's pages whether a screen reader runs", () => {
  it("answers a page's request with whether one runs now", () => {
    const { ask, told } = registered({ running: true })
    ask()
    expect(told).toEqual([{ page: "asking", running: true }])
  })

  it("drops a request from any other sender", () => {
    const { ask, told } = registered({ own: false })
    ask()
    expect(told).toEqual([])
  })

  it("tells every page when one starts or stops", () => {
    const { change, told } = registered({})
    change(true)
    change(false)
    expect(told).toEqual([
      { page: "first", running: true },
      { page: "second", running: true },
      { page: "first", running: false },
      { page: "second", running: false },
    ])
  })
})
