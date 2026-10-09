import { describe, expect, it } from "../../../test"
import { createDemoUpdates } from "./updates"

describe("demo updates", () => {
  it("tells a listener of an update offered, then of a newer one", () => {
    const { updates, offer } = createDemoUpdates()
    const heard: string[] = []
    const stop = updates.onReady((version) => heard.push(version))
    offer("0.0.80")
    offer("0.0.81")
    stop()
    offer("0.0.82")
    expect(heard).toEqual(["0.0.80", "0.0.81"])
  })

  it("tells a listener that comes later of the update already waiting", () => {
    const { updates, offer } = createDemoUpdates()
    offer("0.0.80")
    const heard: string[] = []
    updates.onReady((version) => heard.push(version))()
    expect(heard).toEqual(["0.0.80"])
  })

  it("holds the restart until it is finished, and finishes only while an update waits", () => {
    let restarts = 0
    const { updates, offer, finish } = createDemoUpdates(() => void (restarts += 1))
    finish()
    expect(restarts).toBe(0)
    offer("0.0.80")
    updates.install()
    expect(restarts).toBe(0)
    finish()
    expect(restarts).toBe(1)
  })
})
