import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

const parse = (value: unknown): Report | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { terminalId, token, agent, event, seq, instance, env, payload } = value as Record<
    string,
    unknown
  >
  if (typeof terminalId !== "string" || terminalId.length > 64) return undefined
  // The runner's tokens are 48 hex digits; anything else cannot match one.
  if (typeof token !== "string" || !/^[0-9a-f]{48}$/.test(token)) return undefined
  if (typeof seq !== "number" || !Number.isFinite(seq)) return undefined
  if (typeof event !== "string" || event.length > 64) return undefined
  const name = agentName.safeParse(agent)
  if (!name.success) return undefined
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined
  const { cursor, codexThread } = (typeof env === "object" && env !== null ? env : {}) as Record<
    string,
    unknown
  >
  return {
    terminalId,
    token,
    agent: name.data,
    event,
    seq,
    instance: typeof instance === "string" && /^\d{1,10}$/.test(instance) ? instance : null,
    env: {
      cursor: cursor === true,
      ...(typeof codexThread === "string" && codexThread.length <= 128 && { codexThread }),
    },
    payload: payload as Report["payload"],
  }
}

// A hook sends at most 60,000 characters; a little more allows for the frame.
const maxBytes = 65_536
const timeoutMs = 2_000

export type Reports = {
  /** Where the hook connects: a socket in a private directory, or a named pipe. */
  readonly endpoint: string
  close(): Promise<void>
}

/**
 * Listens for agent hook reports. This endpoint takes one kind of message and nothing
 * else: an agent hook's report, which `accept` checks against the terminal's own
 * token. Each connection sends one JSON line and is closed.
 */
export const listenForReports = async (
  accept: (report: Report) => void,
  platform = process.platform,
): Promise<Reports> => {
  const directory =
    platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "novadeck-reports-"))
  const endpoint =
    directory === undefined
      ? `\\\\.\\pipe\\novadeck-reports-${randomUUID()}`
      : join(directory, "reports.sock")
  const server: Server = createServer((socket: Socket) => {
    let text = ""
    socket.setEncoding("utf8")
    socket.setTimeout(timeoutMs, () => socket.destroy())
    socket.on("error", () => socket.destroy())
    socket.on("data", (chunk: string) => {
      text += chunk
      if (text.length > maxBytes) socket.destroy()
      const end = text.indexOf("\n")
      if (end < 0) return
      socket.end()
      let value: unknown
      try {
        value = JSON.parse(text.slice(0, end))
      } catch {
        return
      }
      const parsed = parse(value)
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
