import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { AgentName } from "@novadeck/protocol"

import { relayHook } from "./hook.js"
import { mcpAnswer, type McpCall } from "./mcp.js"

/**
 * What an agent hook forwards: the event its agent reported in a terminal, with a
 * bounded copy of the agent's payload. The agent's harness decodes the payload (see
 * `harnesses/<id>/decode.ts`); nothing here reads it.
 */
export type Report = {
  readonly terminalId: string
  readonly token: string
  readonly agent: AgentName
  /** The hook event, as the agent names it: SessionStart, PreInvocation… */
  readonly event: string
  /** When the hook started, in epoch milliseconds: a later hook reports a larger one. */
  readonly seq: number
  /** The agent process that ran the hook, as a pid; null where the platform hides it. */
  readonly instance: string | null
  /** What of the hook's environment tells nested agents apart. */
  readonly env: { readonly cursor: boolean; readonly codexThread?: string }
  readonly payload: { readonly [key: string]: unknown }
}

/**
 * What a Stop or prompt-time hook hears back as it asks (see docs/agent-messaging.md):
 * what it prints, exactly as its agent expects, and the lease it acknowledges once it has
 * printed it. A null `stdout` leaves the hook to print what it does without Novadeck.
 */
export type HookAnswer = { readonly leaseId: string | null; readonly stdout: string | null }

/** The answer to an ask that failed, took too long, or could not be read. */
export const unheard: HookAnswer = { leaseId: null, stdout: null }

/** A hook's word that it printed what a lease delivers. */
export type Ack = { readonly terminalId: string; readonly token: string; readonly leaseId: string }

/**
 * What Novadeck's MCP server forwards: a tool call an agent made in a terminal, which
 * waits for its answer. `present` shows something beside it and `showing` lists what is
 * there (see `companions/items.ts`), `open` opens a new terminal beside it (see
 * `terminals/opens.ts`), `close` closes another terminal of its project and session (see
 * `terminals/closes.ts`), `send` and `agents` message other terminals' agents and
 * describe them (see `messaging/messaging.ts`), and `describe` names the caller's own
 * terminal (see `terminals/naming.ts`); the runner reads `request`, and nothing here does.
 */
export type Call = {
  readonly type: CallType
  readonly terminalId: string
  readonly token: string
  readonly request: { readonly [key: string]: unknown }
}

const callTypes = ["present", "showing", "open", "close", "send", "agents", "describe"] as const
export type CallType = (typeof callTypes)[number]

/** The answer to a call that failed, took too long, or could not be read. */
export const unanswered = { ok: false, reason: "Novadeck couldn't show it." } as const

/** The same, for each type of call. */
export const unansweredCalls = {
  present: unanswered,
  showing: { ok: false, reason: "Novadeck couldn't list what is showing beside you." },
  open: { ok: false, reason: "Novadeck couldn't open the terminal." },
  close: { ok: false, reason: "Novadeck couldn't close the terminal." },
  send: { ok: false, reason: "Novadeck couldn't send the message." },
  agents: { ok: false, reason: "Novadeck couldn't list the terminals." },
  describe: { ok: false, reason: "Novadeck couldn't describe the terminal." },
} as const satisfies { readonly [type in CallType]: { ok: false; reason: string } }

const object = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Who sent a message: a terminal, and a token that could be the runner's. */
const sender = (value: {
  readonly [key: string]: unknown
}): { terminalId: string; token: string } | undefined => {
  const { terminalId, token } = value
  if (typeof terminalId !== "string" || terminalId.length > 64) return undefined
  // The runner's tokens are 48 hex digits; anything else cannot match one.
  if (typeof token !== "string" || !/^[0-9a-f]{48}$/.test(token)) return undefined
  return { terminalId, token }
}

// A relay's first line, but for a hook's, and its acknowledgement are short: a terminal,
// a token and a few words, well within this.
const maxBytes = 65_536

