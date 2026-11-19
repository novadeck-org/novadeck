import type { Approval } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { closeWay, Approvals, type ApprovalOutcome } from "./approvals.js"

const request = {
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

// Where agents ask the person (Herd and Solo), for a terminal the person opened.
const asking = { byPerson: true, swarm: false }

describe("how a close of another terminal goes", () => {
  it("closes a teammate the caller leads at once, whatever runs there", () => {
    expect(closeWay({ leads: true, agent: "claude", busy: false, ...asking })).toBe("now")
  })

  it("closes a shell at its prompt at once", () => {
    expect(closeWay({ leads: false, agent: null, busy: false, ...asking })).toBe("now")
  })

  it("asks the person first for a program other than the shell, such as ssh or a server", () => {
    expect(closeWay({ leads: false, agent: null, busy: true, ...asking })).toBe("request")
  })

  it("closes a busy teammate the caller leads at once", () => {
    expect(closeWay({ leads: true, agent: null, busy: true, ...asking })).toBe("now")
  })

  it("asks the person first for any other terminal that runs an agent", () => {
    expect(closeWay({ leads: false, agent: "codex", busy: false, ...asking })).toBe("request")
    expect(closeWay({ leads: false, agent: "agy", busy: false, ...asking })).toBe("request")
    expect(closeWay({ leads: false, agent: "claude", busy: false, ...asking })).toBe("request")
  })
})

describe("how a close goes where agents decide for themselves", () => {
  const swarm = { swarm: true }

  it("closes at once any terminal an agent opened, whatever runs there", () => {
    const opened = { ...swarm, byPerson: false }
    expect(closeWay({ leads: false, agent: "claude", busy: false, ...opened })).toBe("now")
    expect(closeWay({ leads: false, agent: "codex", busy: false, ...opened })).toBe("now")
    expect(closeWay({ leads: false, agent: null, busy: true, ...opened })).toBe("now")
  })

  it("still asks the person first for an agent or a program in a terminal the person opened", () => {
    const theirs = { ...swarm, byPerson: true }
    expect(closeWay({ leads: false, agent: "agy", busy: false, ...theirs })).toBe("request")
    expect(closeWay({ leads: false, agent: null, busy: true, ...theirs })).toBe("request")
  })

  it("closes a teammate it leads, or a plain shell, at once, whoever opened it", () => {
    const theirs = { ...swarm, byPerson: true }
    expect(closeWay({ leads: true, agent: "claude", busy: false, ...theirs })).toBe("now")
    expect(closeWay({ leads: false, agent: null, busy: false, ...theirs })).toBe("now")
  })
})

describe("requests to close a terminal, on their way to the client", () => {
  it("sends the request to the client that subscribed last, and settles it with the person's answer", async () => {
    const approvals = new Approvals()
    const first = collect(approvals.follow("old"))
    const second = collect(approvals.follow("new"))
    const outcomes: ApprovalOutcome[] = []
    approvals.request(request, (outcome) => outcomes.push(outcome))
    await tick()
    expect(first.items).toEqual([])
    expect(second.items).toEqual([{ type: "request", requestId: expect.any(String), ...request }])
    const requestId = second.items[0]!.requestId
    // Another client's answer doesn't count.
    expect(() => approvals.answer({ requestId, approved: true }, "old")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    approvals.answer({ requestId, approved: true }, "new")
    expect(outcomes).toEqual(["confirmed"])
    expect(() => approvals.answer({ requestId, approved: true }, "new")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    approvals.finish()
    await Promise.all([first.done, second.done])
  })

  it("settles a no as declined", async () => {
    const approvals = new Approvals()
    const client = collect(approvals.follow("owner"))
    const outcomes: ApprovalOutcome[] = []
    approvals.request(request, (outcome) => outcomes.push(outcome))
    await tick()
    approvals.answer(
      {
        requestId: client.items[0]!.requestId,
        approved: false,
      },
      "owner",
    )
    expect(outcomes).toEqual(["declined"])
    approvals.finish()
    await client.done
  })

  it("knows a terminal it waits for or on, until the request settles", async () => {
    const approvals = new Approvals()
    const client = collect(approvals.follow("owner"))
    expect(approvals.involves("target")).toBe(false)
    approvals.request(request, () => undefined)
    expect(approvals.involves("target")).toBe(true)
    expect(approvals.involves("caller")).toBe(true)
    expect(approvals.involves("other")).toBe(false)
    approvals.withdraw("target")
    expect(approvals.involves("caller")).toBe(false)
    approvals.finish()
    await client.done
  })

  it("has no request to make with no client following, nor a second for a terminal that waits", async () => {
    const approvals = new Approvals()
    expect(approvals.refusal("target")).toBe("nobody")
    const client = collect(approvals.follow("owner"))
    expect(approvals.refusal("target")).toBeUndefined()
    approvals.request(request, () => undefined)
    expect(approvals.refusal("target")).toBe("waiting")
    expect(approvals.refusal("other")).toBeUndefined()
    approvals.finish()
    await client.done
  })

  it("takes a request back when either terminal closes, and tells the client", async () => {
    const approvals = new Approvals()
    const client = collect(approvals.follow("owner"))
    const outcomes: ApprovalOutcome[] = []
    approvals.request(request, (outcome) => outcomes.push(outcome))
    approvals.request({ ...request, from: "other", terminalId: "elsewhere" }, (outcome) =>
      outcomes.push(outcome),
    )
    await tick()
    approvals.withdraw("target")
    approvals.withdraw("other")
    expect(outcomes).toEqual(["withdrawn", "withdrawn"])
    await tick()
    expect(client.items.filter((item) => item.type === "withdrawn")).toHaveLength(2)
    expect(approvals.refusal("target")).toBeUndefined()
    // Nothing is left to answer.
    const requestId = client.items[0]!.requestId
    expect(() => approvals.answer({ requestId, approved: true }, "owner")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    approvals.finish()
    await client.done
  })

  it("settles what waits as gone once its client goes away", async () => {
    const approvals = new Approvals()
    const controller = new AbortController()
    const client = collect(approvals.follow("owner", controller.signal))
    const outcomes: ApprovalOutcome[] = []
    approvals.request(request, (outcome) => outcomes.push(outcome))
    await tick()
    controller.abort()
    await client.done
    expect(outcomes).toEqual(["gone"])
    expect(approvals.refusal("target")).toBe("nobody")
  })

  it("keeps what waits while the client still follows on another stream", async () => {
    const approvals = new Approvals()
    const first = new AbortController()
    const one = collect(approvals.follow("owner", first.signal))
    const two = collect(approvals.follow("owner"))
    const outcomes: ApprovalOutcome[] = []
    approvals.request(request, (outcome) => outcomes.push(outcome))
    await tick()
    first.abort()
    await one.done
    expect(outcomes).toEqual([])
    approvals.release("owner")
    await two.done
    expect(outcomes).toEqual(["gone"])
  })

  it("settles what waits as gone as the runner stops, and follows no more", async () => {
    const approvals = new Approvals()
    const client = collect(approvals.follow("owner"))
    const outcomes: ApprovalOutcome[] = []
    approvals.request(request, (outcome) => outcomes.push(outcome))
    approvals.finish()
    await client.done
    expect(outcomes).toEqual(["gone"])
    await expect(approvals.follow("owner").next()).rejects.toMatchObject({
      code: "CLOSING",
    })
  })
})
