import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { agentName, type AgentName } from "@novadeck/protocol"

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
 * printed it. A null `stdout` leaves the hook to print what it does without NovaDeck.
 */
export type HookAnswer = { readonly leaseId: string | null; readonly stdout: string | null }

/** The answer to an ask that failed, took too long, or could not be read. */
export const unheard: HookAnswer = { leaseId: null, stdout: null }

/** A hook's word that it printed what a lease delivers. */
export type Ack = { readonly terminalId: string; readonly token: string; readonly leaseId: string }

/**
 * What NovaDeck's MCP server forwards: a tool call an agent made in a terminal, which
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
export const unanswered = { ok: false, reason: "NovaDeck couldn't show it." } as const

/** The same, for each type of call. */
export const unansweredCalls = {
  present: unanswered,
  showing: { ok: false, reason: "NovaDeck couldn't list what is showing beside you." },
  open: { ok: false, reason: "NovaDeck couldn't open the terminal." },
  close: { ok: false, reason: "NovaDeck couldn't close the terminal." },
  send: { ok: false, reason: "NovaDeck couldn't send the message." },
  agents: { ok: false, reason: "NovaDeck couldn't list the terminals." },
  describe: { ok: false, reason: "NovaDeck couldn't describe the terminal." },
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

const parse = (value: { readonly [key: string]: unknown }): Report | undefined => {
  const { agent, event, seq, instance, env, payload } = value
  const from = sender(value)
  if (!from) return undefined
  if (typeof seq !== "number" || !Number.isFinite(seq)) return undefined
  if (typeof event !== "string" || event.length > 64) return undefined
  const name = agentName.safeParse(agent)
  if (!name.success) return undefined
  if (!object(payload)) return undefined
  const { cursor, codexThread } = object(env) ? env : {}
  return {
    ...from,
    agent: name.data,
    event,
    seq,
    instance: typeof instance === "string" && /^\d{1,10}$/.test(instance) ? instance : null,
    env: {
      cursor: cursor === true,
      ...(typeof codexThread === "string" && codexThread.length <= 128 && { codexThread }),
    },
    payload,
  }
}

/** An ask: a report with the hook's deadline, in epoch milliseconds. */
const parseAsk = (value: {
  readonly [key: string]: unknown
}): { report: Report; deadline: number } | undefined => {
  const { deadline } = value
  const report = parse(value)
  if (!report || typeof deadline !== "number" || !Number.isFinite(deadline)) return undefined
  return { report, deadline }
}

const parseAck = (value: { readonly [key: string]: unknown }): Ack | undefined => {
  const { ack } = value
  const from = sender(value)
  if (!from || typeof ack !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(ack)) return undefined
  return { ...from, leaseId: ack }
}

const callType = (type: unknown): type is CallType => callTypes.some((known) => known === type)

const parseCall = (value: { readonly [key: string]: unknown }): Call | undefined => {
  const { type, request } = value
  const from = sender(value)
  if (!callType(type) || !from || !object(request)) return undefined
  return { type, ...from, request }
}

// A hook sends at most 60,000 characters; a little more allows for the frame. A call's
// request is a path or a command and a few words, well within it.
const maxBytes = 65_536

export type ReportsOptions = {
  readonly platform?: NodeJS.Platform
  /** How long a sender has to send its line, in milliseconds. */
  readonly readMs?: number
  /**
   * How long a call waits for its answer before it gets `unanswered`, in milliseconds:
   * by default 8 s, as opening a terminal waits for NovaDeck's window, and within the
   * 10 s NovaDeck's MCP server waits.
   */
  readonly answerMs?: number
}

/** What the endpoint hands on, each to the runner, which checks its token. */
export type ReportHandlers = {
  /** A hook's report, which gets no answer. */
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
 * Listens for agent hook reports, asks and acknowledgements, and calls. Each connection
 * sends one JSON line: an agent hook's report, handed on and closed without a reply; an
 * ask, a report with its hook's `deadline`, which gets one JSON line, a `HookAnswer`,
 * before it is closed, or `unheard` once that deadline passes; a hook's `ack` of a lease,
 * closed without a reply; or a call, one that names its `type`, which gets one JSON line
 * before it is closed. A call that cannot be read gets `unanswered`; one that fails or
 * takes longer than `answerMs`, the same for its type.
 * None is checked against the terminal's own token here; the handlers do.
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
  const respond = async <T>(socket: Socket, answer: Promise<T>, ms: number, failed: T) => {
    const timeout = new AbortController()
    const result = await Promise.race([
      answer.catch(() => failed),
      sleep(Math.max(0, ms), failed, { signal: timeout.signal }),
    ])
    timeout.abort()
    let line: string | undefined
    try {
      line = JSON.stringify(result)
    } catch {
      // Not JSON; answered as a failure below.
    }
    socket.end(`${line ?? JSON.stringify(failed)}\n`)
    // A caller that never closes its side is let go after a while.
    socket.setTimeout(readMs)
  }
  // Half open: a sender that ends its side after its line still reads the answer, where
  // the platform keeps a half-closed connection. Windows' named pipes don't, so a caller
  // there, as NovaDeck's MCP server everywhere, keeps its side open until the answer.
  const server: Server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    let text = ""
    let taken = false
    socket.setEncoding("utf8")
    socket.setTimeout(readMs, () => socket.destroy())
    socket.on("error", () => socket.destroy())
    // Ended without a whole line: nothing to take or answer.
    socket.on("end", () => {
      if (!taken) socket.end()
    })
    socket.on("data", (chunk: string) => {
      if (taken) return
      text += chunk
      if (text.length > maxBytes) return socket.destroy()
      const end = text.indexOf("\n")
      if (end < 0) return
      taken = true
      let value: unknown
      try {
        value = JSON.parse(text.slice(0, end))
      } catch {
        value = undefined
      }
      if (object(value) && "type" in value) {
        // The answer's own deadline bounds the wait.
        socket.setTimeout(0)
        const call = parseCall(value)
        const failed = call ? unansweredCalls[call.type] : unanswered
        const answer = call ? handlers.call(call) : Promise.resolve(failed)
        respond(socket, answer, answerMs, failed).catch(() => socket.destroy())
        return
      }
      if (object(value) && "deadline" in value) {
        // As for a call; the hook's own deadline bounds the wait.
        socket.setTimeout(0)
        const ask = parseAsk(value)
        const answer = ask ? handlers.ask(ask.report, ask.deadline) : Promise.resolve(unheard)
        const ms = ask ? Math.min(answerMs, ask.deadline - Date.now()) : 0
        respond(socket, answer, ms, unheard).catch(() => socket.destroy())
        return
      }
      socket.end()
      if (object(value) && "ack" in value) {
        const ack = parseAck(value)
        if (ack) handlers.ack(ack)
        return
      }
      const parsed = object(value) ? parse(value) : undefined
      if (parsed) handlers.report(parsed)
    })
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
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (directory) await rm(directory, { recursive: true, force: true })
    },
  }
}