/** What a relay sends once its agent closed its side: answer what's under way, then close. */
const relayEnd = JSON.stringify({ relay: "eof" })

// A relay's hook: its agent's payload, up to a million characters, escaped as JSON text,
// which may double it, with room for the rest.
const maxRelayHook = 2_100_000

/** How a relay's first line starts, naming the version of what it carries. */
const relayStart = '{"relay":'

/**
 * The versions of the relay protocol the runner speaks (see docs/backend-api.md, "Relay
 * protocol"). An agent's plugin starts whichever relay the install that connected it
 * last copied in, so a runner can meet a relay older or newer than its own: when the
 * protocol changes, the runner keeps taking the version before it for a release. A
 * relay the runner doesn't take answers by itself, with no tools.
 */
export const relayVersions: ReadonlySet<number> = new Set([2])

// What the endpoint turned away, said once each, so a mismatch shows in the runner's log
// without filling it.
const refused = new Set<string>()
const refuse = (value: unknown): void => {
  const relay =
    typeof value === "object" && value !== null && "relay" in value ? value.relay : undefined
  const why =
    relay === undefined
      ? "a connection that isn't a relay's"
      : `a relay speaking version ${JSON.stringify(relay)} of its protocol`
  if (refused.has(why)) return
  refused.add(why)
  console.error(`Novadeck's report endpoint turned away ${why}.`)
}

// One line of an agent's MCP session may hold more than a hook's report, as a message's
// text, but not without end.
const maxSessionLine = 1_048_576

// How much of a line too long to take is kept, at each end, to find its id.
const idWindow = 4096

/**
 * The answer to a line too long to take, with the id it was sent with, so the call it was
 * gets an answer and the session goes on. A client writes the id first or last: last when
 * it closes the line, as the MCP SDK writes it, or else the first the line's start names.
 */
const tooLong = (head: string, tail: string): string => {
  const value = '(-?\\d+|"(?:[^"\\\\]|\\\\.)*")'
  const named =
    new RegExp(`"id"\\s*:\\s*${value}\\s*}\\s*$`).exec(tail)?.[1] ??
    new RegExp(`"id"\\s*:\\s*${value}`).exec(head)?.[1]
  let id: unknown = null
  try {
    id = named === undefined ? null : JSON.parse(named)
  } catch {
    // Unreadable: answered without one.
  }
  const message =
    "The request is over 1 MiB, more than Novadeck takes; put long content in a file and pass its path."
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message } })
}

/**
 * Serves one agent's MCP session over a relay's connection, from `rest`, what came after
 * the relay's first line, once it has told the relay it takes the session, in the
 * relay's own version: each line the agent sent is answered with a line, as it is
 * done, so a slow call holds up no other. Once the relay sends its end, the session
 * answers what is under way and closes. Calls carry the terminal and token the relay
 * named; outside a terminal it named, the server offers no tools.
 */
const serveSession = (
  socket: Socket,
  rest: string,
  call: McpCall | undefined,
  version: number,
): void => {
  // The session is taken: the relay carries the agent's lines from here on.
  socket.write(`${JSON.stringify({ relay: version, ok: true })}\n`)
  let buffer = ""
  let pending = 0
  let ended = false
  const settle = () => {
    if (ended && pending === 0) socket.end()
  }
  const take = (line: string) => {
    if (line === relayEnd) {
      ended = true
      settle()
      return
    }
    pending += 1
    mcpAnswer(line, call)
      .then((reply) => {
        if (reply !== undefined && socket.writable) socket.write(`${reply}\n`)
      })
      .catch(() => {})
      .finally(() => {
        pending -= 1
        settle()
      })
  }
  // Whether the line under way was too long to take, and what is left of it goes unread.
  // Its start and, as it goes, its end: answered once it ends.
  let skipping: { head: string; tail: string } | undefined
  const read = (chunk: string) => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (ended) return
      // However it arrived, whole or in pieces, a line over the limit isn't taken.
      if (!skipping && line.length <= maxSessionLine) {
        take(line.trim())
        continue
      }
      const head = skipping?.head ?? line.slice(0, idWindow)
      const tail = ((skipping?.tail ?? "") + line).slice(-idWindow)
      if (socket.writable) socket.write(`${tooLong(head, tail.trimEnd())}\n`)
      skipping = undefined
    }
    if (!skipping && buffer.length > maxSessionLine) {
      skipping = { head: buffer.slice(0, idWindow), tail: "" }
    }
    if (skipping) {
      skipping.tail = (skipping.tail + buffer).slice(-idWindow)
      buffer = ""
    }
  }
  socket.on("data", read)
  // A relay that went away without its end has nothing more to answer.
  socket.on("end", () => {
    ended = true
    settle()
  })
  read(rest)
}

