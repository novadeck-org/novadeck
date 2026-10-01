import { connect } from "node:net"

import { describe, expect, it } from "../test.js"
import {
  listenForReports,
  unanswered,
  unansweredCalls,
  unheard,
  type Ack,
  type Call,
  type Report,
  type ReportHandlers,
} from "./reports.js"

/** Handlers that ignore what a test does not look at. */
const handlers = (given: Partial<ReportHandlers>): ReportHandlers => ({
  report: () => {},
  ask: () => Promise.resolve(unheard),
  ack: () => {},
  call: () => Promise.resolve(unanswered),
  ...given,
})

/** Sends one line, ending its side as a hook does, and resolves to what came back. */
const send = (endpoint: string, line: string, { end = true } = {}) =>
  new Promise<string>((resolve) => {
    const socket = connect(endpoint)
    let received = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => (received += chunk))
    socket.on("error", () => resolve(received))
    socket.on("close", () => resolve(received))
    if (end) socket.end(`${line}\n`)
    else socket.write(`${line}\n`, () => socket.once("end", () => socket.end()))
  })

const token = "0123456789abcdef".repeat(3)
const report = {
  terminalId: "t",
  agent: "claude",
  event: "SessionStart",
  seq: 1,
  instance: "42",
  env: { cursor: false },
  payload: { session_id: "a" },
}
const call = { type: "present", terminalId: "t", token, request: { path: "a.md" } }

describe("the report endpoint", () => {
  it("takes only well-formed reports carrying a runner token, answering none", async ({
    resources,
  }) => {
    const received: Report[] = []
    const calls: Call[] = []
    const reports = await listenForReports(
      handlers({
        report: (accepted) => received.push(accepted),
        call: (asked) => {
          calls.push(asked)
          return Promise.resolve({ ok: true })
        },
      }),
    )
    resources.defer(() => reports.close())
    // A token as long as a runner's, in characters but not in bytes, and others.
    const bad = ["ż".repeat(48), "short", token.toUpperCase(), 42]
    const answers = await Promise.all(
      bad.map((wrong) => send(reports.endpoint, JSON.stringify({ ...report, token: wrong }))),
    )
    answers.push(await send(reports.endpoint, "not json"))
    // A payload that is not an object, and an unknown agent.
    answers.push(await send(reports.endpoint, JSON.stringify({ ...report, token, payload: "x" })))
    answers.push(
      await send(reports.endpoint, JSON.stringify({ ...report, token, agent: "gemini" })),
    )
    answers.push(await send(reports.endpoint, JSON.stringify({ ...report, token })))
    expect(received).toEqual([{ ...report, token }])
    expect(answers.every((answer) => answer === "")).toBe(true)
    expect(calls).toEqual([])
  })

  // Windows' named pipes close whole once the caller ends its side.
  const halfOpen = process.platform !== "win32"

  it("answers a call with one line, whether or not the caller ended its side", async ({
    resources,
  }) => {
    const calls: Call[] = []
    const reports = await listenForReports(
      handlers({
        call: async (asked) => {
          calls.push(asked)
          return { ok: true, id: "abc", kind: "file", name: "a.md" }
        },
      }),
    )
    resources.defer(() => reports.close())
    const answer = `${JSON.stringify({ ok: true, id: "abc", kind: "file", name: "a.md" })}\n`
    if (halfOpen) await expect(send(reports.endpoint, JSON.stringify(call))).resolves.toBe(answer)
    await expect(send(reports.endpoint, JSON.stringify(call), { end: false })).resolves.toBe(answer)
    expect(calls).toEqual(halfOpen ? [call, call] : [call])
  })

  it("takes a call to open a terminal alike, and its failures in its own words", async ({
    resources,
  }) => {
    const calls: Call[] = []
    const reports = await listenForReports(
      handlers({
        call: (asked) => {
          calls.push(asked)
          return calls.length === 1
            ? Promise.resolve({ ok: true, terminalId: "u", cwd: "/work" })
            : new Promise(() => {})
        },
      }),
      { answerMs: 50 },
    )
    resources.defer(() => reports.close())
    const open = { type: "open", terminalId: "t", token, request: { command: "claude" } }
    const line = JSON.stringify(open)
    await expect(send(reports.endpoint, line, { end: false })).resolves.toBe(
      `${JSON.stringify({ ok: true, terminalId: "u", cwd: "/work" })}\n`,
    )
    await expect(send(reports.endpoint, line, { end: false })).resolves.toBe(
      `${JSON.stringify(unansweredCalls.open)}\n`,
    )
    expect(calls).toEqual([open, open])
    // Unread, a call to open is not one at all.
    await expect(
      send(reports.endpoint, JSON.stringify({ ...open, request: "claude" }), { end: false }),
    ).resolves.toBe(`${JSON.stringify(unanswered)}\n`)
    expect(calls).toHaveLength(2)
  })

  it("answers a call it cannot read as a failure, without asking", async ({ resources }) => {
    const calls: Call[] = []
    const reports = await listenForReports(
      handlers({
        call: (asked) => {
          calls.push(asked)
          return Promise.resolve({ ok: true })
        },
      }),
    )
    resources.defer(() => reports.close())
    const failed = `${JSON.stringify(unanswered)}\n`
    const malformed = [
      { ...call, type: "unknown" },
      { ...call, token: "short" },
      { ...call, terminalId: "t".repeat(65) },
      { ...call, request: "a.md" },
      { ...call, request: ["a.md"] },
    ]
    const answers = await Promise.all(
      malformed.map((value) => send(reports.endpoint, JSON.stringify(value), { end: false })),
    )
    expect(answers).toEqual(malformed.map(() => failed))
    expect(calls).toEqual([])
  })

  it("closes on a line too long to be a report or a call, answering nothing", async ({
    resources,
  }) => {
    const calls: Call[] = []
    const reports = await listenForReports(
      handlers({
        call: (asked) => {
          calls.push(asked)
          return Promise.resolve({ ok: true })
        },
      }),
    )
    resources.defer(() => reports.close())
    const long = JSON.stringify({ ...call, request: { path: "a".repeat(70_000) } })
    await expect(send(reports.endpoint, long)).resolves.toBe("")
    expect(calls).toEqual([])
  })

  it("answers a call that fails, or takes too long, as a failure", async ({ resources }) => {
    let calls = 0
    const reports = await listenForReports(
      handlers({
        call: () => {
          calls += 1
          return calls === 1 ? Promise.reject(new Error("broken")) : new Promise(() => {})
        },
      }),
      { answerMs: 50 },
    )
    resources.defer(() => reports.close())
    const failed = `${JSON.stringify(unanswered)}\n`
    const open = { end: false }
    await expect(send(reports.endpoint, JSON.stringify(call), open)).resolves.toBe(failed)
    await expect(send(reports.endpoint, JSON.stringify(call), open)).resolves.toBe(failed)
  })
})

