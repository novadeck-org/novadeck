import { chmodSync, closeSync, mkdirSync, openSync, statSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import { DatabaseSync, type SQLTagStore } from "node:sqlite"

import {
  voiceCheck,
  voiceLanguage,
  voiceModel,
  type AgentName,
  type Project,
  type RunnerSettings,
  type VoiceCheck,
  type VoiceSettings,
  type WorkspaceSession,
} from "@novadeck/protocol"

import type { ItemRecord, ItemRecords, Placed, WindowRecord } from "../companions/records.js"
import { DomainError } from "../errors.js"
import type { Message, Thread } from "../messaging/mailbox.js"
import type { MailboxRecords } from "../messaging/records.js"
import type { Naming } from "../terminals/naming.js"
import type {
  ListedTerminal,
  SavedTerminal,
  TerminalIdentity,
  TerminalRecords,
  TerminalToSave,
} from "../terminals/records.js"
import type { Work } from "../terminals/work.js"

/** Settings to change; those left out, or undefined, stay as they are. */
export type VoiceSettingsChange = {
  readonly [K in Exclude<keyof VoiceSettings, "enabled">]?: VoiceSettings[K] | undefined
} & {
  /** `null` forgets the choice, as when it is turned on before an install. */
  readonly enabled?: boolean | null | undefined
}

export type SettingsChange = {
  readonly [K in keyof RunnerSettings]?: RunnerSettings[K] | undefined
}

const schemaVersion = 1
const schema = `
  CREATE TABLE projects (
    position INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
    cwd TEXT NOT NULL CHECK(length(cwd) > 0)
  ) STRICT;
  CREATE TABLE sessions (
    position INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
    -- Opaque client state, such as a UI layout; null until the first save.
    state TEXT
  ) STRICT;
  CREATE INDEX sessions_project ON sessions(project_id, position);
`
// Tables added before the first release are created where missing instead of through
// a schema version: the app is unreleased, so nothing needs migrating.
const extras = `
  -- Every terminal, until it is closed, and what restores it after its shell is gone:
  -- kept as it changes, so a runner that is killed still leaves it behind.
  CREATE TABLE IF NOT EXISTS terminals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    -- Its handle in its session, t3, from the same count as its default title.
    handle TEXT NOT NULL,
    -- The shell's last reported directory.
    cwd TEXT NOT NULL,
    -- The latest session each agent reported, as JSON: { "claude": { sessionId, seq } }.
    agents TEXT NOT NULL,
    -- When the shell last showed its prompt, in epoch milliseconds.
    prompted_at REAL,
    -- The screen and scrollback, serialized; null when not kept.
    transcript TEXT,
    updated_at REAL NOT NULL,
    -- The title the person gave it; null when its title is automatic.
    person_title TEXT,
    -- The latest title an agent gave it, and that agent's terminal's handle.
    agent_title TEXT,
    agent_titled_by TEXT,
    -- What its own agent said it works on, through describe.
    summary TEXT,
    -- The handle of the terminal whose agent opened it; null otherwise.
    opened_by TEXT,
    -- The handle of its lead: the terminal whose agent opened it with a brief for the agent
    -- there, until that agent exits; null otherwise.
    led_by TEXT,
    -- The command it was opened to run at its first prompt.
    command TEXT,
    -- The program in its foreground when its shell was last seen.
    last_program TEXT,
    -- What its root agent session worked on, for agents messaging each other, as JSON.
    work TEXT
  ) STRICT;
  -- The last number given to a session's terminals, for their handles and default titles.
  CREATE TABLE IF NOT EXISTS terminal_numbers (
    session_id TEXT PRIMARY KEY,
    last INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  -- Agent messaging (docs/agent-messaging.md).
  CREATE TABLE IF NOT EXISTS message_threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    -- Its two terminals, in the order its first message went.
    first_terminal TEXT NOT NULL,
    second_terminal TEXT NOT NULL,
    hops INTEGER NOT NULL,
    -- How many it may deliver before the person releases it again.
    allowed INTEGER NOT NULL,
    last_at REAL NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    hop INTEGER NOT NULL,
    from_terminal TEXT NOT NULL,
    from_handle TEXT NOT NULL,
    from_agent TEXT,
    from_session TEXT,
    to_terminal TEXT NOT NULL,
    to_handle TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    -- Null while it waits for the first session of its agent to bind there.
    to_session TEXT,
    text TEXT NOT NULL,
    sent_at REAL NOT NULL,
    state TEXT NOT NULL,
    delivered_at REAL,
    -- Whether its sender was told it is gone.
    notified INTEGER NOT NULL,
    -- Whether its sender was its recipient's lead when it was sent.
    from_lead INTEGER NOT NULL,
    -- Whether its recipient was its sender's lead when it was sent.
    to_lead INTEGER NOT NULL
  ) STRICT;
  -- What agents show and the person attaches beside a terminal: pointers, never copies.
  -- Each item is held by one terminal's bar or one undocked window, and goes with it.
  CREATE TABLE IF NOT EXISTS companion_windows (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- The title the person gave it; null when it is named by its item.
    person_title TEXT,
    created_at REAL NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS companion_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    terminal_id TEXT REFERENCES terminals(id) ON DELETE CASCADE,
    window_id TEXT UNIQUE REFERENCES companion_windows(id) ON DELETE CASCADE,
    -- A file's resolved path, a page's address, or a plan's slot, unique on one bar.
    pointer_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'file', 'page', 'plan')),
    path TEXT,
    url TEXT,
    lines_from INTEGER,
    lines_to INTEGER,
    -- A plan's agent, session and actor (empty for the root), and whether it is a file
    -- or text in the transcript or rollout at path.
    plan_agent TEXT,
    plan_session TEXT,
    plan_actor TEXT,
    plan_format TEXT CHECK (plan_format IN ('file', 'text')),
    name TEXT NOT NULL,
    detail TEXT NOT NULL,
    held INTEGER NOT NULL,
    shown_by TEXT NOT NULL CHECK (shown_by IN ('agent', 'person')),
    from_terminal TEXT NOT NULL,
    from_handle TEXT NOT NULL,
    version INTEGER NOT NULL,
    asked INTEGER NOT NULL,
    shown_at REAL NOT NULL,
    observed_at REAL,
    CHECK ((terminal_id IS NULL) <> (window_id IS NULL))
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS companion_items_bar ON companion_items(terminal_id, pointer_key)
    WHERE terminal_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS companion_items_session ON companion_items(session_id);
`
const prepareFile = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    closeSync(openSync(path, "wx", 0o600))
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error
    }
  }
  const file = statSync(path)
  if (process.platform !== "win32" && file.uid === process.getuid?.()) {
    chmodSync(path, 0o600)
  }
}

