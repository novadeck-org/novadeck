import type { UpdateChannel, UpdateOffer } from "@novadeck/core/desktop/update"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { portableScenarios, updateScenarios } from "./scenarios"
import {
  createDemoUpdates,
  downloadMs,
  failAfterMs,
  downloadStep,
  pageUpdateChannel,
} from "./updates"

const ready = (version: string): UpdateOffer => ({
  kind: "ready",
  version,
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
    }
    offer(waiting)
    const heard: UpdateOffer[] = []
    updates.onOffer((each) => heard.push(each))()
    expect(heard).toEqual([waiting])
  })

  it("downloads once allowed, but only for an offer that asks to be allowed", () => {
    vi.useFakeTimers()
    const { updates, offer } = createDemoUpdates()
    const heard: string[] = []
    updates.onOffer((each) => heard.push(each.kind))
    offer({ kind: "available", version: "0.0.80" })
    updates.allow?.()
    vi.advanceTimersByTime(downloadMs)
    expect(heard).toEqual(["available"])
    offer({ kind: "available", version: "0.0.80", allow: true })
    updates.allow?.()
    expect(heard).toEqual(["available", "available", "downloading"])
  })

  it("holds the restart until it is finished, and finishes only while an update waits", () => {
    let restarts = 0
    const { offer, finish } = createDemoUpdates(() => void (restarts += 1))
    finish()
    expect(restarts).toBe(0)
    offer(ready("0.0.80"))
    expect(restarts).toBe(0)
    finish()
    expect(restarts).toBe(1)
  })

  it("offers a download climbing by its step until it is ready, and calls it off for a later offer", () => {
    vi.useFakeTimers()
    const { updates, download, offer } = createDemoUpdates()
    const heard: string[] = []
    updates.onOffer((each) =>
      heard.push(`${each.kind} ${"percent" in each ? each.percent : ""}`.trim()),
    )
    download("0.0.80")
    vi.advanceTimersByTime(downloadMs * 2)
    expect(heard).toEqual(["downloading 0", "downloading 10", "downloading 20"])
    vi.advanceTimersByTime(downloadMs * (100 / downloadStep - 2))
    expect(heard.slice(-2)).toEqual(["downloading 90", "ready"])
    vi.advanceTimersByTime(downloadMs * 5)
    expect(heard).toHaveLength(11)
    download("0.0.81")
    offer(ready("0.0.82"))
    vi.advanceTimersByTime(downloadMs * 20)
    expect(heard.slice(-2)).toEqual(["downloading 0", "ready"])
    expect(heard).toHaveLength(13)
  })

  it("turns a download that fails to retrying, with no percent", () => {
    vi.useFakeTimers()
    const { updates, download, failDownload } = createDemoUpdates()
    const heard: UpdateOffer[] = []
    updates.onOffer((each) => heard.push(each))
    download("0.0.80")
    failDownload("0.0.81")
    vi.advanceTimersByTime(downloadMs * 20)
    expect(heard.at(-1)).toEqual({ kind: "retrying", version: "0.0.80" })
    expect(heard).toHaveLength(2)
  })

  it("fails a held download of its own when none is running, and the running one otherwise", () => {
    vi.useFakeTimers()
    const { updates, download, failDownload } = createDemoUpdates()
    const heard: string[] = []
    updates.onOffer((each) =>
      heard.push(`${each.kind} ${each.version} ${"percent" in each ? each.percent : ""}`.trim()),
    )
    failDownload("0.0.80")
    expect(heard).toEqual(["downloading 0.0.80 40"])
    vi.advanceTimersByTime(failAfterMs)
    expect(heard).toEqual(["downloading 0.0.80 40", "retrying 0.0.80"])
    download("0.0.81")
    failDownload("0.0.82")
    expect(heard.at(-1)).toBe("retrying 0.0.81")
  })

  it("lets a later download be when a held failure is called off", () => {
    vi.useFakeTimers()
    const { updates, download, failDownload } = createDemoUpdates()
    const heard: UpdateOffer[] = []
    updates.onOffer((each) => heard.push(each))
    failDownload("0.0.80")
    download("0.0.81")
    vi.advanceTimersByTime(failAfterMs)
    expect(heard.some((each) => each.kind === "retrying")).toBe(false)
    expect(heard.at(-1)).toMatchObject({ kind: "downloading", version: "0.0.81" })
    vi.advanceTimersByTime(downloadMs * 20)
    expect(heard.at(-1)).toEqual(ready("0.0.81"))
  })

  it("holds a download shown held at 40% for a moment before it fails", () => {
    vi.useFakeTimers()
    const { updates, offer, failDownload } = createDemoUpdates()
    const heard: UpdateOffer[] = []
    updates.onOffer((each) => heard.push(each))
    offer({ kind: "downloading", version: "0.0.80", percent: 40 })
    failDownload("0.0.81")
    expect(heard.at(-1)).toEqual({ kind: "downloading", version: "0.0.81", percent: 40 })
    vi.advanceTimersByTime(failAfterMs)
    expect(heard.at(-1)).toEqual({ kind: "retrying", version: "0.0.81" })
  })

  it("starts on the stable channel and keeps the one it is switched to", async () => {
    const memory: { channel: UpdateChannel } = { channel: "stable" }
    const { updates } = createDemoUpdates(undefined, memory)
    expect(await updates.channel?.get()).toBe("stable")
    updates.channel?.set("experimental")
    expect(await updates.channel?.get()).toBe("experimental")
  })

  it("keeps the page's channel for the next boot's updates, until the page reloads", async () => {
    const first = createDemoUpdates(undefined, pageUpdateChannel)
    first.updates.channel?.set("experimental")
    try {
      const next = createDemoUpdates(undefined, pageUpdateChannel)
      expect(await next.updates.channel?.get()).toBe("experimental")
      expect(next.channel()).toBe("experimental")
      // Without the page's memory, as a spec's backend, each starts stable.
      expect(createDemoUpdates().channel()).toBe("stable")
    } finally {
      first.updates.channel?.set("stable")
    }
  })

  it("answers what's new only once shown, until it is dismissed, and counts what was asked", async () => {
    const { whatsNew, showWhatsNew, whatsNewCalls } = createDemoUpdates()
    expect(await whatsNew.get()).toBeUndefined()
    showWhatsNew("0.0.80")
    const notes = await whatsNew.get()
    expect(notes?.version).toBe("0.0.80")
    expect(notes?.highlights).toHaveLength(3)
    whatsNew.dismiss()
    expect(await whatsNew.get()).toBeUndefined()
    expect(whatsNewCalls).toEqual({ dismissed: 1, asked: 3 })
  })

  it("answers the version updated from when one is given", async () => {
    const { whatsNew, showWhatsNew } = createDemoUpdates()
    showWhatsNew("0.0.80")
    expect(await whatsNew.get()).not.toHaveProperty("from")
    showWhatsNew("0.0.80", { from: "0.0.79" })
    expect((await whatsNew.get())?.from).toBe("0.0.79")
  })
})

describe("the update scenarios", () => {
  it("leave a reboot to the panel's mark, never naming it in a hint", () => {
    for (const { label, hint } of [
      ...Object.values(updateScenarios),
      ...Object.values(portableScenarios),
    ])
      expect(hint, label).not.toMatch(/\breboots?\b|boots the demo/i)
  })
})