describe("hook asks", () => {
  it("answers an ask with one line, or as unheard once the hook's deadline passes", async ({
    resources,
  }) => {
    const asked: { report: Report; deadline: number }[] = []
    const answer = { leaseId: "L".repeat(24), stdout: '{"decision":"block"}\n' }
    const reports = await listenForReports(
      handlers({
        ask: (received, deadline) => {
          asked.push({ report: received, deadline })
          return asked.length === 1 ? Promise.resolve(answer) : new Promise(() => {})
        },
      }),
    )
    resources.defer(() => reports.close())
    const ask = (deadline: unknown) => JSON.stringify({ ...report, token, deadline })
    const open = { end: false }
    const deadline = Date.now() + 2_000
    await expect(send(reports.endpoint, ask(deadline), open)).resolves.toBe(
      `${JSON.stringify(answer)}\n`,
    )
    // A runner too slow for the hook answers it as unheard, by the hook's own deadline.
    const started = Date.now()
    await expect(send(reports.endpoint, ask(Date.now() + 100), open)).resolves.toBe(
      `${JSON.stringify(unheard)}\n`,
    )
    expect(Date.now() - started).toBeLessThan(1_500)
    // An ask it can't read is unheard at once, without asking.
    await expect(send(reports.endpoint, ask("soon"), open)).resolves.toBe(
      `${JSON.stringify(unheard)}\n`,
    )
    expect(asked).toEqual([
      { report: { ...report, token }, deadline },
      { report: { ...report, token }, deadline: expect.any(Number) },
    ])
  })

  it("takes a hook's acknowledgement of its lease, answering none", async ({ resources }) => {
    const acks: Ack[] = []
    const reports = await listenForReports(handlers({ ack: (ack) => acks.push(ack) }))
    resources.defer(() => reports.close())
    const lease = "abcdefghijklmnopqrstuvwx"
    await expect(
      send(reports.endpoint, JSON.stringify({ ack: lease, terminalId: "t", token })),
    ).resolves.toBe("")
    // Without a runner's token, or a lease's shape, it is no acknowledgement.
    await send(reports.endpoint, JSON.stringify({ ack: lease, terminalId: "t", token: "x" }))
    await send(reports.endpoint, JSON.stringify({ ack: "short", terminalId: "t", token }))
    expect(acks).toEqual([{ terminalId: "t", token, leaseId: lease }])
  })
})
