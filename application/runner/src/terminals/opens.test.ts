import { randomUUID } from "node:crypto"

import { describe, expect, it } from "../test.js"
import { allowOpen, OpenRequests, openLimit, prune, readOpenRequest } from "./opens.js"

describe("reading a request for a new terminal", () => {
  it("takes a command, a folder, a name and focus, each optional", () => {
    expect(readOpenRequest({})).toEqual({ ok: true, request: {} })
    expect(
      readOpenRequest({ command: "npm run dev", cwd: "../app", title: " Server ", focus: true }),
    ).toEqual({
      ok: true,
      request: { command: "npm run dev", cwd: "../app", title: "Server", focus: true },
    })
  })

  it("refuses a command of more than one line, or with control characters", () => {
    const refused = {
      ok: false,
      reason: "The command must be one line, without control characters.",
    }
    expect(readOpenRequest({ command: "claude\nrm -rf ~" })).toEqual(refused)
    expect(readOpenRequest({ command: "claude\r" })).toEqual(refused)
    expect(readOpenRequest({ command: "echo \u001b[31m" })).toEqual(refused)
  })

  it("names what else is wrong, and refuses what it doesn't take", () => {
    expect(readOpenRequest({ command: "" })).toEqual({
      ok: false,
      reason: 'The request\'s "command" is not valid.',
    })
    expect(readOpenRequest({ command: "a".repeat(4097) })).toMatchObject({ ok: false })
    expect(readOpenRequest({ command: "a".repeat(4096) })).toMatchObject({ ok: true })
    expect(readOpenRequest({ focus: "yes" })).toEqual({
      ok: false,
      reason: 'The request\'s "focus" is not valid.',
    })
    expect(readOpenRequest({ title: "   " })).toMatchObject({ ok: false })
    // As the terminal will be titled: one line, without control characters.
    expect(readOpenRequest({ title: "API\tserver" })).toMatchObject({ ok: false })
    expect(readOpenRequest({ shell: "zsh" })).toEqual({
      ok: false,
      reason: "The request is not valid.",
    })
  })
})

describe("how many terminals a terminal's agents may open", () => {
  it("allows five a minute, then one more as each falls out of the minute", () => {
    expect(openLimit).toEqual({ count: 5, windowMs: 60_000 })
    let times: readonly number[] = []
    for (const now of [0, 1_000, 2_000, 3_000, 4_000]) {
      const next = allowOpen(times, now)
      expect(next).toBeDefined()
      times = next!
    }
    expect(allowOpen(times, 5_000)).toBeUndefined()
    expect(allowOpen(times, 59_999)).toBeUndefined()
    expect(allowOpen(times, 60_000)).toEqual([1_000, 2_000, 3_000, 4_000, 60_000])
  })

  it("forgets the times that fell out of the window", () => {
    expect(allowOpen([0, 10, 20], 120_000, { count: 2, windowMs: 1_000 })).toEqual([120_000])
  })
})

describe("letting go of budgets", () => {
  it("drops those whose every time has passed out of the window, and keeps the rest", () => {
    const budgets = new Map<string, readonly number[]>([
      ["gone", [0, 10]],
      ["recent", [0, 60_500]],
    ])
    prune(budgets, 70_000, 60_000)
    expect([...budgets]).toEqual([["recent", [0, 60_500]]])
  })
})

describe("requests on their way to the client", () => {
  const request = {
    from: randomUUID(),
    sessionId: randomUUID(),
    cwd: "/work",
    command: "claude",
    focus: false,
  }

  it("go nowhere without a client following them", async () => {
    await expect(
      new OpenRequests().ask(request, 1_000, { by: "t1", withBrief: false }),
    ).resolves.toEqual({
      type: "nobody",
    })
  })

  it("go to the client that followed last, and wait for its answer", async () => {
    const opens = new OpenRequests()
    const controller = new AbortController()
    const older = opens.follow("older", controller.signal)
    const newer = opens.follow("newer", controller.signal)
    // A stream follows from its first read.
    void older.next()
    const first = newer.next()
    const asked = opens.ask(request, 1_000, { by: "t1", title: "Server", withBrief: false })
    const { value } = await first
    expect(value).toEqual({ requestId: expect.any(String), ...request })
    // Who asked, with the title it asked for, waits for the terminal its client creates:
    // only that client's, in the request's session, and only the first.
    expect(opens.opener(value!.requestId, "older", request.sessionId)).toBeUndefined()
    expect(opens.opener(value!.requestId, "newer", randomUUID())).toBeUndefined()
    expect(opens.opener(value!.requestId, "newer", request.sessionId)).toEqual({
      by: "t1",
      title: "Server",
      withBrief: false,
    })
    expect(opens.opener(value!.requestId, "newer", request.sessionId)).toBeUndefined()
    const terminalId = randomUUID()
    // Only the client it went to answers it.
    expect(() => opens.answer({ requestId: value!.requestId, terminalId }, "older")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    opens.answer({ requestId: value!.requestId, terminalId }, "newer")
    await expect(asked).resolves.toEqual({
      type: "answered",
      answer: { requestId: value!.requestId, terminalId },
    })
    // Answered once: a second answer finds nothing waiting.
    expect(() => opens.answer({ requestId: value!.requestId, reason: "No." }, "newer")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    controller.abort()
  })

  it("go unanswered when the client takes too long, or goes away", async () => {
    const opens = new OpenRequests()
    const stream = opens.follow("client")
    const first = stream.next()
    await expect(opens.ask(request, 10, { by: "t1", withBrief: false })).resolves.toEqual({
      type: "late",
    })
    await first
    const asked = opens.ask(request, 1_000, { by: "t1", withBrief: false })
    opens.release("client")
    await expect(asked).resolves.toEqual({ type: "gone" })
    await expect(stream.next()).resolves.toMatchObject({ done: true })
    await expect(opens.ask(request, 1_000, { by: "t1", withBrief: false })).resolves.toEqual({
      type: "nobody",
    })
  })
})
