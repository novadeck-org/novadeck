import type { IpcMainEvent } from "electron"

import { keepAwakeChannel } from "../../bridge.js"
import { context, describe, expect, it } from "../../test"
import { createKeepAwake, registerKeepAwakeIpc } from "./keep-awake"

// A keep-awake whose holds are counted: taken, and released.
const counted = () => {
  const holds = { taken: 0, released: 0 }
  const keepAwake = createKeepAwake(() => {
    holds.taken += 1
    return { release: () => void (holds.released += 1) }
  })
  return { keepAwake, holds }
}

describe("keeping the computer awake", () => {
  context("while the person wants it", () => {
    it("holds once an agent works, and lets go once none does", () => {
      const { keepAwake, holds } = counted()
      keepAwake.wanted(true)
      expect(keepAwake.holding()).toBe(false)
      keepAwake.working(true)
      expect(keepAwake.holding()).toBe(true)
      keepAwake.working(false)
      expect(keepAwake.holding()).toBe(false)
      expect(holds).toEqual({ taken: 1, released: 1 })
    })

    it("takes one hold however often it is told", () => {
      const { keepAwake, holds } = counted()
      keepAwake.working(true)
      keepAwake.wanted(true)
      keepAwake.wanted(true)
      keepAwake.working(true)
      expect(holds).toEqual({ taken: 1, released: 0 })
    })
  })

  context("while the person doesn't want it", () => {
    it("never holds, however agents work", () => {
      const { keepAwake, holds } = counted()
      keepAwake.working(true)
      keepAwake.wanted(false)
      expect(holds).toEqual({ taken: 0, released: 0 })
    })

    it("lets go as soon as they turn it off mid-turn", () => {
      const { keepAwake, holds } = counted()
      keepAwake.wanted(true)
      keepAwake.working(true)
      keepAwake.wanted(false)
      expect(keepAwake.holding()).toBe(false)
      expect(holds).toEqual({ taken: 1, released: 1 })
    })
  })

  it("lets go as the app quits, and takes no hold after", () => {
    const { keepAwake, holds } = counted()
    keepAwake.wanted(true)
    keepAwake.working(true)
    keepAwake.end()
    keepAwake.working(true)
    expect(holds).toEqual({ taken: 1, released: 1 })
  })
})

describe("the page's word on keeping the computer awake", () => {
  const registered = (own: boolean) => {
    const listeners = new Map<string, (event: IpcMainEvent, value: unknown) => void>()
    const wanted: boolean[] = []
    registerKeepAwakeIpc(
      { on: (channel, listener) => void listeners.set(channel, listener) },
      () => own,
      (value) => void wanted.push(value),
    )
    return {
      report: (value: unknown) => listeners.get(keepAwakeChannel)?.({} as IpcMainEvent, value),
      wanted,
    }
  }

  it("is followed from the app's own page", () => {
    const { report, wanted } = registered(true)
    report(true)
    report(false)
    expect(wanted).toEqual([true, false])
  })

  it("is dropped from any other page, or when it isn't a boolean", () => {
    const other = registered(false)
    other.report(true)
    expect(other.wanted).toEqual([])
    const own = registered(true)
    for (const bad of [undefined, null, 1, "true", {}]) own.report(bad)
    expect(own.wanted).toEqual([])
  })
})
