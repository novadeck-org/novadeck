import { setTimeout as sleep } from "node:timers/promises"

import { describe, expect, it } from "../test.js"
import { InputQueue, type HoldBudget, type InputHold } from "./input-queue.js"

/** A queue over a terminal host that records its holds: who took them, with what, and their end. */
const queued = () => {
  const events: string[] = []
  const budgets: { terminalId: string; budget: HoldBudget }[] = []
  const holds: InputHold[] = []
  const queue = new InputQueue({
    hold: (terminalId, budget) => {
      budgets.push({ terminalId, budget })
      const hold: InputHold = {
        release: () => events.push(`release ${terminalId}`),
        settle: () => events.push(`settle ${terminalId}`),
        settleAfter: () => {},
        holding: () => true,
        discard: () => {},
      }
      holds.push(hold)
      return hold
    },
  })
  return { queue, events, budgets, holds }
}

/** An entry that records its start and its end, with `ms` between. */
const entry =
  (events: string[], name: string, ms = 10) =>
  async () => {
    events.push(`${name} starts`)
    await sleep(ms)
    events.push(`${name} ends`)
    return name
  }

const budget: HoldBudget = { inputMs: 100, sizeMs: 200 }

describe("the input queue", () => {
  it("runs the entries of one terminal one at a time, in the order they came", async () => {
    const { queue, events } = queued()
    const results = await Promise.all([
      queue.run("t", entry(events, "first", 30)),
      queue.run("t", entry(events, "second", 5)),
      queue.run("t", entry(events, "third", 1)),
    ])
    expect(results).toEqual(["first", "second", "third"])
    expect(events).toEqual([
      "first starts",
      "first ends",
      "second starts",
      "second ends",
      "third starts",
      "third ends",
    ])
  })

  it("lets the entries of different terminals go side by side", async () => {
    const { queue, events } = queued()
    await Promise.all([
      queue.run("a", entry(events, "a", 30)),
      queue.run("b", entry(events, "b", 5)),
    ])
    expect(events).toEqual(["a starts", "b starts", "b ends", "a ends"])
  })

  it("starts the next entry after one that failed, which fails only its own caller", async () => {
    const { queue, events } = queued()
    const failing = queue.run("t", () => Promise.reject(new Error("no")))
    const next = queue.run("t", entry(events, "next"))
    await expect(failing).rejects.toThrow("no")
    expect(await next).toBe("next")
    expect(events).toEqual(["next starts", "next ends"])
  })

  it("starts an entry given once the terminal is idle again at once", async () => {
    const { queue, events } = queued()
    await queue.run("t", entry(events, "first", 1))
    await sleep(5)
    await queue.run("t", entry(events, "later", 1))
    expect(events).toEqual(["first starts", "first ends", "later starts", "later ends"])
  })

  it("takes a hold for an entry with the budget asked, only once it is its turn", async () => {
    const { queue, events, budgets } = queued()
    const first = queue.run("t", async (turn) => {
      turn.hold(budget)
      await sleep(20)
    })
    const second = queue.run("t", (turn) => {
      events.push(`second begins after ${budgets.length} hold`)
      turn.hold({ ...budget, deferred: true })
      return Promise.resolve()
    })
    await sleep(5)
    expect(budgets).toEqual([{ terminalId: "t", budget }])
    await Promise.all([first, second])
    expect(budgets).toEqual([
      { terminalId: "t", budget },
      { terminalId: "t", budget: { ...budget, deferred: true } },
    ])
    expect(events).toContain("second begins after 1 hold")
  })

  it("lets go of the input every hold of an entry took when it ends, without settling the resizes", async () => {
    const { queue, events } = queued()
    await queue.run("t", (turn) => {
      turn.hold(budget)
      turn.hold(budget)
      return Promise.resolve()
    })
    expect(events).toEqual(["release t", "release t"])
  })

  it("lets go of the input of an entry that fails, too", async () => {
    const { queue, events } = queued()
    await expect(
      queue.run("t", (turn) => {
        turn.hold(budget)
        return Promise.reject(new Error("no"))
      }),
    ).rejects.toThrow("no")
    expect(events).toEqual(["release t"])
  })

  it("takes no hold for an entry that asks for none", async () => {
    const { queue, budgets } = queued()
    await queue.run("t", () => Promise.resolve())
    expect(budgets).toEqual([])
  })
})