type Column = { readonly name: string; readonly type: string; readonly notnull: number }

/** Every table's columns, by table, as `PRAGMA table_info` gives them. */
const columnsOf = (database: DatabaseSync): Map<string, readonly Column[]> => {
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[]
  return new Map(
    tables.map(({ name }) => [
      name,
      database
        .prepare('SELECT name, type, "notnull" FROM pragma_table_info(?)')
        .all(name) as Column[],
    ]),
  )
}

/** The tables and columns this runner writes, from a database it creates. */
const expectedColumns = (() => {
  let expected: Map<string, readonly Column[]> | undefined
  return () => {
    if (expected) return expected
    const reference = new DatabaseSync(":memory:")
    try {
      reference.exec(`${schema}${extras}`)
      expected = columnsOf(reference)
    } finally {
      reference.close()
    }
    return expected
  }
})()

const describeColumn = ({ name, type, notnull }: Column): string =>
  `${name} ${type}${notnull ? " NOT NULL" : ""}`

/**
 * How a database's tables differ from those this runner writes, as an earlier build's
 * would; undefined when they don't. Tables it doesn't know are left alone.
 */
const schemaDifference = (database: DatabaseSync): string | undefined => {
  const actual = columnsOf(database)
  for (const [table, columns] of expectedColumns()) {
    const found = actual.get(table)
    if (!found) return `it has no ${table} table`
    const want = columns.map(describeColumn).toSorted()
    const have = found.map(describeColumn).toSorted()
    const missing = want.filter((column) => !have.includes(column))
    const extra = have.filter((column) => !want.includes(column))
    if (missing.length > 0 || extra.length > 0)
      return `its ${table} table differs (${[
        ...missing.map((column) => `expects ${column}`),
        ...extra.map((column) => `has ${column}`),
      ].join(", ")})`
  }
  return undefined
}

/**
 * Creates the schema in a new database, and refuses one written by a newer runner, or by
 * an earlier build whose tables differ: Novadeck has no migrations before its first
 * release, so such a database is to be deleted, never changed here.
 */
const prepareSchema = (database: DatabaseSync, path: string): void => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const version = database.prepare("PRAGMA user_version").get()?.user_version
    if (typeof version !== "number" || version > schemaVersion) {
      throw new Error("The workspace database schema is newer than this runner supports")
    }
    if (version === 0) database.exec(`${schema} PRAGMA user_version = ${schemaVersion};`)
    database.exec(extras)
    const difference = schemaDifference(database)
    if (difference)
      throw new Error(
        `Novadeck's workspace database at ${path} was written by an earlier build: ` +
          `${difference}. Novadeck has no migrations before its first release, so delete ` +
          "that file (it holds your projects, sessions and kept terminals) and start again.",
      )
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

