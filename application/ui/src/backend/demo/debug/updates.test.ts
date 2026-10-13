import { afterEach, vi } from "vitest"

import type { UpdateOffer } from "../../../model/update"
import { describe, expect, it } from "../../../test"
import { createDemoUpdates, downloadMs, downloadStep } from "./updates"

const ready = (version: string): UpdateOffer => ({
  kind: "ready",
  version,
  notes: [],
})

afterEach(() => {
  vi.useRealTimers()
})

describe("demo updates", () => {
  it("tells a listener of an update offered, then of a newer one", () => {
    const { updates, offer } = createDemoUpdates()
    const heard: string[] = []
    const stop = updates.onOffer((each) => heard.push(each.version))
    offer(ready("0.0.80"))
    offer(ready("0.0.81"))
    stop()
    offer(ready("0.0.82"))
    expect(heard).toEqual(["0.0.80", "0.0.81"])
  })

  it("tells a listener that comes later of the update already waiting", () => {
    const { updates, offer } = createDemoUpdates()
    const waiting: UpdateOffer = {
      kind: "available",
      version: "0.0.80",
      notes: ["One."],
    }
    offer(waiting)
    const heard: UpdateOffer[] = []
    updates.onOffer((each) => heard.push(each))()
    expect(heard).toEqual([waiting])
  })

  it("holds the restart until it is finished, and finishes only while an update waits", () => {
    let restarts = 0
    const { updates, offer, finish } = createDemoUpdates(() => void (restarts += 1))
    finish()
    expect(restarts).toBe(0)
    offer(ready("0.0.80"))
    updates.install()
    expect(restarts).toBe(0)
    finish()
    expect(restarts).toBe(1)
  })

  it("offers the update waiting again as one to download once its install failed", () => {
    const { updates, offer, failInstall } = createDemoUpdates()
    const heard: string[] = []
    updates.onOffer((each) => heard.push(`${each.kind} ${each.version}`))
    failInstall()
    offer(ready("0.0.80"))
    failInstall()
    expect(heard).toEqual(["ready 0.0.80", "available 0.0.80"])
  })

  it("offers a download climbing by its step until it is ready, and calls it off for a later offer", () => {
    vi.useFakeTimers()
    const { updates, download, offer } = createDemoUpdates()
    const heard: string[] = []
    updates.onOffer((each) => heard.push(`${each.kind} ${each.percent ?? ""}`.trim()))
    download("0.0.80", [])
    vi.advanceTimersByTime(downloadMs * 2)
    expect(heard).toEqual(["downloading 0", "downloading 10", "downloading 20"])
    vi.advanceTimersByTime(downloadMs * (100 / downloadStep - 2))
    expect(heard.slice(-2)).toEqual(["downloading 90", "ready"])
    vi.advanceTimersByTime(downloadMs * 5)
    expect(heard).toHaveLength(11)
    download("0.0.81", [])
    offer(ready("0.0.82"))
    vi.advanceTimersByTime(downloadMs * 20)
    expect(heard.slice(-2)).toEqual(["downloading 0", "ready"])
    expect(heard).toHaveLength(13)
  })

  it("turns a download that fails to the update to fetch by hand, with no percent", () => {
    vi.useFakeTimers()
    const { updates, download, failInstall } = createDemoUpdates()
    const heard: UpdateOffer[] = []
    updates.onOffer((each) => heard.push(each))
    download("0.0.80", [])
    failInstall()
    vi.advanceTimersByTime(downloadMs * 20)
    expect(heard.at(-1)).toEqual({ kind: "available", version: "0.0.80", notes: [] })
    expect(heard).toHaveLength(2)
  })

  it("counts the release pages it was asked to open", () => {
    const { updates, pagesOpened } = createDemoUpdates()
    updates.openPage()
    expect(pagesOpened()).toBe(1)
  })

  it("starts on the stable channel and keeps the one it is switched to", async () => {
    const { updates } = createDemoUpdates()
    expect(await updates.channel?.get()).toBe("stable")
    updates.channel?.set("early")
    expect(await updates.channel?.get()).toBe("early")
  })
})
