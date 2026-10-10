import { connect } from "node:net"

import { vi } from "vitest"

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

/**
 * Sends `line` and resolves to what came back: ending its side at once, or, with `end`
 * false, once the endpoint ends its own.
 */
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
const call = { type: "present", terminalId: "t", token, request: { file: { path: "a.md" } } }

// A relay's connection: its first line, then the lines it carries; resolves to every
// line that came back by the time the endpoint closed it, or `waitMs` passed.
const relay = (
  endpoint: string,
  lines: readonly string[],
  { waitMs = 5_000 }: { readonly waitMs?: number } = {},
) =>
  new Promise<unknown[]>((resolve) => {
    const socket = connect(endpoint)
    let received = ""
    const done = () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(
        received
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
      )
    }
    const timer = setTimeout(done, waitMs)
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => (received += chunk))
    socket.on("error", done)
    socket.on("close", done)
    socket.write(lines.map((line) => `${line}\n`).join(""))
  })
// An agent's MCP session through a relay: what the runner answered after taking it,
// which it says first, in the relay's own version.
const session = async (
  endpoint: string,
  lines: readonly string[],
  options?: { readonly waitMs?: number },
) => {
  const [taken, ...answers] = await relay(endpoint, lines, options)
  expect(taken).toEqual({ relay: 2, ok: true })
  return answers
}
const hello = (given: object = {}) =>
  JSON.stringify({ relay: 2, kind: "mcp", terminalId: "t", token, ...given })
const end = JSON.stringify({ relay: "eof" })
const rpc = (message: object) => JSON.stringify({ jsonrpc: "2.0", ...message })

// What a tool call told the agent, as the answer to request `id`.
const told = (id: number, text: string, isError: boolean) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text }], isError },
})

// A call to the tool `name`, as request `id`.
const tool = (id: number, name: string, args: object) =>
  rpc({ id, method: "tools/call", params: { name, arguments: args } })

// The answer to request `id`, over 1 MiB.
const refused = (id: number) => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32600, message: expect.stringContaining("over 1 MiB") },
})

