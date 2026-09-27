import { context, describe, expect, it } from "../test"
import { createBootRehearsals } from "./boot-rehearsal"

const failWith = (code: string): Error => new Error(code)
const signal = (): AbortSignal => new AbortController().signal

describe("boot rehearsals", () => {
  it("ask for a fresh boot each time one is armed", () => {
    const rehearsals = createBootRehearsals()
    rehearsals.rehearse({ hold: true })
    rehearsals.rehearse({ fail: "DISCONNECTED" })
    expect(rehearsals.reboots.getSnapshot()).toBe(2)
    rehearsals.release()
  })

  context("holding the splash", () => {
    it("keeps the connection waiting until released", async () => {
      const rehearsals = createBootRehearsals()
      rehearsals.rehearse({ hold: true })
      let connected = false
      const waiting = rehearsals.beforeConnect(signal(), failWith).then(() => {
        connected = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(connected).toBe(false)
      rehearsals.release()
      await waiting
      expect(connected).toBe(true)
    })

    it("lets go on Escape", async () => {
      const rehearsals = createBootRehearsals()
      rehearsals.rehearse({ hold: true })
      const waiting = rehearsals.beforeConnect(signal(), failWith)
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
      await expect(waiting).resolves.toBeUndefined()
    })
  })

  context("failing the next attempt", () => {
    it("fails exactly one attempt with the armed code", async () => {
      const rehearsals = createBootRehearsals()
      rehearsals.rehearse({ fail: "UNAUTHORIZED" })
      await expect(rehearsals.beforeConnect(signal(), failWith)).rejects.toThrow("UNAUTHORIZED")
      await expect(rehearsals.beforeConnect(signal(), failWith)).resolves.toBeUndefined()
    })

    it("is not used up by an attempt abandoned at once, as StrictMode's first is", async () => {
      const rehearsals = createBootRehearsals()
      rehearsals.rehearse({ fail: "DISCONNECTED" })
      const abandoned = new AbortController()
      const first = rehearsals.beforeConnect(abandoned.signal, failWith)
      abandoned.abort()
      await expect(first).resolves.toBeUndefined()
      await expect(rehearsals.beforeConnect(signal(), failWith)).rejects.toThrow("DISCONNECTED")
    })
  })

  it("does nothing before connecting when nothing is armed", async () => {
    await expect(createBootRehearsals().beforeConnect(signal(), failWith)).resolves.toBeUndefined()
  })
})
