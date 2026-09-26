import type { TerminalEvent } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { Subscription } from "./subscription.js"

const output = (sequence: number): TerminalEvent => {
  return { terminalId: "terminal", sequence, type: "output", data: "x".repeat(100) }
}

const snapshot = (): TerminalEvent => ({
  terminalId: "terminal",
  sequence: 0,
  type: "snapshot",
  data: "s".repeat(1024),
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
})

describe("terminal subscription", () => {
  it("accepts a separately bounded initial snapshot and waits for its ACK before live delivery", async () => {
    const initial = snapshot()
    const event = output(1)
    const limit = Buffer.byteLength(JSON.stringify(event))
    const subscription = new Subscription("observe", limit, limit, () => {}, 2048)
    subscription.push(initial)
    subscription.push(event)
    expect(await subscription.next()).toEqual(initial)
    let delivered = false
    const pending = subscription.next().then((result) => {
      delivered = true
      return result
    })
    await Promise.resolve()
    expect(delivered).toBe(false)
    subscription.ack(0)
    expect(await pending).toEqual(event)
    subscription.cancel()
  })

  it("still bounds the live backlog while an oversized initial snapshot awaits ACK", async () => {
    const event = output(1)
    const limit = Buffer.byteLength(JSON.stringify(event))
    const subscription = new Subscription("observe", limit, limit, () => {}, 2048)
    subscription.push(snapshot())
    await subscription.next()
    subscription.push(event)
    subscription.push(output(2))
    await expect(subscription.next()).rejects.toMatchObject({ code: "SLOW_CONSUMER" })
  })

  it("rejects a snapshot beyond its own allowance with an explicit size error", async () => {
    const subscription = new Subscription("observe", 4096, 4096, () => {}, 256)
    subscription.push(snapshot())
    await expect(subscription.next()).rejects.toMatchObject({ code: "SNAPSHOT_TOO_LARGE" })
  })

  it("holds delivery at the ACK window and resumes after a cumulative ACK", async () => {
    const first = output(1)
    const subscription = new Subscription(
      "observe",
      4096,
      Buffer.byteLength(JSON.stringify(first)),
      () => {},
    )
    subscription.push(first)
    subscription.push(output(2))
    expect(await subscription.next()).toEqual(first)
    let resolved = false
    const pending = subscription.next().then((event) => {
      resolved = true
      return event
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(() => subscription.ack(2)).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }))
    subscription.ack(1)
    expect(await pending).toEqual(output(2))
    subscription.cancel()
  })

  it("counts sent but unacknowledged events against the memory limit", async () => {
    const event = output(1)
    let detached = false
    const subscription = new Subscription(
      "control",
      Buffer.byteLength(JSON.stringify(event)),
      4096,
      () => {
        detached = true
      },
    )
    subscription.push(event)
    await subscription.next()
    subscription.push(output(2))
    expect(detached).toBe(true)
    await expect(subscription.next()).rejects.toMatchObject({ code: "SLOW_CONSUMER" })
  })

  it("wakes a pending delivery when its connection disappears", async () => {
    const subscription = new Subscription("observe", 4096, 1024, () => {})
    const pending = subscription.next()
    subscription.cancel()
    expect(await pending).toBeUndefined()
  })
})