describe("relay sessions", () => {
  it("answers an agent's session over one connection, with the terminal's token", async ({
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
    const answers = await session(reports.endpoint, [
      hello(),
      rpc({ id: 1, method: "tools/list" }),
      rpc({
        id: 2,
        method: "tools/call",
        params: { name: "show", arguments: { file: { path: "a.md" } } },
      }),
      end,
    ])
    expect(answers).toHaveLength(2)
    expect(answers).toContainEqual(
      expect.objectContaining({ id: 2, result: expect.objectContaining({ isError: false }) }),
    )
    expect(calls).toEqual([call])
  })

  // Windows' named pipes close whole once the caller ends its side.
  const halfOpen = process.platform !== "win32"

  it("answers a session whether or not the relay ended its side", async ({ resources }) => {
    const calls: Call[] = []
    const reports = await listenForReports(
      handlers({
        call: async (asked) => (calls.push(asked), { ok: true, name: "a.md", opened: true }),
      }),
    )
    resources.defer(() => reports.close())
    // Taken first, then answered.
    const answer = [
      JSON.stringify({ relay: 2, ok: true }),
      JSON.stringify(told(1, "Showing a.md to the user in Novadeck.", false)),
      "",
    ].join("\n")
    const lines = [hello(), tool(1, "show", { file: { path: "a.md" } })].join("\n")
    if (halfOpen) await expect(send(reports.endpoint, lines)).resolves.toBe(answer)
    await expect(send(reports.endpoint, `${lines}\n${end}`, { end: false })).resolves.toBe(answer)
    expect(calls).toEqual(halfOpen ? [call, call] : [call])
  })

  it("tells each call the runner fails or doesn't answer in time in its tool's own words", async ({
    resources,
  }) => {
    const calls: Call[] = []
    const reports = await listenForReports(
      handlers({
        call: (asked) => {
          calls.push(asked)
          if (asked.type === "present") return Promise.reject(new Error("broken"))
          return asked.type === "open" && asked.request.command === "claude"
            ? Promise.resolve({ ok: true, terminalId: "u", cwd: "/work" })
            : new Promise(() => {})
        },
      }),
      { answerMs: 50 },
    )
    resources.defer(() => reports.close())
    const answers = await session(reports.endpoint, [
      hello(),
      tool(1, "open_terminal", { command: "claude" }),
      tool(2, "open_terminal", { command: "slow" }),
      tool(3, "close_terminal", { to: "t2" }),
      tool(4, "show", { file: { path: "a.md" } }),
      end,
    ])
    expect(answers).toHaveLength(4)
    expect(answers).toEqual(
      expect.arrayContaining([
        told(1, "Opened a new terminal in /work.", false),
        told(2, unansweredCalls.open.reason, true),
        told(3, "Novadeck couldn't close the terminal.", true),
        told(4, unansweredCalls.present.reason, true),
      ]),
    )
    const from = { terminalId: "t", token }
    expect(calls).toEqual(
      expect.arrayContaining([
        { type: "open", ...from, request: { command: "claude" } },
        { type: "open", ...from, request: { command: "slow" } },
        { type: "close", ...from, request: { to: "t2" } },
        call,
      ]),
    )
  })

  it("refuses a call it cannot read, without asking", async ({ resources }) => {
    const calls: Call[] = []
    const reports = await listenForReports(
      handlers({ call: async (asked) => (calls.push(asked), { ok: true }) }),
    )
    resources.defer(() => reports.close())
    // A tool it doesn't have, and a terminal no runner names.
    await expect(
      session(reports.endpoint, [hello(), tool(1, "unknown", {}), end]),
    ).resolves.toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown tool: unknown" } },
    ])
    await expect(
      session(reports.endpoint, [
        hello({ terminalId: "t".repeat(65) }),
        tool(1, "show", { file: { path: "a.md" } }),
        end,
      ]),
    ).resolves.toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown tool: show" } },
    ])
    expect(calls).toEqual([])
  })

  it("offers no tools to a relay that names no terminal's token", async ({ resources }) => {
    const calls: Call[] = []
    const reports = await listenForReports(
      handlers({ call: async (asked) => (calls.push(asked), { ok: true }) }),
    )
    resources.defer(() => reports.close())
    const answers = await session(reports.endpoint, [
      hello({ token: "not a token" }),
      rpc({ id: 1, method: "tools/list" }),
      rpc({
        id: 2,
        method: "tools/call",
        params: { name: "show", arguments: { file: { path: "a.md" } } },
      }),
      end,
    ])
    expect(answers).toEqual([
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
      { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "Unknown tool: show" } },
    ])
    expect(calls).toEqual([])
  })

  it("answers the calls under way after the relay's end, then closes", async ({ resources }) => {
    const reports = await listenForReports(
      handlers({
        call: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200))
          return { ok: true, id: "abc", kind: "file", name: "a.md" }
        },
      }),
    )
    resources.defer(() => reports.close())
    const began = Date.now()
    const answers = await session(reports.endpoint, [
      hello(),
      rpc({
        id: 2,
        method: "tools/call",
        params: { name: "show", arguments: { file: { path: "a.md" } } },
      }),
      end,
    ])
    expect(answers).toEqual([expect.objectContaining({ id: 2 })])
    // Closed by the endpoint, not by the test's wait.
    expect(Date.now() - began).toBeLessThan(5_000)
  })

  it("answers a line too long to take as an error, and goes on", async ({ resources }) => {
    const calls: Call[] = []
    const reports = await listenForReports(
      handlers({ call: async (asked) => (calls.push(asked), { ok: true }) }),
    )
    resources.defer(() => reports.close())
    const huge = rpc({
      id: 9,
      method: "tools/call",
      params: { name: "send", arguments: { to: "t2", text: "x".repeat(1_100_000) } },
    })
    // As the MCP SDK writes a request: its id last, after params that may hold an "id".
    const last = JSON.stringify({
      method: "tools/call",
      params: { name: "send", arguments: { id: 3, to: "t2", text: "x".repeat(1_100_000) } },
      jsonrpc: "2.0",
      id: 11,
    })
    const answers = await session(reports.endpoint, [
      hello(),
      huge,
      rpc({ id: 10, method: "ping" }),
      last,
      rpc({ id: 12, method: "ping" }),
      end,
    ])
    expect(answers).toEqual([
      refused(9),
      { jsonrpc: "2.0", id: 10, result: {} },
      refused(11),
      { jsonrpc: "2.0", id: 12, result: {} },
    ])
    expect(calls).toEqual([])
  })

  it("turns away a relay of a version it doesn't speak, saying so once", async ({ resources }) => {
    const reports = await listenForReports(handlers({}))
    resources.defer(() => reports.close())
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const newer = hello({ relay: 99 })
    await expect(relay(reports.endpoint, [newer, rpc({ id: 1, method: "ping" })])).resolves.toEqual(
      [],
    )
    await relay(reports.endpoint, [newer])
    expect(logged.mock.calls.filter(([said]) => String(said).includes("version 99"))).toHaveLength(
      1,
    )
  })

  it("ends the sessions still open when it closes", async () => {
    const reports = await listenForReports(handlers({}))
    const open = session(reports.endpoint, [hello(), rpc({ id: 1, method: "ping" })], {
      waitMs: 10_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const began = Date.now()
    await reports.close()
    await expect(open).resolves.toEqual([{ jsonrpc: "2.0", id: 1, result: {} }])
    expect(Date.now() - began).toBeLessThan(5_000)
  })
})

