import type { Approval } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { closeWay, Approvals, type ApprovalOutcome } from "./approvals.js"

const ask = {
  from: "caller",
  terminalId: "target",
  sessionId: "session",
  action: { type: "close" as const },
}

// Collects what a client's stream yields, until it ends.
const collect = (stream: AsyncGenerator<Approval>) => {
  const items: Approval[] = []
  const done = (async () => {
    for await (const item of stream) items.push(item)
  })()
  return { items, done }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe("how a close of another terminal goes", () => {
  it("closes a teammate the caller leads at once, whatever runs there", () => {
    expect(closeWay({ leads: true, agent: "claude" })).toBe("now")
  })

  it("closes a terminal that runs no agent at once", () => {
    expect(closeWay({ leads: false, agent: null })).toBe("now")
  })

  it("asks the user first for any other terminal that runs an agent", () => {
    expect(closeWay({ leads: false, agent: "codex" })).toBe("ask")
    expect(closeWay({ leads: false, agent: "agy" })).toBe("ask")
    expect(closeWay({ leads: false, agent: "claude" })).toBe("ask")
  })
})

describe("asks to close a terminal, on their way to the client", () => {
  it("sends the ask to the client that subscribed last, and settles it with the user's answer", async () => {
    const asks = new Approvals()
    const first = collect(asks.follow("old"))
    const second = collect(asks.follow("new"))
    const outcomes: ApprovalOutcome[] = []
    asks.ask(ask, (outcome) => outcomes.push(outcome))
    await tick()
    expect(first.items).toEqual([])
    expect(second.items).toEqual([{ type: "ask", requestId: expect.any(String), ...ask }])
    const requestId = second.items[0]!.requestId
    // Another client's answer doesn't count.
    expect(() => asks.answer({ requestId, approved: true }, "old")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    asks.answer({ requestId, approved: true }, "new")
    expect(outcomes).toEqual(["confirmed"])
    expect(() => asks.answer({ requestId, approved: true }, "new")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    asks.finish()
    await Promise.all([first.done, second.done])
  })

  it("settles a no as declined", async () => {
    const asks = new Approvals()
    const client = collect(asks.follow("owner"))
    const outcomes: ApprovalOutcome[] = []
    asks.ask(ask, (outcome) => outcomes.push(outcome))
    await tick()
    asks.answer(
      {
        requestId: client.items[0]!.requestId,
        approved: false,
      },
      "owner",
    )
    expect(outcomes).toEqual(["declined"])
    asks.finish()
    await client.done
  })

  it("has no ask to make with no client following, nor a second for a terminal that waits", async () => {
    const asks = new Approvals()
    expect(asks.refusal("target")).toBe("nobody")
    const client = collect(asks.follow("owner"))
    expect(asks.refusal("target")).toBeUndefined()
    asks.ask(ask, () => undefined)
    expect(asks.refusal("target")).toBe("waiting")
    expect(asks.refusal("other")).toBeUndefined()
    asks.finish()
    await client.done
  })

  it("takes an ask back when either terminal closes, and tells the client", async () => {
    const asks = new Approvals()
    const client = collect(asks.follow("owner"))
    const outcomes: ApprovalOutcome[] = []
    asks.ask(ask, (outcome) => outcomes.push(outcome))
    asks.ask({ ...ask, from: "other", terminalId: "elsewhere" }, (outcome) =>
      outcomes.push(outcome),
    )
    await tick()
    asks.withdraw("target")
    asks.withdraw("other")
    expect(outcomes).toEqual(["withdrawn", "withdrawn"])
    await tick()
    expect(client.items.filter((item) => item.type === "withdrawn")).toHaveLength(2)
    expect(asks.refusal("target")).toBeUndefined()
    // Nothing is left to answer.
    const requestId = client.items[0]!.requestId
    expect(() => asks.answer({ requestId, approved: true }, "owner")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    asks.finish()
    await client.done
  })

  it("settles what waits as gone once its client goes away", async () => {
    const asks = new Approvals()
    const controller = new AbortController()
    const client = collect(asks.follow("owner", controller.signal))
    const outcomes: ApprovalOutcome[] = []
    asks.ask(ask, (outcome) => outcomes.push(outcome))
    await tick()
    controller.abort()
    await client.done
    expect(outcomes).toEqual(["gone"])
    expect(asks.refusal("target")).toBe("nobody")
  })

  it("keeps what waits while the client still follows on another stream", async () => {
    const asks = new Approvals()
    const first = new AbortController()
    const one = collect(asks.follow("owner", first.signal))
    const two = collect(asks.follow("owner"))
    const outcomes: ApprovalOutcome[] = []
    asks.ask(ask, (outcome) => outcomes.push(outcome))
    await tick()
    first.abort()
    await one.done
    expect(outcomes).toEqual([])
    asks.release("owner")
    await two.done
    expect(outcomes).toEqual(["gone"])
  })

  it("settles what waits as gone as the runner stops, and follows no more", async () => {
    const asks = new Approvals()
    const client = collect(asks.follow("owner"))
    const outcomes: ApprovalOutcome[] = []
    asks.ask(ask, (outcome) => outcomes.push(outcome))
    asks.finish()
    await client.done
    expect(outcomes).toEqual(["gone"])
    await expect(asks.follow("owner").next()).rejects.toMatchObject({
      code: "CLOSING",
    })
  })
})
