import { chmodSync, closeSync, mkdirSync, openSync, statSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import { DatabaseSync, type SQLTagStore } from "node:sqlite"

import type { AgentName, Project, RunnerSettings, WorkspaceSession } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import type { SavedTerminal, TerminalRecords } from "../terminals/records.js"

/** Settings to change; those left out, or undefined, stay as they are. */
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
  -- What restores a terminal after its shell is gone: kept as it changes, so a runner
  -- that is killed still leaves it behind.
  CREATE TABLE IF NOT EXISTS terminals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    -- The shell's last reported directory.
    cwd TEXT NOT NULL,
    -- The latest session each agent reported, as JSON: { "claude": { sessionId, seq } }.
    agents TEXT NOT NULL,
    -- When the shell last showed its prompt, in epoch milliseconds.
    prompted_at REAL,
    -- The screen and scrollback, serialized; null when not kept.
    transcript TEXT,
    updated_at REAL NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
`
// Records of terminals that are gone, kept for restoring; the oldest beyond this go.
const keptTerminals = 128

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

/** Creates the schema in a new database and refuses one written by a newer runner. */
const prepareSchema = (database: DatabaseSync): void => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const version = database.prepare("PRAGMA user_version").get()?.user_version
    if (typeof version !== "number" || version > schemaVersion) {
      throw new Error("The workspace database schema is newer than this runner supports")
    }
    if (version === 0) database.exec(`${schema} PRAGMA user_version = ${schemaVersion};`)
    database.exec(extras)
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
}

const agentsOf = (text: string): SavedTerminal["agents"] => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null ? (value as SavedTerminal["agents"]) : {}
  } catch {
    return {}
  }
}

export class WorkspaceStore implements TerminalRecords {
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
      prepareSchema(this.database)
    } catch (error) {
      this.database.close()
      throw error
    }
    // Transcripts may hold secrets: what is deleted is overwritten, not left in free pages.
    this.database.exec("PRAGMA secure_delete = ON")
    this.queries = this.database.createTagStore(16)
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
      SELECT id, session_id, cwd, agents, prompted_at, transcript, updated_at FROM terminals
      WHERE id = ${terminalId}
    ` as TerminalRow | undefined
    if (!row) return undefined
    return {
      id: row.id,
      sessionId: row.session_id,
      cwd: row.cwd,
      agents: agentsOf(row.agents),
      promptedAt: row.prompted_at,
      transcript: row.transcript,
      savedAt: row.updated_at,
    }
  }

  /** Saves what restores the terminal; `transcript` is left as it is when omitted. */
  saveTerminal(
    terminal: Omit<SavedTerminal, "transcript" | "savedAt"> & { transcript?: string | null },
  ): void {
    const agents = JSON.stringify(terminal.agents)
    // Strictly increasing, so saves in the same millisecond still sort by recency.
    const now = Math.max(Date.now(), this.lastSave + 0.001)
    this.lastSave = now
    if (terminal.transcript === undefined)
      void this.queries.run`
        INSERT INTO terminals (id, session_id, cwd, agents, prompted_at, updated_at)
        VALUES (${terminal.id}, ${terminal.sessionId}, ${terminal.cwd}, ${agents},
          ${terminal.promptedAt}, ${now})
        ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd,
          agents = excluded.agents, prompted_at = excluded.prompted_at,
          updated_at = excluded.updated_at
      `
    else
      void this.queries.run`
        INSERT INTO terminals (id, session_id, cwd, agents, prompted_at, transcript, updated_at)
        VALUES (${terminal.id}, ${terminal.sessionId}, ${terminal.cwd}, ${agents},
          ${terminal.promptedAt}, ${terminal.transcript}, ${now})
        ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd,
          agents = excluded.agents, prompted_at = excluded.prompted_at,
          transcript = excluded.transcript, updated_at = excluded.updated_at
      `
    void this.queries.run`
      DELETE FROM terminals WHERE id NOT IN (
        SELECT id FROM terminals ORDER BY updated_at DESC LIMIT ${keptTerminals}
      )
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

  settings(): RunnerSettings {
    const rows = this.queries.all`SELECT key, value FROM settings` as {
      key: string
      value: string
    }[]
    const saved = new Map(rows.map((row) => [row.key, row.value]))
    // Transcripts are kept unless turned off; onboarding waits until seen.
    return {
      transcripts: saved.get("transcripts") !== "false",
      onboarded: saved.get("onboarded") === "true",
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

  close(): void {
    if (this.database.isOpen) {
      this.queries.clear()
      this.database.close()
    }
  }
}