describe("relay hooks", () => {
  const lease = "abcdefghijklmnopqrstuvwx"
  const hook = (given: object = {}) =>
    JSON.stringify({
      relay: 2,
      kind: "hook",
      terminalId: "t",
      token,
      agent: "claude",
      event: "Stop",
      seq: Date.now(),
      ancestors: [
        { pid: 7, name: "sh" },
        { pid: 42, name: "claude" },
      ],
      env: { cursor: false },
      payload: JSON.stringify({ hook_event_name: "Stop", session_id: "a" }),
      ...given,
    })

  it("answers an ask, and takes the acknowledgement of the lease it gave, not another", async ({
    resources,
  }) => {
    const acks: Ack[] = []
    const asked: Report[] = []
    const reports = await listenForReports(
      handlers({
        ask: async (taken) => {
          asked.push(taken)
          return { leaseId: lease, stdout: "printed" }
        },
        ack: (ack) => acks.push(ack),
      }),
    )
    resources.defer(() => reports.close())
    const answers = await relay(reports.endpoint, [hook(), JSON.stringify({ ack: lease })])
    expect(answers).toEqual([{ leaseId: lease, stdout: "printed" }])
    await expect.poll(() => acks).toEqual([{ terminalId: "t", token, leaseId: lease }])
    expect(asked).toMatchObject([{ event: "Stop", instance: "42", payload: { session_id: "a" } }])
    await relay(reports.endpoint, [hook(), JSON.stringify({ ack: "zyxwvutsrqponmlkjihgfedc" })])
    expect(acks).toHaveLength(1)
  })

  it("answers a hook with no runner token, reporting nothing", async ({ resources }) => {
    const received: Report[] = []
    const reports = await listenForReports(
      handlers({
        report: (taken) => received.push(taken),
        ask: async (taken) => (received.push(taken), { leaseId: lease, stdout: "x" }),
      }),
    )
    resources.defer(() => reports.close())
    const answers = await relay(reports.endpoint, [
      hook({ token: "not a token" }),
      hook({ token: "not a token", event: "SessionStart" }),
    ])
    expect(answers).toEqual([unheard])
    await expect(relay(reports.endpoint, [hook({ payload: "not json" })])).resolves.toEqual([
      unheard,
    ])
    expect(received).toEqual([])
  })

  it("takes only well-formed hooks carrying a runner token, reporting the rest as nothing", async ({
    resources,
  }) => {
    const received: Report[] = []
    const calls: Call[] = []
    const reports = await listenForReports(
      handlers({
        report: (taken) => received.push(taken),
        call: async (asked) => (calls.push(asked), { ok: true }),
      }),
    )
    resources.defer(() => reports.close())
    const started = (given: object = {}) =>
      hook({
        event: "SessionStart",
        seq: 1,
        payload: JSON.stringify({ session_id: "a" }),
        ...given,
      })
    // A token as long as a runner's, in characters but not in bytes, and others.
    const bad = ["ż".repeat(48), "short", token.toUpperCase(), 42]
    const answers = await Promise.all(
      bad.map((wrong) => relay(reports.endpoint, [started({ token: wrong })])),
    )
    // A payload that is not an object, or not the agent's JSON text, and an unknown agent.
    answers.push(await relay(reports.endpoint, [started({ payload: JSON.stringify("x") })]))
    answers.push(await relay(reports.endpoint, [started({ payload: { session_id: "a" } })]))
    answers.push(await relay(reports.endpoint, [started({ agent: "gemini" })]))
    answers.push(await relay(reports.endpoint, [started()]))
    expect(received).toEqual([
      {
        terminalId: "t",
        token,
        agent: "claude",
        event: "SessionStart",
        seq: 1,
        instance: "42",
        env: { cursor: false },
        payload: { session_id: "a" },
      },
    ])
    expect(answers).toEqual(answers.map(() => [unheard]))
    expect(calls).toEqual([])
  })

  it("answers an ask with one line, or as unheard once the hook's deadline passes", async ({
    resources,
  }) => {
    const asked: { report: Report; deadline: number }[] = []
    const answer = { leaseId: lease, stdout: '{"decision":"block"}\n' }
    const reports = await listenForReports(
      handlers({
        ask: (received, deadline) => {
          asked.push({ report: received, deadline })
          return asked.length === 1 ? Promise.resolve(answer) : new Promise(() => {})
        },
      }),
    )
    resources.defer(() => reports.close())
    const seq = Date.now()
    await expect(
      relay(reports.endpoint, [hook({ seq }), JSON.stringify({ ack: lease })]),
    ).resolves.toEqual([answer])
    // A runner too slow for the hook answers it as unheard, by the hook's own deadline,
    // which an ask's start leaves only moments before.
    const started = Date.now()
    await expect(relay(reports.endpoint, [hook({ seq: Date.now() - 3_400 })])).resolves.toEqual([
      unheard,
    ])
    expect(Date.now() - started).toBeLessThan(1_500)
    // An ask it can't read is unheard at once, without asking.
    await expect(relay(reports.endpoint, [hook({ seq: "soon" })])).resolves.toEqual([unheard])
    const report = {
      terminalId: "t",
      token,
      agent: "claude",
      event: "Stop",
      instance: "42",
      env: { cursor: false },
      payload: { hook_event_name: "Stop", session_id: "a" },
    }
    expect(asked).toEqual([
      { report: { ...report, seq }, deadline: expect.any(Number) },
      { report: { ...report, seq: expect.any(Number) }, deadline: expect.any(Number) },
    ])
    // Its deadline is the hook's own, after it started.
    expect(asked[0]!.deadline).toBeGreaterThan(seq)
  })
})