/** An answer, or `failed` once it fails or `ms` pass. */
const within = async <T>(answer: Promise<T>, ms: number, failed: T): Promise<T> => {
  const timeout = new AbortController()
  const result = await Promise.race([
    answer.catch(() => failed),
    sleep(Math.max(0, ms), failed, { signal: timeout.signal }).catch(() => failed),
  ])
  timeout.abort()
  return result
}

export type ReportsOptions = {
  readonly platform?: NodeJS.Platform
  /** How long a sender has to send its line, in milliseconds. */
  readonly readMs?: number
  /**
   * How long a call waits for its answer before it gets its type's `unansweredCalls`, in
   * milliseconds:
   * by default 8 s, as opening a terminal waits for Novadeck's window, and within the
   * 10 s Novadeck's MCP server waits.
   */
  readonly answerMs?: number
}

/** What the endpoint hands on, each to the runner, which checks its token. */
export type ReportHandlers = {
  /** A hook's report; its relay hears `unheard` back. */
  readonly report: (report: Report) => void
  /** A hook's ask, answered by `deadline` or as `unheard`. */
  readonly ask: (report: Report, deadline: number) => Promise<HookAnswer>
  /** A hook's acknowledgement of a lease, which gets no answer. */
  readonly ack: (ack: Ack) => void
  /** A tool call, answered within `answerMs` or as unanswered. */
  readonly call: (call: Call) => Promise<unknown>
}

export type Reports = {
  /** Where hooks and calls connect: a socket in a private directory, or a named pipe. */
  readonly endpoint: string
  close(): Promise<void>
}

/**
 * Listens for Novadeck's relays (see application/relay), which speak only the relay
 * protocol (docs/backend-api.md, "Relay protocol"). Each connection's first line names
 * the relay's version and what it carries: an agent's hook, a report or an ask, answered
 * with one line, a `HookAnswer`, and then perhaps acknowledged (see `serveHook`); or an
 * agent's MCP session, which stays open for as long as the agent runs, its tool calls
 * handed on as calls (see `serveSession`). A connection whose first line is anything
 * else is ended without an answer. None is checked against the terminal's own token
 * here; the handlers do.
 */
