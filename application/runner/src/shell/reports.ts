import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

import { agentName, agentSessionId, type AgentName } from "@novadeck/protocol"

import type { AgentReport } from "../terminals/records.js"

/** What the agent hook reports: which session runs in which terminal. */
export type Report = {
  readonly terminalId: string
  readonly token: string
  readonly agent: AgentName
  readonly sessionId: string
  readonly seq: number
  /** The agent's own directory, when it is an absolute path here. */
  readonly cwd?: string
  /** Why the agent started the session: startup, resume, clear… */
  readonly source?: string
}

const absolute = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 4096 && !value.includes("\0") && isAbsolute(value)
    ? value
    : undefined

const parse = (value: unknown): Report | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { terminalId, token, agent, sessionId, seq, cwd, source } = value as Record<string, unknown>
  if (typeof terminalId !== "string" || terminalId.length > 64) return undefined
  // The runner's tokens are 48 hex digits; anything else cannot match one.
  if (typeof token !== "string" || !/^[0-9a-f]{48}$/.test(token)) return undefined
  if (typeof seq !== "number" || !Number.isFinite(seq)) return undefined
  const name = agentName.safeParse(agent)
  const session = agentSessionId.safeParse(sessionId)
  if (!name.success || !session.success) return undefined
  const where = absolute(cwd)
  return {
    terminalId,
    token,
    agent: name.data,
    sessionId: session.data,
    seq,
    ...(where !== undefined && { cwd: where }),
    ...(typeof source === "string" && source.length <= 32 && { source }),
  }
}

/** What a terminal knows of its agents, which a report may change. */
export type AgentState = {
  readonly agents: { readonly [agent in AgentName]?: AgentReport }
  /** The agent that reported since the shell's last prompt, holding the foreground. */
  readonly active: AgentName | null
  readonly cwd: string
}

/** What the runner can tell about the terminal as a report arrives. */
export type ReportFacts = {
  /** When the shell last showed its prompt, in epoch milliseconds. */
  readonly promptedAt: number | null
  /** Whether the shell itself holds the foreground; undefined where the platform hides it. */
  readonly shellInForeground: boolean | undefined
  /** Whether a line was entered since the last prompt, for platforms that hide the foreground. */
  readonly submitted: boolean
  readonly platform: NodeJS.Platform
}

/**
 * The terminal's agents after a report, or undefined when it is not this terminal's own
 * or not the latest. Processes that merely inherited the terminal's environment report
 * too: a tmux server or an editor started from it, while its shell holds the foreground
 * (Windows does not tell, so there an agent counts only once a line was entered), and an
 * agent run by the agent in the foreground, which starts a new session of its own. A
 * session switch of the agent in the foreground, as /clear or /resume, says so in its
 * source; a report without one (Antigravity's) switches its own agent's conversation.
 * Since the last prompt, the reporting agent holds the foreground, and its directory is
 * where the terminal restores, as a shell that ran `cd … && claude` shows no prompt there.
 */
export const acceptReport = (
  state: AgentState,
  { agent, sessionId, seq, cwd, source }: Omit<Report, "terminalId" | "token">,
  facts: ReportFacts,
): AgentState | undefined => {
  if (facts.shellInForeground) return undefined
  if (facts.platform === "win32" && !facts.submitted) return undefined
  const { active } = state
  const switched = source === undefined ? agent === active : source !== "startup"
  if (active !== null && !switched)
    if (active !== agent || state.agents[active]?.sessionId !== sessionId) return undefined
  const known = state.agents[agent]
  if (known && known.seq >= seq) return undefined
  const agents = { ...state.agents, [agent]: { sessionId, seq } }
  return seq > (facts.promptedAt ?? 0)
    ? { agents, active: agent, cwd: cwd ?? state.cwd }
    : { agents, active, cwd: state.cwd }
}

const maxBytes = 4096
const timeoutMs = 2_000

export type Reports = {
  /** Where the hook connects: a socket in a private directory, or a named pipe. */
  readonly endpoint: string
  close(): Promise<void>
}

/**
 * Listens for agent hook reports. This endpoint takes one kind of message and nothing
 * else: a report of an agent session, which `accept` checks against the terminal's own
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