describe("what isn't a relay's", () => {
  it("ends a first line that isn't a relay's without an answer, taking nothing", async ({
    resources,
  }) => {
    const taken: unknown[] = []
    const reports = await listenForReports({
      report: (report) => taken.push(report),
      ask: async (report) => (taken.push(report), { leaseId: null, stdout: "x" }),
      ack: (ack) => taken.push(ack),
      call: async (asked) => (taken.push(asked), { ok: true }),
    })
    resources.defer(() => reports.close())
    const report = {
      terminalId: "t",
      token,
      agent: "claude",
      event: "SessionStart",
      seq: 1,
      instance: "42",
      env: { cursor: false },
      payload: { session_id: "a" },
    }
    const lines = [
      "not json",
      // One-line reports, asks, acknowledgements and calls, as hooks once sent them.
      JSON.stringify(report),
      JSON.stringify({ ...report, deadline: Date.now() + 2_000 }),
      JSON.stringify({ ack: "abcdefghijklmnopqrstuvwx", terminalId: "t", token }),
      JSON.stringify(call),
      // Another version of the relay's, and a kind it doesn't carry.
      JSON.stringify({ relay: 1, kind: "hook", terminalId: "t", token }),
      hello({ kind: "other" }),
      // Too long to be a relay's first line, but for a hook's, and too long for a hook.
      JSON.stringify({ ...call, request: { file: { path: "a".repeat(70_000) } } }),
      hello({ kind: "hook", payload: "x".repeat(2_200_000) }),
    ]
    const answers = await Promise.all(lines.map((line) => send(reports.endpoint, line)))
    expect(answers).toEqual(lines.map(() => ""))
    expect(taken).toEqual([])
  })
})