type TerminalRow = {
  id: string
  session_id: string
  cwd: string
  agents: string
  prompted_at: number | null
  transcript: string | null
  updated_at: number
  handle: string
  person_title: string | null
  agent_title: string | null
  agent_titled_by: string | null
  summary: string | null
  opened_by: string | null
  led_by: string | null
  command: string | null
  last_program: string | null
  work: string | null
}

const workOf = (text: string | null): Work | null => {
  if (text === null) return null
  try {
    return JSON.parse(text) as Work
  } catch {
    return null
  }
}

type NamingRow = Pick<TerminalRow, "person_title" | "agent_title" | "agent_titled_by" | "summary">

const namingOf = (row: NamingRow): Naming => ({
  person: row.person_title,
  agent:
    row.agent_title !== null && row.agent_titled_by !== null
      ? { title: row.agent_title, by: row.agent_titled_by }
      : null,
  summary: row.summary,
})

const listed = (row: Omit<TerminalRow, "transcript">): ListedTerminal => ({
  id: row.id,
  sessionId: row.session_id,
  handle: row.handle,
  naming: namingOf(row),
  work: workOf(row.work),
  openedBy: row.opened_by,
  ledBy: row.led_by,
  command: row.command,
  lastProgram: row.last_program,
  cwd: row.cwd,
  agents: agentsOf(row.agents),
  promptedAt: row.prompted_at,
  savedAt: row.updated_at,
})

const agentsOf = (text: string): SavedTerminal["agents"] => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null ? (value as SavedTerminal["agents"]) : {}
  } catch {
    return {}
  }
}

type MessageRow = {
  id: string
  project_id: string
  thread_id: string
  hop: number
  from_terminal: string
  from_handle: string
  from_agent: string | null
  from_session: string | null
  to_terminal: string
  to_handle: string
  to_agent: string
  to_session: string | null
  text: string
  sent_at: number
  state: string
  delivered_at: number | null
  notified: number
  from_lead: number
  to_lead: number
}

type ThreadRow = {
  id: string
  project_id: string
  first_terminal: string
  second_terminal: string
  hops: number
  allowed: number
  last_at: number
}

const messageOf = (row: MessageRow): Message => ({
  id: row.id,
  projectId: row.project_id,
  thread: row.thread_id,
  hop: row.hop,
  from: {
    terminalId: row.from_terminal,
    handle: row.from_handle,
    agent: row.from_agent as Message["from"]["agent"],
    sessionId: row.from_session,
  },
  to: {
    terminalId: row.to_terminal,
    handle: row.to_handle,
    agent: row.to_agent as Message["to"]["agent"],
    sessionId: row.to_session,
  },
  text: row.text,
  sentAt: row.sent_at,
  state: row.state as Message["state"],
  deliveredAt: row.delivered_at,
  notified: row.notified === 1,
  fromLead: row.from_lead === 1,
  toLead: row.to_lead === 1,
})

/** Whether SQLite refused a write for a row it references that is not there. */
const missingReference = (error: unknown): boolean =>
  (error as { errcode?: unknown } | undefined)?.errcode === 787

/** A write that references a row, failing as `code` when that row is gone. */
const referencing = <T>(code: "TERMINAL_NOT_FOUND" | "NOT_FOUND", write: () => T): T => {
  try {
    return write()
  } catch (error) {
    if (missingReference(error)) throw new DomainError(code)
    throw error
  }
}

type ItemRow = {
  id: string
  session_id: string
  terminal_id: string | null
  window_id: string | null
  pointer_key: string
  kind: ItemRecord["kind"]
  path: string | null
  url: string | null
  lines_from: number | null
  lines_to: number | null
  plan_agent: string | null
  plan_session: string | null
  plan_actor: string | null
  plan_format: string | null
  name: string
  detail: string
  held: number
  shown_by: ItemRecord["by"]
  from_terminal: string
  from_handle: string
  version: number
  asked: number
  shown_at: number
  observed_at: number | null
}

const itemOf = (row: ItemRow): ItemRecord => ({
  id: row.id,
  sessionId: row.session_id,
  terminalId: row.terminal_id,
  windowId: row.window_id,
  pointerKey: row.pointer_key,
  kind: row.kind,
  path: row.path,
  url: row.url,
  lines:
    row.lines_from !== null && row.lines_to !== null
      ? { from: row.lines_from, to: row.lines_to }
      : null,
  plan:
    row.plan_agent !== null && row.plan_session !== null
      ? {
          agent: row.plan_agent as AgentName,
          session: row.plan_session,
          actor: row.plan_actor || null,
          format: row.plan_format === "text" ? "text" : "file",
        }
      : null,
  name: row.name,
  detail: row.detail,
  held: row.held === 1,
  by: row.shown_by,
  from: { terminalId: row.from_terminal, handle: row.from_handle },
  version: row.version,
  asked: row.asked === 1,
  shownAt: row.shown_at,
  observedAt: row.observed_at,
})

