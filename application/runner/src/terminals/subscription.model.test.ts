import type { TerminalEvent } from "@novadeck/protocol"
import * as fc from "fast-check"

import { describe, expect, it } from "../test.js"
import { Subscription } from "./subscription.js"

type Model = {
  queued: TerminalEvent[]
  unacknowledged: TerminalEvent[]
  received: (TerminalEvent | undefined | string)[]
  reading: boolean
  ended: boolean
  snapshot: boolean
  error: string | undefined
  sequence: number
  delivered: number
  acknowledged: number
  limit: number
  window: number
  allowance: number
}
type Real = {
  subscription: Subscription
  received: Model["received"]
  detached: number
}
type Action =
  | { type: "output" | "snapshot"; length: number }
  | { type: "read" | "finish" | "cancel" }
  | { type: "ack"; cursor: "latest" | "partial" | "stale" | "future" }

const bytes = (events: TerminalEvent[]): number =>
  events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0)

const clear = (model: Model): void => {
  model.queued = []
  model.unacknowledged = []
  model.ended = true
}

// The oracle keeps a ledger of accepted and delivered events, rather than the
// subscription's byte counters. An ACK retires a prefix of that ledger.
const deliver = (model: Model): void => {
  if (!model.reading) return
  if (model.error) {
    model.received.push(model.error)
    model.reading = false
    return
  }
  const event = model.queued[0]
  const outstanding = bytes(model.unacknowledged)
  if (event && (outstanding === 0 || outstanding + bytes([event]) <= model.window)) {
    model.queued.shift()
    model.unacknowledged.push(event)
    model.delivered = event.sequence
    model.received.push(event)
    model.reading = false
  } else if (!event && model.ended) {
    model.received.push(undefined)
    model.reading = false
  }
}

const push = (model: Model, action: Extract<Action, { length: number }>): TerminalEvent => {
  const sequence = model.sequence++
  const event: TerminalEvent =
    action.type === "snapshot"
      ? {
          terminalId: "terminal",
          sequence,
          type: "snapshot",
          data: "界".repeat(action.length),
          cols: 80,
          rows: 24,
          status: "running",
          exitCode: null,
        }
      : { terminalId: "terminal", sequence, type: "output", data: "界".repeat(action.length) }
  if (model.ended || model.error) return event
  const live = [...model.queued, ...model.unacknowledged].filter(
    (accepted) => accepted.type !== "snapshot",
  )
  if (event.type === "snapshot" && bytes([event]) > model.allowance)
    model.error = "SNAPSHOT_TOO_LARGE"
  else if (
    event.type === "snapshot" &&
    (model.snapshot || model.queued.length > 0 || model.delivered >= 0)
  )
    model.error = "SLOW_CONSUMER"
  else if (event.type !== "snapshot" && bytes([...live, event]) > model.limit)
    model.error = "SLOW_CONSUMER"
  if (model.error) clear(model)
  else {
    model.queued.push(event)
    if (event.type === "snapshot") model.snapshot = true
  }
  return event
}

class Step implements fc.AsyncCommand<Model, Real> {
  constructor(private readonly action: Action) {}

  check(model: Readonly<Model>): boolean {
    return this.action.type !== "read" || !model.reading
  }

  async run(model: Model, real: Real): Promise<void> {
    const action = this.action
    if (action.type === "output" || action.type === "snapshot") {
      real.subscription.push(push(model, action))
    } else if (action.type === "read") {
      model.reading = true
      void real.subscription.next().then(
        (event) => real.received.push(event),
        (error: { code: string }) => real.received.push(error.code),
      )
    } else if (action.type === "cancel") {
      clear(model)
      real.subscription.cancel()
    } else if (action.type === "finish") {
      model.ended = true
      real.subscription.finish()
    } else if (action.type === "ack") {
      const sequence =
        action.cursor === "future"
          ? model.delivered + 1
          : action.cursor === "partial"
            ? (model.unacknowledged[Math.floor(model.unacknowledged.length / 2)]?.sequence ??
              model.delivered)
            : action.cursor === "stale"
              ? model.acknowledged
              : model.delivered
      if (sequence > model.delivered)
        expect(() => real.subscription.ack(sequence)).toThrow(
          expect.objectContaining({ code: "INVALID_CURSOR" }),
        )
      else {
        if (sequence > model.acknowledged) {
          model.acknowledged = sequence
          model.unacknowledged = model.unacknowledged.filter((event) => event.sequence > sequence)
        }
        real.subscription.ack(sequence)
      }
    }
    deliver(model)
    // Observe the result of one pending next() without timers or a second reader.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(real.received).toEqual(model.received)
    expect(real.detached).toBe(model.error === undefined ? 0 : 1)
  }

  toString(): string {
    return JSON.stringify(this.action)
  }
}

const steps = fc.commands(
  [
    fc.record({ type: fc.constant("output" as const), length: fc.integer({ min: 0, max: 160 }) }),
    fc.record({ type: fc.constant("snapshot" as const), length: fc.integer({ min: 0, max: 600 }) }),
    fc.constant({ type: "read" as const }),
    fc.record({
      type: fc.constant("ack" as const),
      cursor: fc.constantFrom(
        "latest" as const,
        "partial" as const,
        "stale" as const,
        "future" as const,
      ),
    }),
    fc.constant({ type: "cancel" as const }),
    fc.constant({ type: "finish" as const }),
  ].map((arbitrary) => arbitrary.map((action) => new Step(action))),
  { maxCommands: 45 },
)

describe("generated terminal subscription sequences", () => {
  it("preserves byte limits, the ACK window, and termination across generated event histories", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          limit: fc.integer({ min: 100, max: 1400 }),
          window: fc.integer({ min: 100, max: 700 }),
          allowance: fc.integer({ min: 150, max: 2200 }),
        }),
        steps,
        async (limits, commands) => {
          const model: Model = {
            ...limits,
            queued: [],
            unacknowledged: [],
            received: [],
            reading: false,
            ended: false,
            snapshot: false,
            error: undefined,
            sequence: 0,
            delivered: -1,
            acknowledged: -1,
          }
          const real: Real = {
            received: [],
            detached: 0,
            subscription: new Subscription(
              "observe",
              limits.limit,
              limits.window,
              () => {
                real.detached += 1
              },
              limits.allowance,
            ),
          }
          try {
            await fc.asyncModelRun(() => ({ model, real }), commands)
          } finally {
            real.subscription.cancel()
          }
        },
      ),
      { numRuns: 150 },
    )
  })
})
