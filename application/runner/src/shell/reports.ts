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
 * What NovaDeck's MCP server forwards: a tool call an agent made in a terminal, which
 * waits for its answer. The runner reads `request` (see `terminals/artifacts.ts`);
 * nothing here does.
 */
export type Call = {
  readonly type: "present"
  readonly terminalId: string
  readonly token: string
  readonly request: { readonly [key: string]: unknown }
}

/** The answer to a call that failed, took too long, or could not be read. */
export const unanswered = { ok: false, reason: "NovaDeck couldn't show it." } as const

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

const parseCall = (value: { readonly [key: string]: unknown }): Call | undefined => {
  const { type, request } = value
  const from = sender(value)
  if (type !== "present" || !from || !object(request)) return undefined
  return { type, ...from, request }
}

// A hook sends at most 60,000 characters; a little more allows for the frame. A call's
// request is a path and a few words, well within it.
const maxBytes = 65_536

export type ReportsOptions = {
  readonly platform?: NodeJS.Platform
  /** How long a sender has to send its line, in milliseconds. */
  readonly readMs?: number
  /** How long a call waits for its answer before it gets `unanswered`, in milliseconds. */
  readonly answerMs?: number
}

export type Reports = {
  /** Where hooks and calls connect: a socket in a private directory, or a named pipe. */
  readonly endpoint: string
  close(): Promise<void>
}

/**
 * Listens for agent hook reports and calls. Each connection sends one JSON line: an
 * agent hook's report, handed to `accept` and closed without a reply; or a call, one
 * that names its `type`, which gets one JSON line from `answer` before it is closed.
 * A call that cannot be read, fails, or takes longer than `answerMs` gets `unanswered`.
 * Neither is checked against the terminal's own token here; `accept` and `answer` do.
 */
export const listenForReports = async (
  accept: (report: Report) => void,
  answer: (call: Call) => Promise<unknown>,
  options: ReportsOptions = {},
): Promise<Reports> => {
  const { platform = process.platform, readMs = 2_000, answerMs = 5_000 } = options
  const directory =
    platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "novadeck-reports-"))
  const endpoint =
    directory === undefined
      ? `\\\\.\\pipe\\novadeck-reports-${randomUUID()}`
      : join(directory, "reports.sock")
  const reply = async (socket: Socket, call: Call | undefined) => {
    const timeout = new AbortController()
    const result = await Promise.race([
      call ? answer(call).catch(() => unanswered) : unanswered,
      sleep(answerMs, unanswered, { signal: timeout.signal }),
    ])
    timeout.abort()
    let line: string | undefined
    try {
      line = JSON.stringify(result)
    } catch {
      // Not JSON; answered as a failure below.
    }
    socket.end(`${line ?? JSON.stringify(unanswered)}\n`)
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
        reply(socket, parseCall(value)).catch(() => socket.destroy())
        return
      }
      socket.end()
      const parsed = object(value) ? parse(value) : undefined
      if (parsed) accept(parsed)
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
