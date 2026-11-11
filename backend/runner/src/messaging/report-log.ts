import {
  inboxEntry,
  maxTurnError,
  maxTurnFilePath,
  maxTurnFiles,
  replyPreviewLength,
  type AgentName,
  type InboxEntry,
} from "@novadeck/protocol"

import { cut } from "../text.js"
import { pullRequestIn, type Happening, type Reports } from "./peers.js"

/** What a turn entry holds of its end. */
export type TurnContent = Extract<InboxEntry["content"], { kind: "turn" }>

const clipped = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 ? cut(value, max) : null

/**
 * A stored turn entry as today's rules read it: its text cut to the limits, its files
 * capped, unknown keys dropped and an unknown outcome taken as failed, so a limit that
 * tightens later costs an entry nothing. Undefined where it still won't parse.
 */
export const clampedTurn = (content: unknown): TurnContent | undefined => {
  if (typeof content !== "object" || content === null) return undefined
  const raw = content as { [key: string]: unknown }
  const files = Array.isArray(raw["files"])
    ? raw["files"].flatMap((file: unknown) => {
        const path = clipped(file, maxTurnFilePath)
        return path ? [path] : []
      })
    : []
  const parsed = inboxEntry.shape.content.safeParse({
    kind: "turn",
    outcome: raw["outcome"] === "completed" ? "completed" : "failed",
    reply: clipped(raw["reply"], replyPreviewLength),
    error: clipped(raw["error"], maxTurnError),
    files: files.slice(0, maxTurnFiles),
  })
  return parsed.success && parsed.data.kind === "turn" ? parsed.data : undefined
}

/** How many `done`, `tell` and ask rows each agent session keeps; the oldest go first. */
export const keptReports = 50

/** How many finished turns each agent session keeps. */
export const keptTurns = 10

/**
 * One thing an agent session did, as the log keeps it in memory: a report (`done`, `tell`),
 * an ask, or a finished turn. Everything but a report's or ask's body, which only the store
 * holds (see `LogWrite`), so a listing that doesn't quote one never reads one.
 */
export type LoggedReport = {
  /** An entry's own id for a report or ask, so they are told apart from the Inbox's; a turn's is its own. */
  readonly id: string
  readonly projectId: string
  /** The terminal it was made in, which a restore or a resume elsewhere leaves behind. */
  readonly terminalId: string
  readonly agent: AgentName
  /** The agent session whose it is, which the log is read by. */
  readonly sessionId: string
  readonly kind: "done" | "tell" | "ask" | "turn"
  /** When it was made, or the turn ended. */
  readonly at: number
  /** When the turn started; null where that isn't known (as for a report, or after a restart). */
  readonly from: number | null
  /** A report's or ask's subject. */
  readonly subject: string | null
  /** How the turn ended. */
  readonly outcome: "completed" | "failed" | null
  /** The start of a completed turn's reply, or a failed one's error, redacted as its Inbox row is. */
  readonly text: string | null
  /** The latest pull request link in a report's subject or body, found as it was written. */
  readonly pr: string | null
}

/** A row and the body the store keeps beside it: what a report or ask said at length. */
export type LogWrite = { readonly row: LoggedReport; readonly body: string | null }

/** The log row an Inbox entry makes, with `from` as the start of a turn. */
export const reportOf = (entry: InboxEntry, from: number | null = null): LogWrite => {
  const { content } = entry
  const row = {
    id: entry.id,
    projectId: entry.projectId,
    terminalId: entry.terminalId,
    agent: entry.agent,
    sessionId: entry.sessionId,
    at: entry.at,
    from: null,
    subject: null,
    outcome: null,
    text: null,
    pr: null,
  }
  if (content.kind === "ask")
    return { row: { ...row, kind: "ask", subject: content.ask.subject }, body: content.ask.body }
  if (content.kind === "turn")
    return {
      row: {
        ...row,
        kind: "turn",
        from,
        outcome: content.outcome,
        text: content.outcome === "failed" ? content.error : content.reply,
      },
      body: null,
    }
  return {
    row: {
      ...row,
      kind: content.kind,
      subject: content.subject,
      pr: pullRequestIn(`${content.subject}\n${content.body}`),
    },
    body: content.body,
  }
}

/**
 * The log row a stored Inbox record makes, by the rules the Inbox reads it with at start:
 * undefined for a record of an agent this build doesn't know, or whose content it would
 * drop. For the migration that fills the log from the Inbox's rows, which must never fail
 * on one.
 */
export const storedReport = (
  record: unknown,
  known: (agent: unknown) => agent is AgentName,
): LogWrite | undefined => {
  if (typeof record !== "object" || record === null) return undefined
  const entry = record as { [key: string]: unknown }
  const { id, projectId, terminalId, sessionId, at } = entry
  if (
    typeof id !== "string" ||
    typeof projectId !== "string" ||
    typeof terminalId !== "string" ||
    typeof sessionId !== "string" ||
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    !known(entry["agent"])
  )
    return undefined
  const raw = entry["content"]
  const content =
    typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "turn"
      ? clampedTurn(raw)
      : (() => {
          const parsed = inboxEntry.shape.content.safeParse(raw)
          return parsed.success ? parsed.data : undefined
        })()
  if (!content) return undefined
  return reportOf({ ...(entry as unknown as InboxEntry), content })
}

/** Where a row's body is read when asked for; empty where it has none. */
export type BodyReader = (id: string) => string