export const listenForReports = async (
  handlers: ReportHandlers,
  options: ReportsOptions = {},
): Promise<Reports> => {
  const { platform = process.platform, readMs = 2_000, answerMs = 8_000 } = options
  const directory =
    platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "novadeck-reports-"))
  const endpoint =
    directory === undefined
      ? `\\\\.\\pipe\\novadeck-reports-${randomUUID()}`
      : join(directory, "reports.sock")
  // A relay's call: the terminal and token it named, answered within `answerMs`.
  const relayCall =
    (from: { terminalId: string; token: string }): McpCall =>
    (type, request) =>
      within(handlers.call({ type, ...from, request }), answerMs, unansweredCalls[type])
  /**
   * Answers a relay's hook with one line, a `HookAnswer`: a report at once, an ask by
   * its deadline or as `unheard`. The relay then prints what it delivers and, holding a
   * lease, acknowledges it with one more line, `{ ack }`, on the same connection.
   */
  const serveHook = async (
    socket: Socket,
    value: { readonly [key: string]: unknown },
    rest: string,
  ) => {
    // What the relay sends after its hook, read from the start: its acknowledgement,
    // which counts once its answer named the lease it acknowledges.
    let text = rest
    let lease: string | undefined
    // Whether the acknowledgement was taken, or none can come; nothing more is read.
    let done = false
    const take = (from: { terminalId: string; token: string }) => {
      if (lease === undefined) return
      const end = text.indexOf("\n")
      if (end < 0) return
      done = true
      socket.end()
      let ack: unknown
      try {
        ack = JSON.parse(text.slice(0, end))
      } catch {
        return
      }
      if (object(ack) && ack.ack === lease) handlers.ack({ ...from, leaseId: lease })
      lease = undefined
    }
    const from = sender(value)
    socket.on("data", (chunk: string) => {
      if (done) return
      text += chunk
      // An acknowledgement is one short line.
      if (text.length > maxBytes) return socket.destroy()
      if (from) take(from)
    })
    const hook = from && relayHook(value)
    let answer = unheard
    if (from && hook) {
      const report = { ...from, ...hook.report }
      if (hook.deadline === undefined) {
        handlers.report(report)
      } else {
        const ms = Math.min(answerMs, hook.deadline - Date.now())
        answer = await within(handlers.ask(report, hook.deadline), ms, unheard)
      }
    }
    if (!socket.writable) return
    socket.write(`${JSON.stringify(answer)}\n`)
    if (!from || answer.leaseId === null) {
      done = true
      socket.end()
      return
    }
    // The relay acknowledges the lease once it has printed what it delivers.
    lease = answer.leaseId
    socket.setTimeout(readMs, () => socket.destroy())
    take(from)
  }
  // Every connection, so closing ends the sessions that stay open.
  const sockets = new Set<Socket>()
  // Half open: a relay that ends its side after its hook still reads the answer, where the
  // platform keeps a half-closed connection. Windows' named pipes don't, so a relay keeps
  // its side open until the answer everywhere.
  const server: Server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    let text = ""
    let taken = false
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.setEncoding("utf8")
    socket.setTimeout(readMs, () => socket.destroy())
    socket.on("error", () => socket.destroy())
    // Ended without a whole line: nothing to take or answer.
    socket.on("end", () => {
      if (!taken) socket.end()
    })
    const first = (chunk: string) => {
      if (taken) return
      text += chunk
      // A relay's hook carries its agent's payload whole, which the runner prunes; the
      // relay names itself first.
      if (text.length > (text.startsWith(relayStart) ? maxRelayHook : maxBytes)) {
        return socket.destroy()
      }
      const end = text.indexOf("\n")
      if (end < 0) return
      taken = true
      let value: unknown
      try {
        value = JSON.parse(text.slice(0, end))
      } catch {
        value = undefined
      }
      const version =
        object(value) && typeof value.relay === "number" && relayVersions.has(value.relay)
          ? value.relay
          : undefined
      if (object(value) && version !== undefined && value.kind === "hook") {
        // The ask's own deadline bounds the wait.
        socket.setTimeout(0)
        socket.off("data", first)
        serveHook(socket, value, text.slice(end + 1)).catch(() => socket.destroy())
        return
      }
      if (object(value) && version !== undefined && value.kind === "mcp") {
        // An agent's MCP session lasts as long as the agent, and holds no runner open.
        socket.setTimeout(0)
        socket.unref()
        socket.off("data", first)
        const from = sender(value)
        serveSession(socket, text.slice(end + 1), from && relayCall(from), version)
        return
      }
      // Not a relay's this runner speaks with: nothing to take or answer.
      refuse(value)
      socket.end()
    }
    socket.on("data", first)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(endpoint, () => {
        server.off("error", reject)
        resolve()
      })
    })
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true })
    throw error
  }
  server.unref()
  return {
    endpoint,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
      if (directory) await rm(directory, { recursive: true, force: true })
    },
  }
}