type WindowRow = {
  id: string
  session_id: string
  person_title: string | null
  item_id: string
  item_name: string
}

const windowOf = (row: WindowRow): WindowRecord => ({
  id: row.id,
  sessionId: row.session_id,
  itemId: row.item_id,
  itemName: row.item_name,
  personTitle: row.person_title,
})

export class WorkspaceStore implements TerminalRecords, MailboxRecords, ItemRecords {
  private readonly database: DatabaseSync
  private readonly queries: SQLTagStore
  private lastSave = 0

  constructor(path = ":memory:") {
    if (path !== ":memory:") prepareFile(path)
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    })
    try {
      prepareSchema(this.database, path)
    } catch (error) {
      this.database.close()
      throw error
    }
    // Transcripts may hold secrets: what is deleted is overwritten, not left in free pages.
    this.database.exec("PRAGMA secure_delete = ON")
    this.queries = this.database.createTagStore(64)
  }

  projects(): Project[] {
    return this.queries.all`SELECT id, name, cwd FROM projects ORDER BY position` as Project[]
  }

  /** Creates a project in an existing directory; a taken `id` is a `CONFLICT`. */
  async createProject(input: Project): Promise<Project> {
    if (!isAbsolute(input.cwd)) {
      throw new DomainError("INVALID_DIRECTORY", "Project directories must be absolute")
    }
    let cwd: string
    try {
      cwd = await realpath(input.cwd)
      if (!(await stat(cwd)).isDirectory()) throw new Error("Not a directory")
    } catch {
      throw new DomainError("INVALID_DIRECTORY", "Project directory does not exist")
    }
    const project = { id: input.id, name: input.name, cwd }
    if (this.queries.get`SELECT 1 FROM projects WHERE id = ${project.id}`) {
      throw new DomainError("CONFLICT", "Project id is already taken")
    }
    void this.queries
      .run`INSERT INTO projects (id, name, cwd) VALUES (${project.id}, ${project.name}, ${project.cwd})`
    return project
  }

  renameProject(input: { projectId: string; name: string }): Project {
    this.project(input.projectId)
    void this.queries.run`UPDATE projects SET name = ${input.name} WHERE id = ${input.projectId}`
    return this.project(input.projectId)
  }

  /**
   * Deletes the project, its sessions, what they kept of their terminals and their
   * numbering, and its agents' messages and threads, all at once; an unknown project is
   * `NOT_FOUND`. Its terminals' shells are the caller's to end first.
   */
  removeProject(projectId: string): void {
    this.project(projectId)
    this.transaction(() => {
      const sessions = "SELECT id FROM sessions WHERE project_id = ?"
      // Its sessions' companion items and windows go with them, by their foreign keys.
      for (const sql of [
        "DELETE FROM messages WHERE project_id = ?",
        "DELETE FROM message_threads WHERE project_id = ?",
        `DELETE FROM terminals WHERE session_id IN (${sessions})`,
        `DELETE FROM terminal_numbers WHERE session_id IN (${sessions})`,
        "DELETE FROM sessions WHERE project_id = ?",
        "DELETE FROM projects WHERE id = ?",
      ])
        this.database.prepare(sql).run(projectId)
    })
  }

  project(projectId: string): Project {
    const project = this.queries.get`SELECT id, name, cwd FROM projects WHERE id = ${projectId}` as
      | Project
      | undefined
    if (!project) throw new DomainError("NOT_FOUND", "Project not found")
    return project
  }

  sessions(projectId: string): WorkspaceSession[] {
    this.project(projectId)
    return this.queries.all`
      SELECT id, project_id AS projectId, name, state FROM sessions
      WHERE project_id = ${projectId} ORDER BY position
    ` as WorkspaceSession[]
  }

  /** Creates a session in an existing project; a taken `id` is a `CONFLICT`. */
  createSession(input: { id: string; projectId: string; name: string }): WorkspaceSession {
    this.project(input.projectId)
    const session = { ...input, state: null }
    if (this.queries.get`SELECT 1 FROM sessions WHERE id = ${session.id}`) {
      throw new DomainError("CONFLICT", "Session id is already taken")
    }
    void this.queries
      .run`INSERT INTO sessions (id, project_id, name) VALUES (${session.id}, ${session.projectId}, ${session.name})`
    return session
  }

  renameSession(input: { sessionId: string; name: string }): WorkspaceSession {
    this.session(input.sessionId)
    void this.queries.run`UPDATE sessions SET name = ${input.name} WHERE id = ${input.sessionId}`
    return this.session(input.sessionId)
  }

  /** Replaces the session's client state without interpreting it. */
  saveSession(input: { sessionId: string; state: string }): void {
    this.session(input.sessionId)
    void this.queries.run`UPDATE sessions SET state = ${input.state} WHERE id = ${input.sessionId}`
  }

  session(sessionId: string): WorkspaceSession {
    const session = this.queries.get`
      SELECT id, project_id AS projectId, name, state FROM sessions WHERE id = ${sessionId}
    ` as WorkspaceSession | undefined
    if (!session) throw new DomainError("NOT_FOUND", "Session not found")
    return session
  }

  terminal(terminalId: string): SavedTerminal | undefined {
    const row = this.queries.get`
      SELECT id, session_id, cwd, agents, prompted_at, transcript, updated_at, handle,
        person_title, agent_title, agent_titled_by, summary, opened_by, led_by, command, last_program, work
      FROM terminals WHERE id = ${terminalId}
    ` as TerminalRow | undefined
    return row && { ...listed(row), transcript: row.transcript }
  }

  terminals(sessionId?: string): ListedTerminal[] {
    const rows = (
      sessionId === undefined
        ? this.queries.all`
          SELECT id, session_id, cwd, agents, prompted_at, updated_at, handle,
            person_title, agent_title, agent_titled_by, summary, opened_by, led_by,
            command, last_program, work
          FROM terminals ORDER BY CAST(substr(handle, 2) AS INTEGER), rowid`
        : this.queries.all`
          SELECT id, session_id, cwd, agents, prompted_at, updated_at, handle,
            person_title, agent_title, agent_titled_by, summary, opened_by, led_by,
            command, last_program, work
          FROM terminals WHERE session_id = ${sessionId}
          ORDER BY CAST(substr(handle, 2) AS INTEGER), rowid`
    ) as Omit<TerminalRow, "transcript">[]
    return rows.map(listed)
  }

  nextTerminalNumber(sessionId: string): number {
    const row = this.queries.get`
      INSERT INTO terminal_numbers (session_id, last) VALUES (${sessionId}, 1)
      ON CONFLICT (session_id) DO UPDATE SET last = last + 1
      RETURNING last
    ` as { last: number }
    return row.last
  }

  renameTerminal(terminalId: string, title: string | null): boolean {
    const result = this.queries
      .run`UPDATE terminals SET person_title = ${title} WHERE id = ${terminalId}`
    return result.changes > 0
  }

  terminalIdentity(terminalId: string): TerminalIdentity | undefined {
    const row = this.queries.get`
      SELECT handle, person_title, agent_title, agent_titled_by, summary, opened_by, led_by
      FROM terminals WHERE id = ${terminalId}
    ` as (NamingRow & Pick<TerminalRow, "handle" | "opened_by" | "led_by">) | undefined
    return (
      row && {
        handle: row.handle,
        naming: namingOf(row),
        openedBy: row.opened_by,
        ledBy: row.led_by,
      }
    )
  }

  /** Saves what restores the terminal; `transcript` is left as it is when omitted. */
  saveTerminal(terminal: TerminalToSave): void {
    const agents = JSON.stringify(terminal.agents)
    // Strictly increasing, so saves in the same millisecond still sort by recency.
    const now = Math.max(Date.now(), this.lastSave + 0.001)
    this.lastSave = now
    const { handle, naming, openedBy, ledBy, command, lastProgram } = terminal
    const { person, summary } = naming
    const agentTitle = naming.agent?.title ?? null
    const agentBy = naming.agent?.by ?? null
    const work = terminal.work === null ? null : JSON.stringify(terminal.work)
    if (terminal.transcript === undefined)
      void this.queries.run`
        INSERT INTO terminals (id, session_id, cwd, agents, prompted_at, updated_at, handle,
          person_title, agent_title, agent_titled_by, summary, opened_by, led_by,
          command, last_program, work)
        VALUES (${terminal.id}, ${terminal.sessionId}, ${terminal.cwd}, ${agents},
          ${terminal.promptedAt}, ${now}, ${handle}, ${person}, ${agentTitle}, ${agentBy},
          ${summary}, ${openedBy}, ${ledBy}, ${command}, ${lastProgram}, ${work})
        ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd,
          agents = excluded.agents, prompted_at = excluded.prompted_at,
          updated_at = excluded.updated_at, handle = excluded.handle,
          person_title = excluded.person_title, agent_title = excluded.agent_title,
          agent_titled_by = excluded.agent_titled_by, summary = excluded.summary,
          opened_by = excluded.opened_by, led_by = excluded.led_by, command = excluded.command,
          last_program = excluded.last_program, work = excluded.work
      `
    else
      void this.queries.run`
        INSERT INTO terminals (id, session_id, cwd, agents, prompted_at, transcript, updated_at,
          handle, person_title, agent_title, agent_titled_by, summary, opened_by, led_by,
          command, last_program, work)
        VALUES (${terminal.id}, ${terminal.sessionId}, ${terminal.cwd}, ${agents},
          ${terminal.promptedAt}, ${terminal.transcript}, ${now}, ${handle}, ${person},
          ${agentTitle}, ${agentBy}, ${summary}, ${openedBy}, ${ledBy}, ${command},
          ${lastProgram}, ${work})
        ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd,
          agents = excluded.agents, prompted_at = excluded.prompted_at,
          transcript = excluded.transcript, updated_at = excluded.updated_at,
          handle = excluded.handle, person_title = excluded.person_title,
          agent_title = excluded.agent_title, agent_titled_by = excluded.agent_titled_by,
          summary = excluded.summary, opened_by = excluded.opened_by, led_by = excluded.led_by,
          command = excluded.command, last_program = excluded.last_program,
          work = excluded.work
      `
  }

  removeTerminal(terminalId: string): void {
    void this.queries.run`DELETE FROM terminals WHERE id = ${terminalId}`
  }

  forgetAgent(agent: AgentName): void {
    const rows = this.queries.all`SELECT id, agents FROM terminals` as Pick<
      TerminalRow,
      "id" | "agents"
    >[]
    for (const row of rows) {
      const { [agent]: forgotten, ...rest } = agentsOf(row.agents)
      if (forgotten)
        void this.queries
          .run`UPDATE terminals SET agents = ${JSON.stringify(rest)} WHERE id = ${row.id}`
    }
  }

  clearTranscripts(): void {
    void this.queries.run`UPDATE terminals SET transcript = NULL`
  }

  messages(): Message[] {
    return (this.queries.all`SELECT * FROM messages ORDER BY sent_at` as MessageRow[]).map(
      messageOf,
    )
  }

  saveMessage(message: Message): void {
    const { from, to } = message
    void this.queries.run`
      INSERT INTO messages (id, project_id, thread_id, hop, from_terminal, from_handle, from_agent,
        from_session, to_terminal, to_handle, to_agent, to_session, text, sent_at, state,
        delivered_at, notified, from_lead, to_lead)
      VALUES (${message.id}, ${message.projectId}, ${message.thread}, ${message.hop},
        ${from.terminalId}, ${from.handle}, ${from.agent}, ${from.sessionId}, ${to.terminalId},
        ${to.handle}, ${to.agent}, ${to.sessionId}, ${message.text}, ${message.sentAt},
        ${message.state}, ${message.deliveredAt}, ${message.notified ? 1 : 0},
        ${message.fromLead ? 1 : 0}, ${message.toLead ? 1 : 0})
      ON CONFLICT (id) DO UPDATE SET to_session = excluded.to_session, state = excluded.state,
        delivered_at = excluded.delivered_at, notified = excluded.notified
    `
  }

  removeMessages(ids: readonly string[]): void {
    for (const id of ids) void this.queries.run`DELETE FROM messages WHERE id = ${id}`
  }

  threads(): Thread[] {
    return (this.queries.all`SELECT * FROM message_threads` as ThreadRow[]).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      between: [row.first_terminal, row.second_terminal],
      hops: row.hops,
      allowed: row.allowed,
      lastAt: row.last_at,
    }))
  }

  saveThread(thread: Thread): void {
    const [first, second] = thread.between
    void this.queries.run`
      INSERT INTO message_threads (id, project_id, first_terminal, second_terminal, hops, allowed, last_at)
      VALUES (${thread.id}, ${thread.projectId}, ${first}, ${second}, ${thread.hops},
        ${thread.allowed}, ${thread.lastAt})
      ON CONFLICT (id) DO UPDATE SET hops = excluded.hops, allowed = excluded.allowed,
        last_at = excluded.last_at
    `
  }

  removeThreads(ids: readonly string[]): void {
    for (const id of ids) void this.queries.run`DELETE FROM message_threads WHERE id = ${id}`
  }

  messagingPaused(): boolean {
    const row = this.queries.get`SELECT value FROM settings WHERE key = 'messagingPaused'` as
      | { value: string }
      | undefined
    return row?.value === "true"
  }

  pauseMessaging(paused: boolean): void {
    void this.queries.run`
      INSERT INTO settings (key, value) VALUES ('messagingPaused', ${String(paused)})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `
  }

  settings(): RunnerSettings {
    const rows = this.queries.all`SELECT key, value FROM settings` as {
      key: string
      value: string
    }[]
    const saved = new Map(rows.map((row) => [row.key, row.value]))
    // Transcripts are kept unless turned off; the welcome dialog waits until seen.
    return {
      transcripts: saved.get("transcripts") !== "false",
      welcomed: saved.get("welcomed") === "true",
    }
  }

  saveSettings(settings: SettingsChange): void {
    for (const [key, value] of Object.entries(settings))
      if (value !== undefined)
        void this.queries.run`
        INSERT INTO settings (key, value) VALUES (${key}, ${String(value)})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `
  }

  /** Voice input's settings: off, on the lighter model, and detecting the language, until chosen. */
  voiceSettings(): VoiceSettings {
    const rows = this.queries.all`SELECT key, value FROM settings WHERE key LIKE 'voice.%'` as {
      key: string
      value: string
    }[]
    const saved = new Map(rows.map((row) => [row.key, row.value]))
    return {
      enabled: saved.get("voice.enabled") === "true",
      model: voiceModel.catch("turbo").parse(saved.get("voice.model")),
      language: voiceLanguage.catch("auto").parse(saved.get("voice.language")),
    }
  }

  /**
   * Whether the person chose voice input on or off: `undefined` until they, or an install,
   * did. A first install forgets an earlier off and turns it on; an off chosen during it,
   * or before a later model's install, survives.
   */
  voiceEnabledChoice(): boolean | undefined {
    const row = this.queries.get`SELECT value FROM settings WHERE key = 'voice.enabled'` as
      | { value: string }
      | undefined
    return row === undefined ? undefined : row.value === "true"
  }

  /** The check the last install passed, as saved; `null` when there is none or it can't be read. */
  voiceCheck(): VoiceCheck | null {
    const row = this.queries.get`SELECT value FROM settings WHERE key = 'voice.check'` as
      | { value: string }
      | undefined
    if (row === undefined) return null
    try {
      const parsed = voiceCheck.safeParse(JSON.parse(row.value))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** Replaces the saved check; `null` forgets it, as when voice input is removed. */
  saveVoiceCheck(check: VoiceCheck | null): void {
    if (check === null) void this.queries.run`DELETE FROM settings WHERE key = 'voice.check'`
    else
      void this.queries.run`
        INSERT INTO settings (key, value) VALUES ('voice.check', ${JSON.stringify(check)})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `
  }

  /** Saves what is given; `enabled: null` forgets the choice. */
  saveVoiceSettings(settings: VoiceSettingsChange): void {
    for (const [key, value] of Object.entries(settings)) {
      if (value === null) void this.queries.run`DELETE FROM settings WHERE key = ${`voice.${key}`}`
      else if (value !== undefined)
        void this.queries.run`
        INSERT INTO settings (key, value) VALUES (${`voice.${key}`}, ${String(value)})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `
    }
  }

  item(itemId: string): ItemRecord | undefined {
    const row = this.queries.get`SELECT * FROM companion_items WHERE id = ${itemId}` as
      | ItemRow
      | undefined
    return row && itemOf(row)
  }

  items(sessionId?: string): ItemRecord[] {
    const rows =
      sessionId === undefined
        ? this.queries.all`SELECT * FROM companion_items ORDER BY shown_at, rowid`
        : this.queries.all`
          SELECT * FROM companion_items WHERE session_id = ${sessionId} ORDER BY shown_at, rowid`
    return (rows as ItemRow[]).map(itemOf)
  }

  barItems(terminalId: string): ItemRecord[] {
    const rows = this.queries.all`
      SELECT * FROM companion_items WHERE terminal_id = ${terminalId} ORDER BY shown_at, rowid`
    return (rows as ItemRow[]).map(itemOf)
  }

  itemsAt(sessionId: string, pointerKey: string): ItemRecord[] {
    const rows = this.queries.all`
      SELECT * FROM companion_items WHERE session_id = ${sessionId} AND pointer_key = ${pointerKey}
      ORDER BY shown_at, rowid`
    return (rows as ItemRow[]).map(itemOf)
  }

  window(windowId: string): WindowRecord | undefined {
    const row = this.queries.get`
      SELECT w.id, w.session_id, w.person_title, i.id AS item_id, i.name AS item_name
      FROM companion_windows w JOIN companion_items i ON i.window_id = w.id
      WHERE w.id = ${windowId}
    ` as WindowRow | undefined
    return row && windowOf(row)
  }

  windows(sessionId?: string): WindowRecord[] {
    const rows =
      sessionId === undefined
        ? this.queries.all`
          SELECT w.id, w.session_id, w.person_title, i.id AS item_id, i.name AS item_name
          FROM companion_windows w JOIN companion_items i ON i.window_id = w.id
          ORDER BY w.created_at, w.rowid`
        : this.queries.all`
          SELECT w.id, w.session_id, w.person_title, i.id AS item_id, i.name AS item_name
          FROM companion_windows w JOIN companion_items i ON i.window_id = w.id
          WHERE w.session_id = ${sessionId} ORDER BY w.created_at, w.rowid`
    return (rows as WindowRow[]).map(windowOf)
  }

  /** Adds or changes an item; TERMINAL_NOT_FOUND when its terminal or session is gone. */
  saveItem(item: ItemRecord): void {
    const { plan, lines, from } = item
    referencing(
      "TERMINAL_NOT_FOUND",
      () => this.queries.run`
      INSERT INTO companion_items (id, session_id, terminal_id, window_id, pointer_key, kind, path,
        url, lines_from, lines_to, plan_agent, plan_session, plan_actor, plan_format, name,
        detail, held, shown_by, from_terminal, from_handle, version, asked, shown_at,
        observed_at)
      VALUES (${item.id}, ${item.sessionId}, ${item.terminalId}, ${item.windowId},
        ${item.pointerKey}, ${item.kind}, ${item.path}, ${item.url}, ${lines?.from ?? null},
        ${lines?.to ?? null}, ${plan?.agent ?? null}, ${plan?.session ?? null},
        ${plan ? (plan.actor ?? "") : null}, ${plan?.format ?? null}, ${item.name},
        ${item.detail}, ${item.held ? 1 : 0}, ${item.by}, ${from.terminalId}, ${from.handle},
        ${item.version}, ${item.asked ? 1 : 0}, ${item.shownAt}, ${item.observedAt})
      ON CONFLICT (id) DO UPDATE SET terminal_id = excluded.terminal_id,
        window_id = excluded.window_id, pointer_key = excluded.pointer_key, kind = excluded.kind,
        path = excluded.path, url = excluded.url, lines_from = excluded.lines_from,
        lines_to = excluded.lines_to, plan_agent = excluded.plan_agent,
        plan_session = excluded.plan_session, plan_actor = excluded.plan_actor,
        plan_format = excluded.plan_format, name = excluded.name, detail = excluded.detail,
        held = excluded.held, shown_by = excluded.shown_by,
        from_terminal = excluded.from_terminal, from_handle = excluded.from_handle,
        version = excluded.version, asked = excluded.asked, shown_at = excluded.shown_at,
        observed_at = excluded.observed_at
    `,
    )
  }

  /** TERMINAL_NOT_FOUND when the terminal is not kept. */
  dockItem(itemId: string, terminalId: string): Placed {
    return this.transaction(() => {
      const item = this.item(itemId)
      if (!item) throw new DomainError("NOT_FOUND", "Item not found")
      const left = item.windowId === null ? undefined : this.window(item.windowId)
      const row = this.queries.get`
        SELECT * FROM companion_items
        WHERE terminal_id = ${terminalId} AND pointer_key = ${item.pointerKey} AND id <> ${itemId}
      ` as ItemRow | undefined
      if (row) void this.queries.run`DELETE FROM companion_items WHERE id = ${row.id}`
      referencing(
        "TERMINAL_NOT_FOUND",
        () => this.queries.run`
          UPDATE companion_items SET terminal_id = ${terminalId}, window_id = NULL
          WHERE id = ${itemId}`,
      )
      if (left) void this.queries.run`DELETE FROM companion_windows WHERE id = ${left.id}`
      return { item: this.item(itemId)!, left, replaced: row && itemOf(row) }
    })
  }

  undockItem(itemId: string, window: { readonly id: string; readonly createdAt: number }): Placed {
    return this.transaction(() => {
      const item = this.item(itemId)
      if (!item) throw new DomainError("NOT_FOUND", "Item not found")
      if (this.queries.get`SELECT 1 FROM companion_windows WHERE id = ${window.id}`)
        throw new DomainError("CONFLICT", "Window id is already taken")
      const left = item.windowId === null ? undefined : this.window(item.windowId)
      // Its session gone, so is the item.
      referencing(
        "NOT_FOUND",
        () => this.queries.run`
          INSERT INTO companion_windows (id, session_id, created_at)
          VALUES (${window.id}, ${item.sessionId}, ${window.createdAt})`,
      )
      void this.queries.run`
        UPDATE companion_items SET terminal_id = NULL, window_id = ${window.id} WHERE id = ${itemId}`
      if (left) void this.queries.run`DELETE FROM companion_windows WHERE id = ${left.id}`
      return { item: this.item(itemId)!, left, replaced: undefined }
    })
  }

  removeItem(itemId: string): { item: ItemRecord; window: WindowRecord | undefined } | undefined {
    return this.transaction(() => {
      const item = this.item(itemId)
      if (!item) return undefined
      const window = item.windowId === null ? undefined : this.window(item.windowId)
      // A window goes with its item, which its own deletion takes along.
      if (window) void this.queries.run`DELETE FROM companion_windows WHERE id = ${window.id}`
      else void this.queries.run`DELETE FROM companion_items WHERE id = ${itemId}`
      return { item, window }
    })
  }

  renameWindow(windowId: string, title: string | null): boolean {
    const result = this.queries
      .run`UPDATE companion_windows SET person_title = ${title} WHERE id = ${windowId}`
    return result.changes > 0
  }

  /** Runs `work` as one transaction, undone whole when it throws. */
  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const result = work()
      this.database.exec("COMMIT")
      return result
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  close(): void {
    if (this.database.isOpen) {
      this.queries.clear()
      this.database.close()
    }
  }
}