/** The Happening `team` lists for a row, with the body where it was read. */
const happeningOf = (row: LoggedReport, read: BodyReader | undefined): Happening => {
  if (row.kind === "ask") return { kind: "asked", at: row.at, subject: row.subject ?? "" }
  if (row.kind === "turn")
    return {
      kind: "turn",
      at: row.at,
      from: row.from,
      outcome: row.outcome ?? "failed",
      text: row.text,
    }
  return {
    kind: row.kind === "tell" ? "update" : "done",
    at: row.at,
    subject: row.subject ?? "",
    body: null,
    pr: row.pr,
    ...(read && { read: () => read(row.id) }),
  }
}

const keyOf = (agent: string, sessionId: string): string => `${agent}\u0000${sessionId}`

/**
 * What the agent sessions reported and how their turns ended, in memory, apart from the
 * Inbox's rows, which the person's reading and a day's passing take away: a peer's `agents`
 * and a lead's `team` read it, as do the terminal summary's standing `done`. The store keeps
 * the same rows (the Inbox saves each with its own entry); this holds all but their bodies.
 * Rows are by agent session, not terminal: a terminal restored from History, or a session
 * resumed in another, reads what the session did before.
 */
export class ReportLog {
  private readonly rows = new Map<string, LoggedReport>()
  private readonly sessions = new Map<string, Set<string>>()

  constructor(rows: readonly LoggedReport[] = []) {
    for (const row of rows) this.put(row)
  }

  get(id: string): LoggedReport | undefined {
    return this.rows.get(id)
  }

  /** Keeps a row, replacing the one of its id, which may have been another session's. */
  put(row: LoggedReport): void {
    const old = this.rows.get(row.id)
    if (old) this.unindex(old)
    this.rows.set(row.id, row)
    const key = keyOf(row.agent, row.sessionId)
    const ids = this.sessions.get(key) ?? new Set<string>()
    ids.add(row.id)
    this.sessions.set(key, ids)
  }

  /** The turn of the terminal that ended at `at`, if one is kept. */
  turnAt(terminalId: string, at: number): LoggedReport | undefined {
    for (const row of this.rows.values())
      if (row.kind === "turn" && row.terminalId === terminalId && row.at === at) return row
    return undefined
  }

  /** The rows of an agent session, oldest first. */
  of(agent: string, sessionId: string): LoggedReport[] {
    const rows = [...(this.sessions.get(keyOf(agent, sessionId)) ?? [])].map((id) =>
      this.rows.get(id)!,
    )
    return rows.toSorted((a, b) => a.at - b.at)
  }

  /** The latest `tell` and latest `done` of an agent session. */
  reports(agent: string, sessionId: string): Reports {
    let tell: LoggedReport | undefined
    let done: LoggedReport | undefined
    for (const row of this.of(agent, sessionId)) {
      if (row.kind === "tell") tell = row
      if (row.kind === "done") done = row
    }
    return {
      tell: tell ? { subject: tell.subject ?? "", at: tell.at } : null,
      done: done ? { subject: done.subject ?? "", at: done.at } : null,
    }
  }

  /**
   * What an agent session did, oldest first, as `team` lists it. A report's body is left
   * unread; with `bodies`, the report can read it when asked to, and no sooner.
   */
  happenings(agent: string, sessionId: string, bodies?: BodyReader): Happening[] {
    return this.of(agent, sessionId).map((row) => happeningOf(row, bodies))
  }

  /** Every row, for a sweep to judge. */
  all(): LoggedReport[] {
    return [...this.rows.values()]
  }

  /**
   * The rows an agent session holds beyond what it keeps, oldest first: its reports and
   * asks past `keptReports`, and its turns past `keptTurns`.
   */
  excess(agent: string, sessionId: string): string[] {
    const rows = this.of(agent, sessionId)
    const turns = rows.filter((row) => row.kind === "turn")
    const others = rows.filter((row) => row.kind !== "turn")
    return [
      ...turns.slice(0, Math.max(0, turns.length - keptTurns)),
      ...others.slice(0, Math.max(0, others.length - keptReports)),
    ].map((row) => row.id)
  }

  /** Forgets the rows with these ids. */
  remove(ids: readonly string[]): void {
    for (const id of ids) {
      const row = this.rows.get(id)
      if (!row) continue
      this.unindex(row)
      this.rows.delete(id)
    }
  }

  /**
   * Gives the rows `moves` picks to another session of the same agent; the rows changed.
   * For a guessed session found to be another (see `Inbox.rooted`).
   */
  rekey(moves: (row: LoggedReport) => boolean, sessionId: string): LoggedReport[] {
    const moved = [...this.rows.values()].filter(moves).map((row) => ({ ...row, sessionId }))
    for (const row of moved) this.put(row)
    return moved
  }

  /** Forgets a removed project's rows; their ids. */
  forgetProject(projectId: string): string[] {
    const gone = [...this.rows.values()].filter((row) => row.projectId === projectId)
    this.remove(gone.map((row) => row.id))
    return gone.map((row) => row.id)
  }

  /** Forgets the rows `keeps` refuses; their ids. */
  retain(keeps: (row: LoggedReport) => boolean): string[] {
    const gone = [...this.rows.values()].filter((row) => !keeps(row))
    this.remove(gone.map((row) => row.id))
    return gone.map((row) => row.id)
  }

  private unindex(row: LoggedReport): void {
    const key = keyOf(row.agent, row.sessionId)
    const ids = this.sessions.get(key)
    ids?.delete(row.id)
    if (!ids?.size) this.sessions.delete(key)
  }
}
