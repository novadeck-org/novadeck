import type { UpdateOffer } from "../../../model/update"
import { describe, expect, it } from "../../../test"
import { createDemoUpdates } from "./updates"

const ready = (version: string): UpdateOffer => ({
  kind: "ready",
  version,
  notes: [],
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
