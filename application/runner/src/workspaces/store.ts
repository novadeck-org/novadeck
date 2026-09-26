import { randomUUID } from "node:crypto"
import { chmodSync, closeSync, mkdirSync, openSync, statSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import { DatabaseSync, type SQLTagStore } from "node:sqlite"

import type { Project, WorkspaceSession } from "@novadeck/protocol"

import { DomainError } from "../errors.js"

const schemaVersion = 1

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

const migrate = (database: DatabaseSync): void => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const version = database.prepare("PRAGMA user_version").get()?.user_version
    if (typeof version !== "number" || version > schemaVersion) {
      throw new Error("The workspace database schema is newer than this runner supports")
    }
    if (version === 0) {
      database.exec(`
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
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200)
        ) STRICT;
        CREATE INDEX sessions_project ON sessions(project_id, position);
        PRAGMA user_version = 1;
      `)
    }
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

export class WorkspaceStore {
  private readonly database: DatabaseSync
  private readonly queries: SQLTagStore

  constructor(path = ":memory:") {
    if (path !== ":memory:") prepareFile(path)
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    })
    try {
      migrate(this.database)
    } catch (error) {
      this.database.close()
      throw error
    }
    this.queries = this.database.createTagStore(16)
  }

  projects(): Project[] {
    return this.queries.all`SELECT id, name, cwd FROM projects ORDER BY position` as Project[]
  }

  async createProject(input: { name: string; cwd: string }): Promise<Project> {
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
    const project = { id: randomUUID(), name: input.name, cwd }
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
      SELECT id, project_id AS projectId, name FROM sessions
      WHERE project_id = ${projectId} ORDER BY position
    ` as WorkspaceSession[]
  }

  createSession(input: { projectId: string; name: string }): WorkspaceSession {
    this.project(input.projectId)
    const session = { id: randomUUID(), projectId: input.projectId, name: input.name }
    void this.queries
      .run`INSERT INTO sessions (id, project_id, name) VALUES (${session.id}, ${session.projectId}, ${session.name})`
    return session
  }

  renameSession(input: { sessionId: string; name: string }): WorkspaceSession {
    this.session(input.sessionId)
    void this.queries.run`UPDATE sessions SET name = ${input.name} WHERE id = ${input.sessionId}`
    return this.session(input.sessionId)
  }

  session(sessionId: string): WorkspaceSession {
    const session = this.queries.get`
      SELECT id, project_id AS projectId, name FROM sessions WHERE id = ${sessionId}
    ` as WorkspaceSession | undefined
    if (!session) throw new DomainError("NOT_FOUND", "Session not found")
    return session
  }

  close(): void {
    if (this.database.isOpen) {
      this.queries.clear()
      this.database.close()
    }
  }
}
