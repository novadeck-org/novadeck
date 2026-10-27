import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { vi } from "vitest"

import type { ItemRecord } from "../companions/records.js"
import { DomainError } from "../errors.js"
import { novadeckSender, personSender, type Message, type Thread } from "../messaging/messages.js"
import { handleOrder, handleWords } from "../terminals/handles.js"
import { sealedShape } from "../terminals/sealing.js"
import { describe, expect, it as base } from "../test.js"
import { sealed as sealedText } from "../testing/sealing.js"
import {
  EarlierWorkspaceError,
  setAsideWorkspace,
  WorkspaceStore,
  WorkspaceTooNewError,
} from "./store.js"

const it = base.extend<{
  directory: () => string
  store: (path?: string) => WorkspaceStore
  kept: (path?: string) => WorkspaceStore
}>({
  directory: async ({ resources }, use) => {
    await use(() => {
      const path = mkdtempSync(join(tmpdir(), "novadeck-workspaces-"))
      resources.defer(() => rmSync(path, { recursive: true, force: true }))
      return path
    })
  },
  store: async ({ resources }, use) => {
    await use((path) => {
      const workspace = new WorkspaceStore(path)
      resources.defer(() => workspace.close())
      return workspace
    })
  },
  // A store with the parents the rows below are written under: project p, and the sessions
  // s, session, other, elsewhere, odd and even (a row's project or session must exist).
  kept: async ({ resources }, use) => {
    await use((path) => {
      const workspace = new WorkspaceStore(path)
      resources.defer(() => workspace.close())
      const database = workspace["database"]
      database.exec("INSERT OR IGNORE INTO projects (id, name, cwd) VALUES ('p', 'Shop', '/shop')")
      for (const id of ["s", "session", "other", "elsewhere", "odd", "even"])
        database.exec(
          `INSERT OR IGNORE INTO sessions (id, project_id, name) VALUES ('${id}', 'p', 'Session')`,
        )
      return workspace
    })
  },
})

// Whether a file holds `text`, as a secret it should have forgotten.
const holds = (file: string, text: string) => existsSync(file) && readFileSync(file).includes(text)

// The workspace schema at version 6, as a long-lived database may hold it: its terminals'
// and messages have their columns in another order than a new one's, which a step that
// copied by position would carry wrongly.
const version6 = () => {
  const sql = readFileSync(new URL("schemas/6.sql", import.meta.url), "utf8")
  const reordered = sql
    .replace(
      "    handle TEXT NOT NULL,\n    -- The shell's last reported directory.\n    cwd TEXT NOT NULL,",
      "    cwd TEXT NOT NULL,\n    -- The shell's last reported directory.\n    handle TEXT NOT NULL,",
    )
    .replace(
      "    thread_id TEXT NOT NULL,\n    hop INTEGER NOT NULL,",
      "    hop INTEGER NOT NULL,\n    thread_id TEXT NOT NULL,",
    )
  expect(reordered.length).toBe(sql.length)
  expect(reordered).not.toBe(sql)
  return reordered
}

// Something in every table of a version 6 database, as that version's runner wrote it, and
// what the foreign keys of version 7 leave behind: rows without a parent, which version 6
// let a row have in every table but the items'. Rows get their rowids to show they are kept.
const heldByVersion6 = `
  INSERT INTO projects (rowid, id, name, cwd) VALUES (1, 'p', 'Shop', '/shop'),
    (4, 'q', 'Other', '/other');
  INSERT INTO sessions (position, id, project_id, name, state) VALUES
    (1, 's', 'p', 'Main', '{"version":1,"visitedAt":1000,"rank":0,"layout":{"a":1}}'),
    (2, 'tied', 'p', 'Tied', '{"version":1,"visitedAt":1000,"rank":1}'),
    (3, 'real', 'p', 'Real', '{"version":1,"visitedAt":1500.5,"rank":2}'),
    (5, 'notjson', 'p', 'Not JSON', 'not json'),
    (6, 'text', 'p', 'Text time', '{"version":1,"visitedAt":"1000","rank":0}'),
    (7, 'fresh', 'p', 'Fresh', NULL),
    (8, 'v2', 'q', 'Version 2', '{"version":2,"layout":[]}'),
    (9, 'norank', 'q', 'No rank', '{"version":1,"visitedAt":5}'),
    (10, 'array', 'q', 'Array', '[1,2]'),
    (11, 'orphan', 'gone', 'Orphan', NULL);
  INSERT INTO terminals (rowid, id, session_id, handle, cwd, agents, prompted_at, transcript,
    updated_at, person_title, agent_title, agent_titled_by, murmur_title, summary, opened_by,
    led_by, command, last_program, work) VALUES
    (5, 't', 's', 'moth', '/shop', '{"claude":{"sessionId":"cs","seq":1}}', 2, 'screen', 3,
      'Mine', 'Login', 'fox', 'Fixing login', 'Works on checkout', 'fox', 'fox', 'claude',
      'claude', '{"session":"claude:cs"}'),
    (7, 'u', 's', 'fox', '/shop', '{}', NULL, NULL, 4, NULL, 'Old', 'moth', NULL, NULL, NULL,
      NULL, NULL, NULL, NULL),
    (9, 'v', 'tied', 'owl', '/shop', '{}', NULL, NULL, 5, NULL, 'Other', 'owl', NULL, NULL,
      'fox', NULL, NULL, NULL, NULL),
    (11, 'x', 'gone', 'elk', '/shop', '{}', NULL, NULL, 6, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL);
  INSERT INTO session_handles (rowid, session_id, handle) VALUES (3, 's', 'moth'),
    (6, 's', 'fox'), (8, 'gone', 'elk');
  INSERT INTO settings VALUES ('example', '1');
  INSERT INTO message_threads VALUES ('th', 'p', 't', 'u', 3, 2, 'loop', 10, NULL),
    ('thgone', 'gone', 't', 'u', 1, NULL, NULL, 10, NULL);
  INSERT INTO messages (id, project_id, thread_id, hop, from_terminal, from_handle, from_agent,
    from_session, to_terminal, to_handle, to_agent, to_session, text, sent_at, state,
    delivered_at, notified, stopped, from_lead, to_lead, response) VALUES
    ('m', 'p', 'th', 1, 't', 'moth', 'claude', 'cs', 'u', 'fox', 'codex', NULL, 'hello', 3,
      'delivered', 4, 1, 0, 0, 1, NULL),
    ('orphan-thread', 'p', 'nope', 1, 't', 'moth', NULL, NULL, 'u', 'fox', 'codex', NULL, 'x', 3,
      'queued', NULL, 0, 0, 0, 0, NULL),
    ('cross', 'q', 'th', 1, 't', 'moth', NULL, NULL, 'u', 'fox', 'codex', NULL, 'x', 3,
      'queued', NULL, 0, 0, 0, 0, NULL),
    ('answer', 'p', 't-a1b2', 2, 'you', 'you', NULL, NULL, 't', 'moth', 'claude', 'cs', 'Yes', 6,
      'queued', NULL, 1, 0, 0, 0, '{"askId":"a1-b2","subject":"Go?"}'),
    ('noask', 'p', 't-x', 2, 'you', 'you', NULL, NULL, 't', 'moth', 'claude', 'cs', 'No', 6,
      'queued', NULL, 1, 0, 0, 0, '{"subject":"Go?"}'),
    ('badjson', 'p', 't-y', 2, 'you', 'you', NULL, NULL, 't', 'moth', 'claude', 'cs', 'No', 6,
      'queued', NULL, 1, 0, 0, 0, 'not json'),
    ('numask', 'p', 't-z', 2, 'you', 'you', NULL, NULL, 't', 'moth', 'claude', 'cs', 'No', 6,
      'queued', NULL, 1, 0, 0, 0, '{"askId":5}'),
    ('noresponse', 'p', 't-w', 2, 'you', 'you', NULL, NULL, 't', 'moth', 'claude', 'cs', 'No', 6,
      'queued', NULL, 1, 0, 0, 0, NULL),
    ('notice', 'p', 't-notice-notice', 1, 'novadeck', 'novadeck', NULL, NULL, 't', 'moth',
      'claude', NULL, 'Note', 7, 'held', NULL, 1, 0, 0, 0, NULL),
    ('gone-notice', 'gone', 't-notice-gone-notice', 1, 'novadeck', 'novadeck', NULL, NULL, 't',
      'moth', 'claude', NULL, 'Note', 7, 'held', NULL, 1, 0, 0, 0, NULL),
    ('gone-answer', 'gone', 't-v', 2, 'you', 'you', NULL, NULL, 't', 'moth', 'claude', 'cs',
      'Yes', 6, 'queued', NULL, 1, 0, 0, 0, '{"askId":"v"}');
  INSERT INTO inbox VALUES ('a', 'p', 't', 5, '{}'), ('b', 'gone', 't', 6, '{}');
  INSERT INTO companion_windows (rowid, id, session_id, home, person_title, created_at) VALUES
    (1, 'w', 's', 'undocked', 'Mine', 6), (2, 'empty', 'tied', 'undocked', NULL, 6),
    (3, 'pw', 's', 'project', NULL, 7), (4, 'gw', 'gone', 'undocked', NULL, 7),
    (5, 'ow', 'tied', 'undocked', NULL, 7);
  INSERT INTO companion_items (rowid, id, session_id, terminal_id, window_id, pointer_key, kind,
    path, url, lines_from, lines_to, plan_agent, plan_session, plan_actor, plan_format, name,
    detail, held, shown_by, from_terminal, from_handle, version, asked, shown_at, observed_at)
  VALUES
    (2, 'bar', 's', 't', NULL, '/shop/a.ts', 'file', '/shop/a.ts', NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, 'a.ts', '', 1, 'agent', 't', 'moth', 1, 0, 7, NULL),
    (3, 'undocked', 's', NULL, 'w', 'page:http://localhost/', 'page', NULL, 'http://localhost/',
      NULL, NULL, NULL, NULL, NULL, NULL, 'localhost', '', 0, 'person', 't', 'moth', 2, 1, 8,
      NULL),
    (4, 'plan', 's', 't', NULL, 'plan:claude:cs:', 'plan', '/shop/plan.jsonl', 'http://unused/',
      1, 2, 'claude', 'cs', '', 'text', 'Plan', 'Moth', 1, 'agent', 't', 'moth', 3, 1, 9, 9.25),
    (6, 'project', 's', NULL, 'pw', '/shop/b.ts', 'file', '/shop/b.ts', NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, 'b.ts', '', 0, 'person', NULL, NULL, 1, 0, 11, NULL),
    (7, 'of-gone-terminal', 's', 'x', NULL, '/shop/c.ts', 'file', '/shop/c.ts', NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, 'c.ts', '', 0, 'agent', 't', 'moth', 1, 0, 12, NULL),
    (8, 'of-gone-session', 'gone', NULL, 'gw', '/shop/d.ts', 'file', '/shop/d.ts', NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, 'd.ts', '', 0, 'person', NULL, NULL, 1, 0, 13, NULL),
    (9, 'of-other-session', 'tied', 't', NULL, '/shop/e.ts', 'file', '/shop/e.ts', NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, 'e.ts', '', 0, 'agent', 't', 'moth', 1, 0, 14, NULL),
    (10, 'of-other-window', 's', NULL, 'ow', '/shop/f.ts', 'file', '/shop/f.ts', NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, 'f.ts', '', 0, 'person', NULL, NULL, 1, 0, 15, NULL);
`

// Every table and index, by its SQL without comments, and with white space as one, so what
// is the same but written apart compares equal.
const normalisedSchemaOf = (database: DatabaseSync) =>
  (
    database
      .prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name")
      .all() as { type: string; name: string; sql: string }[]
  ).map(({ type, name, sql }) => ({
    type,
    name,
    sql: sql
      .replace(/--[^\n]*/g, "")
      .replace(/\s+/g, " ")
      // ALTER TABLE ADD COLUMN leaves its column after a line break, as ` , rank INTEGER`.
      .replace(/ ,/g, ",")
      .replace(/\( /g, "(")
      .replace(/ \)/g, ")")
      .trim(),
  }))

// Every row of every table, each as JSON, sorted, so a table made again compares equal.
const rowsOf = (database: DatabaseSync) =>
  Object.fromEntries(
    (
      database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map(({ name }) => [
      name,
      database
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) => JSON.stringify(row))
        .toSorted(),
    ]),
  )

// Every table and index, by its SQL with runs of white space as one.
const schemaOf = (database: DatabaseSync) =>
  (
    database.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all() as {
      type: string
      name: string
      sql: string | null
    }[]
  ).map(({ type, name, sql }) => ({ type, name, sql: sql?.replace(/\s+/g, " ") ?? null }))

describe("workspace metadata", () => {
  it("persists project and session identities, renames, and order across database reopen", async ({
    directory,
    store,
  }) => {
    const cwd = directory()
    const path = join(cwd, "metadata", "workspace.sqlite")
    const original = store(path)
    const first = await original.createProject({ id: randomUUID(), name: "Zebra", cwd })
    const second = await original.createProject({ id: randomUUID(), name: "Alpha", cwd })
    const initial = original.createSession({ id: randomUUID(), projectId: first.id, name: "Zebra" })
    const next = original.createSession({ id: randomUUID(), projectId: first.id, name: "Alpha" })
    const other = original.createSession({
      id: randomUUID(),
      projectId: second.id,
      name: "Other project",
    })
    const renamed = original.renameProject({ projectId: first.id, name: "Renamed project" })
    const session = original.renameSession({ sessionId: initial.id, name: "Renamed session" })
    original.close()

    const reopened = store(path)
    expect(reopened.projects()).toEqual([renamed, second])
    expect(reopened.project(first.id)).toEqual(renamed)
    expect(reopened.sessions(first.id)).toEqual([session, next])
    expect(reopened.sessions(second.id)).toEqual([other])
    expect(reopened.session(initial.id)).toEqual(session)
    expect(new Set([first.id, second.id, initial.id, next.id, other.id]).size).toBe(5)
    expect(first.id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(8)
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
      expect(() =>
        database
          .prepare("INSERT INTO sessions (id, project_id, name) VALUES (?, ?, ?)")
          .run("orphan", "missing", "Orphan session"),
      ).toThrow(/FOREIGN KEY/)
    } finally {
      database.close()
    }
  })

  it("keeps the given ids and rejects taken ones as conflicts", async ({ directory, store }) => {
    const cwd = directory()
    const workspace = store()
    const projectId = randomUUID()
    const sessionId = randomUUID()
    const project = await workspace.createProject({
      id: projectId,
      name: "Chosen",
      cwd,
    })
    const session = workspace.createSession({
      id: sessionId,
      projectId,
      name: "Chosen",
    })
    expect(project.id).toBe(projectId)
    expect(session).toEqual({
      id: sessionId,
      projectId,
      name: "Chosen",
      state: null,
      visitedAt: null,
    })
    await expect(
      workspace.createProject({ id: projectId, name: "Again", cwd }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(() => workspace.createSession({ id: sessionId, projectId, name: "Again" })).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(workspace.projects()).toEqual([project])
    expect(workspace.sessions(projectId)).toEqual([session])
  })

  it("replaces a session's saved state and keeps it across reopen", async ({
    directory,
    store,
  }) => {
    const cwd = directory()
    const path = join(cwd, "workspace.sqlite")
    const original = store(path)
    const project = await original.createProject({ id: randomUUID(), name: "Project", cwd })
    const session = original.createSession({
      id: randomUUID(),
      projectId: project.id,
      name: "Session",
    })
    original.saveSession({ sessionId: session.id, state: '{"layout":1}', visitedAt: 10 })
    original.saveSession({ sessionId: session.id, state: '{"layout":2}', visitedAt: 20 })
    expect(() =>
      original.saveSession({ sessionId: randomUUID(), state: "{}", visitedAt: null }),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
    original.close()
    const reopened = store(path)
    const saved = { ...session, state: '{"layout":2}', visitedAt: 20 }
    expect(reopened.session(session.id)).toEqual(saved)
    expect(reopened.sessions(project.id)).toEqual([saved])
  })

  it("rejects missing projects and sessions without creating orphan records", ({ store }) => {
    const workspace = store()
    const operations = [
      () => workspace.project("missing"),
      () => workspace.sessions("missing"),
      () => workspace.createSession({ id: randomUUID(), projectId: "missing", name: "Orphan" }),
      () => workspace.renameProject({ projectId: "missing", name: "Renamed" }),
      () => workspace.session("missing"),
      () => workspace.renameSession({ sessionId: "missing", name: "Renamed" }),
      () => workspace.removeProject("missing"),
    ]
    for (const operation of operations) {
      expect(operation).toThrow(DomainError)
      expect(operation).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
    }
    expect(workspace.projects()).toEqual([])
  })

  it("removes a project with its sessions, kept terminals, given handles and messages", async ({
    directory,
    store,
  }) => {
    const cwd = directory()
    const workspace = store(join(cwd, "workspace.sqlite"))
    const removed = await workspace.createProject({ id: "p", name: "Removed", cwd })
    const kept = await workspace.createProject({ id: "q", name: "Kept", cwd })
    workspace.createSession({
      id: "s",
      projectId: removed.id,
      name: "Session",
    })
    const other = workspace.createSession({
      id: "o",
      projectId: kept.id,
      name: "Other",
    })
    workspace.saveTerminal(numbered("a", "moth"))
    workspace.saveTerminal({ ...numbered("b", "moth"), sessionId: other.id })
    const given = workspace.giveHandle("s")
    const otherGiven = workspace.giveHandle(other.id)
    const thread: Thread = {
      id: "t-1",
      projectId: removed.id,
      between: ["a", "b"],
      hops: 1,
      heldFrom: null,
      heldFor: null,
      lastAt: 1,
      stoppedAt: null,
    }
    workspace.saveThread(thread)
    workspace.saveThread({ ...thread, id: "t-2", projectId: kept.id })
    workspace.saveMessage(message("m-1", "queued"))
    workspace.saveMessage({ ...message("m-2", "queued"), projectId: kept.id, thread: "t-2" })
    // The person's and Novadeck's messages belong to their project, with no thread.
    const answer = (id: string, projectId: string): Message => ({
      ...message(id, "queued"),
      projectId,
      thread: `t-${id}`,
      from: personSender,
      response: { askId: id, subject: "Go?" },
    })
    workspace.saveMessage(answer("a-1", removed.id))
    workspace.saveMessage(answer("a-2", kept.id))
    const entry = (id: string, projectId: string) => ({
      id,
      terminalId: "a",
      projectId,
      workspaceSessionId: "s",
      agent: "claude" as const,
      sessionId: "cs",
      handle: "moth",
      at: 1,
      state: "open" as const,
      content: { kind: "tell" as const, subject: "Hi", body: "There" },
    })
    workspace.saveEntries([entry("e-1", removed.id), entry("e-2", kept.id)])
    const shown = item("s", "a", "/work/x")
    workspace.saveItem(shown)
    workspace.saveItem(item(other.id, "b", "/work/y"))
    workspace.addProjectItem(
      { id: "w-1", createdAt: 1 },
      { ...item("s", "a", "/p"), terminalId: null, windowId: "w-1", from: null },
    )

    workspace.removeProject(removed.id)
    expect(workspace.projects()).toEqual([kept])
    expect(() => workspace.session("s")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
    expect(workspace.terminals().map(({ id }) => id)).toEqual(["b"])
    expect(workspace.threads().map(({ id }) => id)).toEqual(["t-2"])
    expect(workspace.messages().map(({ id }) => id)).toEqual(["m-2", "a-2"])
    expect(workspace.entries().map(({ id }) => id)).toEqual(["e-2"])
    // Its items and windows went with its sessions.
    expect(workspace.items().map(({ sessionId }) => sessionId)).toEqual([other.id])
    expect(workspace.windows()).toEqual([])
    // A session of the same id gives its words afresh; the other goes on.
    workspace.createSession({ id: "s", projectId: kept.id, name: "Again" })
    expect(workspace.giveHandle("s")).toBe(given)
    expect(workspace.giveHandle(other.id)).not.toBe(otherGiven)
    expect(() => workspace.removeProject(removed.id)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
  })

  it("stores the canonical directory rather than a symbolic link", async ({ directory, store }) => {
    const cwd = directory()
    const target = join(cwd, "project")
    const link = join(cwd, "link")
    mkdirSync(target)
    symlinkSync(target, link, "junction")
    const project = await store().createProject({ id: randomUUID(), name: "Project", cwd: link })
    // Match native canonicalization, including expansion of Windows 8.3 paths.
    expect(project.cwd).toBe(realpathSync.native(target))
  })

  it("rejects relative paths, missing paths, and regular files", async ({ directory, store }) => {
    const cwd = directory()
    const file = join(cwd, "file.txt")
    writeFileSync(file, "not a directory")
    const workspace = store()
    await Promise.all(
      ["relative", join(cwd, "missing"), file].map((path) =>
        expect(
          workspace.createProject({ id: randomUUID(), name: "Invalid", cwd: path }),
        ).rejects.toMatchObject({
          code: "INVALID_DIRECTORY",
        }),
      ),
    )
    expect(workspace.projects()).toEqual([])
  })

  it("rejects empty and oversized names at the storage boundary", async ({ directory, store }) => {
    const cwd = directory()
    const workspace = store()
    const project = await workspace.createProject({ id: randomUUID(), name: "Project", cwd })
    const session = workspace.createSession({
      id: randomUUID(),
      projectId: project.id,
      name: "Session",
    })
    const names = ["", "x".repeat(201)]
    await Promise.all(
      names.map((name) =>
        expect(workspace.createProject({ id: randomUUID(), name, cwd })).rejects.toThrow(/CHECK/),
      ),
    )
    for (const name of names) {
      expect(() =>
        workspace.createSession({ id: randomUUID(), projectId: project.id, name }),
      ).toThrow(/CHECK/)
      expect(() => workspace.renameProject({ projectId: project.id, name })).toThrow(/CHECK/)
      expect(() => workspace.renameSession({ sessionId: session.id, name })).toThrow(/CHECK/)
    }
    expect(workspace.projects()).toEqual([project])
    expect(workspace.sessions(project.id)).toEqual([session])
  })

  it("rejects newer database schemas without changing their version or contents", ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const future = new DatabaseSync(path)
    future.exec(
      "CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('saved'); PRAGMA user_version = 9",
    )
    future.close()
    expect(() => new WorkspaceStore(path)).toThrow(/newer/)
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(9)
      expect(database.prepare("SELECT value FROM future_data").get()?.value).toBe("saved")
    } finally {
      database.close()
    }
  })

  it("counts a database with columns this runner doesn't know as a newer build's, and leaves it as it is", ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    new WorkspaceStore(path).close()
    const future = new DatabaseSync(path)
    future.exec("ALTER TABLE terminals ADD COLUMN future_note TEXT")
    future.close()
    expect(() => new WorkspaceStore(path)).toThrow(WorkspaceTooNewError)
    const database = new DatabaseSync(path)
    try {
      const columns = database.prepare("SELECT name FROM pragma_table_info('terminals')").all()
      expect(columns).toContainEqual({ name: "future_note" })
    } finally {
      database.close()
    }
  })

  it("counts a database as an earlier build's when any table lacks a column, though another has more", ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    new WorkspaceStore(path).close()
    const old = new DatabaseSync(path)
    old.exec(
      "ALTER TABLE terminals DROP COLUMN murmur_title; ALTER TABLE companion_items ADD COLUMN legacy TEXT",
    )
    old.close()
    expect(() => new WorkspaceStore(path)).toThrow(/earlier build: .*expects murmur_title TEXT/)
  })

  it("carries a version 6 database forward in place, keeping what it can and leaving the rest", ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const old = new DatabaseSync(path, { enableForeignKeyConstraints: false })
    old.exec(`${version6()}
      PRAGMA user_version = 6;
      ${heldByVersion6}`)
    const before = rowsOf(old)
    old.close()

    new WorkspaceStore(path).close()
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(8)
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
      // Every old table is gone, and so are the old names.
      expect(Object.keys(rowsOf(database)).toSorted()).toEqual(
        [
          "companion_items",
          "companion_windows",
          "inbox_entries",
          "message_threads",
          "messages",
          "projects",
          "session_handles",
          "sessions",
          "settings",
          "terminals",
        ].toSorted(),
      )
      const rows = (sql: string) =>
        database
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }))

      expect(rows("SELECT position, id, name, cwd FROM projects ORDER BY position")).toEqual([
        { position: 1, id: "p", name: "Shop", cwd: "/shop" },
        { position: 4, id: "q", name: "Other", cwd: "/other" },
      ])
      // The old projects' rows are all there, but for what had no parent.
      expect(before.projects).toHaveLength(2)

      // Sessions: v1 states give their visit and lose it, the rest stay as they are.
      expect(
        rows(
          "SELECT position, id, project_id, name, client_state, visited_at FROM sessions ORDER BY position",
        ),
      ).toEqual([
        {
          position: 1,
          id: "s",
          project_id: "p",
          name: "Main",
          client_state: '{"version":2,"layout":{"a":1}}',
          visited_at: 1000,
        },
        {
          position: 2,
          id: "tied",
          project_id: "p",
          name: "Tied",
          client_state: '{"version":2}',
          visited_at: 1000 + 0.001,
        },
        {
          position: 3,
          id: "real",
          project_id: "p",
          name: "Real",
          client_state: '{"version":2}',
          visited_at: 1500.5 + 0.002,
        },
        {
          position: 5,
          id: "notjson",
          project_id: "p",
          name: "Not JSON",
          client_state: "not json",
          visited_at: null,
        },
        {
          position: 6,
          id: "text",
          project_id: "p",
          name: "Text time",
          client_state: '{"version":1,"visitedAt":"1000","rank":0}',
          visited_at: null,
        },
        {
          position: 7,
          id: "fresh",
          project_id: "p",
          name: "Fresh",
          client_state: null,
          visited_at: null,
        },
        {
          position: 8,
          id: "v2",
          project_id: "q",
          name: "Version 2",
          client_state: '{"version":2,"layout":[]}',
          visited_at: null,
        },
        {
          position: 9,
          id: "norank",
          project_id: "q",
          name: "No rank",
          client_state: '{"version":1,"visitedAt":5}',
          visited_at: null,
        },
        {
          position: 10,
          id: "array",
          project_id: "q",
          name: "Array",
          client_state: "[1,2]",
          visited_at: null,
        },
      ])

      // Terminals keep their order, and a title only its opener gave stays opener's.
      expect(
        rows(
          `SELECT rowid, id, session_id, handle, cwd, agent_reports, prompted_at, transcript,
            saved_at, person_title, opener_title, murmur_title, summary, opened_by, led_by,
            command, last_program, work FROM terminals ORDER BY rowid`,
        ),
      ).toEqual([
        {
          rowid: 5,
          id: "t",
          session_id: "s",
          handle: "moth",
          cwd: "/shop",
          agent_reports: '{"claude":{"sessionId":"cs","seq":1}}',
          prompted_at: 2,
          transcript: "screen",
          saved_at: 3,
          person_title: "Mine",
          opener_title: "Login",
          murmur_title: "Fixing login",
          summary: "Works on checkout",
          opened_by: "fox",
          led_by: "fox",
          command: "claude",
          last_program: "claude",
          work: '{"session":"claude:cs"}',
        },
        {
          rowid: 7,
          id: "u",
          session_id: "s",
          handle: "fox",
          cwd: "/shop",
          agent_reports: "{}",
          prompted_at: null,
          transcript: null,
          saved_at: 4,
          person_title: null,
          opener_title: null,
          murmur_title: null,
          summary: null,
          opened_by: null,
          led_by: null,
          command: null,
          last_program: null,
          work: null,
        },
        {
          rowid: 9,
          id: "v",
          session_id: "tied",
          handle: "owl",
          cwd: "/shop",
          agent_reports: "{}",
          prompted_at: null,
          transcript: null,
          saved_at: 5,
          person_title: null,
          opener_title: null,
          murmur_title: null,
          summary: null,
          opened_by: "fox",
          led_by: null,
          command: null,
          last_program: null,
          work: null,
        },
      ])
      expect(rows("SELECT rowid, session_id, handle FROM session_handles ORDER BY rowid")).toEqual([
        { rowid: 3, session_id: "s", handle: "moth" },
        { rowid: 6, session_id: "s", handle: "fox" },
      ])
      expect(rows("SELECT key, value FROM settings")).toEqual([{ key: "example", value: "1" }])
      expect(
        rows(
          `SELECT id, project_id, first_terminal, second_terminal, hops, held_from, held_for,
            last_at, stopped_at FROM message_threads`,
        ),
      ).toEqual([
        {
          id: "th",
          project_id: "p",
          first_terminal: "t",
          second_terminal: "u",
          hops: 3,
          held_from: 2,
          held_for: "loop",
          last_at: 10,
          stopped_at: null,
        },
      ])

      // Messages: the person's and Novadeck's lose their fake terminal and thread; the
      // person's without the entry it answers, and an agent's without its thread, are left.
      expect(
        rows(
          `SELECT id, project_id, thread_id, hop, from_kind, from_terminal, from_handle,
            from_agent, from_agent_session, to_terminal, to_handle, to_agent, to_agent_session,
            text, sent_at, state, delivered_at, notified, stopped, from_lead, to_lead, response
          FROM messages ORDER BY rowid`,
        ),
      ).toEqual([
        {
          id: "m",
          project_id: "p",
          thread_id: "th",
          hop: 1,
          from_kind: "agent",
          from_terminal: "t",
          from_handle: "moth",
          from_agent: "claude",
          from_agent_session: "cs",
          to_terminal: "u",
          to_handle: "fox",
          to_agent: "codex",
          to_agent_session: null,
          text: "hello",
          sent_at: 3,
          state: "delivered",
          delivered_at: 4,
          notified: 1,
          stopped: 0,
          from_lead: 0,
          to_lead: 1,
          response: null,
        },
        {
          id: "answer",
          project_id: "p",
          thread_id: null,
          hop: 2,
          from_kind: "person",
          from_terminal: null,
          from_handle: null,
          from_agent: null,
          from_agent_session: null,
          to_terminal: "t",
          to_handle: "moth",
          to_agent: "claude",
          to_agent_session: "cs",
          text: "Yes",
          sent_at: 6,
          state: "queued",
          delivered_at: null,
          notified: 1,
          stopped: 0,
          from_lead: 0,
          to_lead: 0,
          response: '{"askId":"a1-b2","subject":"Go?"}',
        },
        {
          id: "notice",
          project_id: "p",
          thread_id: null,
          hop: 1,
          from_kind: "novadeck",
          from_terminal: null,
          from_handle: null,
          from_agent: null,
          from_agent_session: null,
          to_terminal: "t",
          to_handle: "moth",
          to_agent: "claude",
          to_agent_session: null,
          text: "Note",
          sent_at: 7,
          state: "held",
          delivered_at: null,
          notified: 1,
          stopped: 0,
          from_lead: 0,
          to_lead: 0,
          response: null,
        },
      ])
      expect(rows("SELECT id, project_id, terminal_id, at, record FROM inbox_entries")).toEqual([
        { id: "a", project_id: "p", terminal_id: "t", at: 5, record: "{}" },
      ])

      // Windows left with no item go, and items keep their holder, as the pair says.
      expect(
        rows(
          "SELECT rowid, id, session_id, home, person_title, created_at FROM companion_windows ORDER BY rowid",
        ),
      ).toEqual([
        {
          rowid: 1,
          id: "w",
          session_id: "s",
          home: "undocked",
          person_title: "Mine",
          created_at: 6,
        },
        { rowid: 3, id: "pw", session_id: "s", home: "project", person_title: null, created_at: 7 },
      ])
      expect(
        rows(
          `SELECT rowid, id, session_id, terminal_id, window_id, pointer_key, kind, path, url,
            lines_from, lines_to, plan_agent, plan_agent_session, plan_actor, plan_format, name,
            detail, secret, shown_by, from_terminal, from_handle, version, open_asked, shown_at,
            observed_at FROM companion_items ORDER BY rowid`,
        ),
      ).toEqual([
        {
          rowid: 2,
          id: "bar",
          session_id: "s",
          terminal_id: "t",
          window_id: null,
          pointer_key: "/shop/a.ts",
          kind: "file",
          path: "/shop/a.ts",
          url: null,
          lines_from: null,
          lines_to: null,
          plan_agent: null,
          plan_agent_session: null,
          plan_actor: null,
          plan_format: null,
          name: "a.ts",
          detail: "",
          secret: 1,
          shown_by: "agent",
          from_terminal: "t",
          from_handle: "moth",
          version: 1,
          open_asked: 0,
          shown_at: 7,
          observed_at: null,
        },
        {
          rowid: 3,
          id: "undocked",
          session_id: "s",
          terminal_id: null,
          window_id: "w",
          pointer_key: "page:http://localhost/",
          kind: "page",
          path: null,
          url: "http://localhost/",
          lines_from: null,
          lines_to: null,
          plan_agent: null,
          plan_agent_session: null,
          plan_actor: null,
          plan_format: null,
          name: "localhost",
          detail: "",
          secret: 0,
          shown_by: "person",
          from_terminal: "t",
          from_handle: "moth",
          version: 2,
          open_asked: 1,
          shown_at: 8,
          observed_at: null,
        },
        {
          rowid: 4,
          id: "plan",
          session_id: "s",
          terminal_id: "t",
          window_id: null,
          pointer_key: "plan:claude:cs:",
          kind: "plan",
          path: "/shop/plan.jsonl",
          url: "http://unused/",
          lines_from: 1,
          lines_to: 2,
          plan_agent: "claude",
          plan_agent_session: "cs",
          plan_actor: "",
          plan_format: "text",
          name: "Plan",
          detail: "Moth",
          secret: 1,
          shown_by: "agent",
          from_terminal: "t",
          from_handle: "moth",
          version: 3,
          open_asked: 1,
          shown_at: 9,
          observed_at: 9.25,
        },
        {
          rowid: 6,
          id: "project",
          session_id: "s",
          terminal_id: null,
          window_id: "pw",
          pointer_key: "/shop/b.ts",
          kind: "file",
          path: "/shop/b.ts",
          url: null,
          lines_from: null,
          lines_to: null,
          plan_agent: null,
          plan_agent_session: null,
          plan_actor: null,
          plan_format: null,
          name: "b.ts",
          detail: "",
          secret: 0,
          shown_by: "person",
          from_terminal: null,
          from_handle: null,
          version: 1,
          open_asked: 0,
          shown_at: 11,
          observed_at: null,
        },
      ])
    } finally {
      database.close()
    }
  })

  it("reads a migrated database as the runner wrote it, and writes it back", ({
    directory,
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const old = new DatabaseSync(path, { enableForeignKeyConstraints: false })
    old.exec(`${version6()}
      PRAGMA user_version = 6;
      ${heldByVersion6}`)
    old.close()

    const workspace = store(path)
    expect(workspace.sessions("p").map(({ id, visitedAt }) => [id, visitedAt])).toEqual([
      ["s", 1000],
      ["tied", 1000 + 0.001],
      ["real", 1500.5 + 0.002],
      ["notjson", null],
      ["text", null],
      ["fresh", null],
    ])
    expect(workspace.terminal("t")?.naming).toEqual({
      person: "Mine",
      opener: { title: "Login" },
      murmur: { title: "Fixing login" },
      summary: "Works on checkout",
    })
    expect(workspace.terminal("u")?.naming.opener).toBeNull()
    const messages = workspace.messages()
    expect(messages.map(({ id, thread, from }) => [id, thread, from.kind])).toEqual([
      ["m", "th", "agent"],
      ["answer", "t-a1b2", "person"],
      ["notice", "t-notice-notice", "novadeck"],
    ])
    expect(messages[1]!.from).toEqual(personSender)
    expect(messages[2]!.from).toEqual(novadeckSender)
    // What was read is written back as it was.
    for (const message of messages) workspace.saveMessage(message)
    expect(workspace.messages()).toEqual(messages)
    expect(workspace.items("s").map(({ id }) => id)).toEqual(["bar", "undocked", "plan", "project"])
    expect(workspace.items("s")[0]).toMatchObject({ secret: true, openAsked: false })
    expect(workspace.windows("s").map(({ id }) => id)).toEqual(["w", "pw"])
  })

  it("carries a version 6 database to the very tables a new one is made with", ({ directory }) => {
    const path = join(directory(), "workspace.sqlite")
    const old = new DatabaseSync(path, { enableForeignKeyConstraints: false })
    old.exec(`${version6()} PRAGMA user_version = 6;`)
    old.close()
    new WorkspaceStore(path).close()
    const fresh = join(directory(), "workspace.sqlite")
    new WorkspaceStore(fresh).close()
    const [migrated, created] = [path, fresh].map((file) => {
      const database = new DatabaseSync(file)
      try {
        return normalisedSchemaOf(database)
      } finally {
        database.close()
      }
    })
    // `schemaDifference` compares only columns; this is every constraint, index and default.
    expect(migrated).toEqual(created)
    expect(created!.length).toBeGreaterThan(15)
  })

  it("carries a version 7 database to the very tables a new one is made with, its projects unarranged", async ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const old = new DatabaseSync(path)
    old.exec(`${readFileSync(new URL("schemas/7.sql", import.meta.url), "utf8")}
      PRAGMA user_version = 7;
      INSERT INTO projects (position, id, name, cwd) VALUES (1, 'b', 'Second', '/b'),
        (2, 'a', 'First', '/a');`)
    old.close()
    const migrated = new WorkspaceStore(path)
    expect(migrated.projects()).toEqual([
      { id: "b", name: "Second", cwd: "/b", pinned: false },
      { id: "a", name: "First", cwd: "/a", pinned: false },
    ])
    migrated.close()
    const fresh = join(directory(), "workspace.sqlite")
    new WorkspaceStore(fresh).close()
    const [carried, created] = [path, fresh].map((file) => {
      const database = new DatabaseSync(file)
      try {
        return normalisedSchemaOf(database)
      } finally {
        database.close()
      }
    })
    expect(carried).toEqual(created)
  })

  it("lists projects in the person's order, then the unarranged ones as added, and keeps their pins", async ({
    directory,
    store,
  }) => {
    const cwd = directory()
    const path = join(cwd, "workspace.sqlite")
    const workspace = store(path)
    for (const id of ["a", "b", "c", "d"]) {
      // eslint-disable-next-line no-await-in-loop -- Made one after another, so they list in that order.
      expect((await workspace.createProject({ id, name: id, cwd })).pinned).toBe(false)
    }
    expect(workspace.projects().map(({ id, pinned }) => [id, pinned])).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
      ["d", false],
    ])
    // Unknown ids and repeats are ignored; `d` is left out, and `b` named pinned but not ordered.
    workspace.arrangeProjects(["c", "gone", "a", "c"], ["a", "b", "gone"])
    expect(workspace.projects().map(({ id, pinned }) => [id, pinned])).toEqual([
      ["c", false],
      ["a", true],
      ["b", false],
      ["d", false],
    ])
    expect(workspace.renameProject({ projectId: "a", name: "A" }).pinned).toBe(true)
    workspace.close()
    expect(
      store(path)
        .projects()
        .map(({ id }) => id),
    ).toEqual(["c", "a", "b", "d"])
  })

  it("pins at most nine projects, the first nine in the person's order", async ({
    directory,
    store,
  }) => {
    const cwd = directory()
    const workspace = store(join(cwd, "workspace.sqlite"))
    const ids = Array.from({ length: 11 }, (_, index) => `p${index}`)
    // eslint-disable-next-line no-await-in-loop -- Made one after another, so they list in that order.
    for (const id of ids) await workspace.createProject({ id, name: id, cwd })
    const order = ids.toReversed()
    workspace.arrangeProjects(order, ids)
    expect(workspace.projects().map(({ id }) => id)).toEqual(order)
    expect(
      workspace
        .projects()
        .filter(({ pinned }) => pinned)
        .map(({ id }) => id),
    ).toEqual(order.slice(0, 9))
  })

  it("sets aside, unchanged, a version 6 database whose step forward fails", ({ directory }) => {
    const path = join(directory(), "workspace.sqlite")
    // A project whose name the new tables can't hold: no filter can leave it behind.
    const old = new DatabaseSync(path, { enableForeignKeyConstraints: false })
    old.exec(`${version6()}
      PRAGMA user_version = 6;
      PRAGMA ignore_check_constraints = ON;
      INSERT INTO projects (position, id, name, cwd) VALUES (1, 'p', '', '/shop');`)
    old.close()
    expect(() => new WorkspaceStore(path)).toThrow(
      /earlier build: carrying it from version 6 failed \(CHECK constraint failed/,
    )
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'inbox'").get()).toEqual(
        { name: "inbox" },
      )
      expect(database.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({
        count: 1,
      })
    } finally {
      database.close()
    }
  })

  it("holds every row to its parent, and a message to who sent it", ({ directory, kept }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = kept(path)
    workspace.saveTerminal(numbered("a", "moth"))
    workspace.saveThread({
      id: "th",
      projectId: "p",
      between: ["a", "b"],
      hops: 1,
      heldFrom: null,
      heldFor: null,
      lastAt: 1,
      stoppedAt: null,
    })
    const database = new DatabaseSync(path)
    const run = (sql: string) => () => database.exec(sql)
    const message = (fields: Record<string, string>) => {
      const row = {
        id: "'x'",
        project_id: "'p'",
        thread_id: "'th'",
        hop: "1",
        from_kind: "'agent'",
        from_terminal: "'a'",
        from_handle: "'moth'",
        to_terminal: "'b'",
        to_handle: "'fox'",
        to_agent: "'codex'",
        text: "'hi'",
        sent_at: "1",
        state: "'queued'",
        notified: "0",
        stopped: "0",
        from_lead: "0",
        to_lead: "0",
        response: "NULL",
        ...fields,
      }
      return `INSERT INTO messages (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).join(", ")})`
    }
    const asked = { response: `'{"askId":"e"}'` }
    const person = {
      from_kind: "'person'",
      from_terminal: "NULL",
      from_handle: "NULL",
      thread_id: "NULL",
    }
    try {
      database.exec("BEGIN")
      database.exec(message({}))
      database.exec(message({ id: "'y'", ...person, ...asked }))
      database.exec(message({ id: "'z'", ...person, from_kind: "'novadeck'" }))
      database.exec("ROLLBACK")
      // A sender is its kind, its terminal and handle, and its thread, together or none.
      expect(run(message({ from_kind: "'robot'" }))).toThrow(/CHECK/)
      expect(run(message({ thread_id: "NULL" }))).toThrow(/CHECK/)
      expect(run(message({ from_terminal: "NULL" }))).toThrow(/CHECK/)
      expect(run(message({ from_handle: "NULL" }))).toThrow(/CHECK/)
      expect(run(message({ ...person, ...asked, from_terminal: "'a'" }))).toThrow(/CHECK/)
      expect(run(message({ ...person, ...asked, thread_id: "'th'" }))).toThrow(/CHECK/)
      // A person's message answers an entry, which its response names.
      expect(run(message({ ...person }))).toThrow(/CHECK/)
      expect(run(message({ ...person, response: "'{}'" }))).toThrow(/CHECK/)
      expect(run(message({ ...person, response: `'{"askId":5}'` }))).toThrow(/CHECK/)
      // The thread and project are known, and the same.
      expect(run(message({ thread_id: "'nope'" }))).toThrow(/FOREIGN KEY/)
      expect(run(message({ project_id: "'nope'" }))).toThrow(/FOREIGN KEY/)
      expect(run("INSERT INTO projects (id, name, cwd) VALUES ('q', 'Other', '/')")).not.toThrow()
      expect(run(message({ project_id: "'q'" }))).toThrow(/FOREIGN KEY/)
      // Nothing else without its parent.
      expect(run("INSERT INTO sessions (id, project_id, name) VALUES ('t', 'nope', 'S')")).toThrow(
        /FOREIGN KEY/,
      )
      expect(
        run(
          `INSERT INTO terminals (id, session_id, handle, cwd, agent_reports, saved_at)
           VALUES ('c', 'nope', 'owl', '/', '{}', 1)`,
        ),
      ).toThrow(/FOREIGN KEY/)
      expect(run("INSERT INTO session_handles VALUES ('nope', 'owl')")).toThrow(/FOREIGN KEY/)
      expect(
        run("INSERT INTO message_threads VALUES ('t2', 'nope', 'a', 'b', 1, NULL, NULL, 1, NULL)"),
      ).toThrow(/FOREIGN KEY/)
      expect(run("INSERT INTO inbox_entries VALUES ('e', 'nope', 'a', 1, '{}')")).toThrow(
        /FOREIGN KEY/,
      )
      expect(
        run("INSERT INTO companion_windows VALUES ('w', 'nope', 'undocked', NULL, 1)"),
      ).toThrow(/FOREIGN KEY/)
    } finally {
      database.close()
    }
  })

  it("holds an item to a terminal of its own session, and a session to one project window", ({
    directory,
    kept,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = kept(path)
    workspace.saveTerminal(numbered("a", "moth"))
    const database = new DatabaseSync(path)
    const projectItem = (id: string, window: string, from: string) => `
      INSERT INTO companion_windows (id, session_id, home, created_at)
        VALUES ('${window}', 's', 'project', 11);
      INSERT INTO companion_items (id, session_id, terminal_id, window_id, pointer_key, kind,
        path, name, detail, secret, shown_by, from_terminal, from_handle, version, open_asked,
        shown_at)
        VALUES ('${id}', 's', NULL, '${window}', '/shop/${id}', 'file', '/shop/${id}', '${id}',
          '', 0, 'person', ${from}, 1, 0, 12);`
    const attempt = (sql: string) => {
      database.exec("BEGIN")
      try {
        database.exec(sql)
        database.exec("COMMIT")
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      }
    }
    try {
      expect(() => attempt(projectItem("one", "p1", "NULL, 'moth'"))).toThrow(/CHECK/)
      attempt(projectItem("one", "p1", "NULL, NULL"))
      expect(() => attempt(projectItem("two", "p2", "NULL, NULL"))).toThrow(/UNIQUE/)
      // The refused ones left no window behind.
      expect(database.prepare("SELECT count(*) AS count FROM companion_windows").get()).toEqual({
        count: 1,
      })
      // A bar item is in its terminal's session, and in none other.
      const bar = (session: string) => `
        INSERT INTO companion_items (id, session_id, terminal_id, window_id, pointer_key, kind,
          name, detail, secret, shown_by, version, open_asked, shown_at)
          VALUES ('bar', '${session}', 'a', NULL, '/shop/bar', 'file', 'bar', '', 0, 'agent', 1,
          0, 12)`
      expect(() => database.exec(bar("other"))).toThrow(/FOREIGN KEY/)
      database.exec(bar("s"))
    } finally {
      database.close()
    }
  })

  it("moves a terminal's items with it when a save puts it in another session", ({ kept }) => {
    const workspace = kept()
    workspace.saveTerminal(numbered("a", "moth"))
    workspace.saveItem(item("s", "a", "/work/x"))
    workspace.saveTerminal({ ...numbered("a", "moth"), sessionId: "other" })
    expect(workspace.terminal("a")?.sessionId).toBe("other")
    expect(workspace.items("s")).toEqual([])
    expect(workspace.items("other")).toMatchObject([{ terminalId: "a", sessionId: "other" }])
    expect(workspace.barItems("a")).toHaveLength(1)
  })

  it("keeps a session unvisited until a save says when, whatever else it holds", ({
    directory,
    kept,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = kept(path)
    expect(workspace.sessions("p").map(({ id, visitedAt }) => [id, visitedAt])).toEqual(
      ["s", "session", "other", "elsewhere", "odd", "even"].map((id) => [id, null]),
    )
    // What a session keeps, and a state saved without a visit, don't make it visited.
    workspace.saveTerminal(numbered("a", "moth"))
    workspace.saveSession({ sessionId: "s", state: "{}", visitedAt: null })
    expect(workspace.session("s").visitedAt).toBeNull()
    workspace.saveSession({ sessionId: "s", state: "{}", visitedAt: 1_700_000_000_000.5 })
    workspace.saveTerminal({ ...numbered("a", "moth"), cwd: "/elsewhere" })
    workspace.close()
    expect(kept(path).session("s")).toMatchObject({ state: "{}", visitedAt: 1_700_000_000_000.5 })
  })

  it("keeps its schema as recorded for its version, so a change to it comes with a step", ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    new WorkspaceStore(path).close()
    const database = new DatabaseSync(path)
    try {
      const version = database.prepare("PRAGMA user_version").get()?.user_version
      const digest = createHash("sha256")
        .update(JSON.stringify(schemaOf(database)))
        .digest("hex")
      // A change to a table's columns or constraints, or a new table, raises schemaVersion
      // and adds a step in store.ts's migrations, from schemas/<version before>.sql, which
      // is added for it. Then record the new digest here.
      expect({ version, digest }).toEqual({
        version: 8,
        digest: "f61e02a512d9a259d5f47cebd870774b66a7d69fa58cf09801e41d863e20d9c1",
      })
    } finally {
      database.close()
    }
  })

  it("refuses a database from before word handles by its schema version, keeping its terminals", ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    new WorkspaceStore(path).close()
    const old = new DatabaseSync(path, { enableForeignKeyConstraints: false })
    // Numbered handles' tables had the same columns; only the version tells them apart.
    old.exec(`
      PRAGMA user_version = 1;
      INSERT INTO terminals (id, session_id, cwd, agent_reports, saved_at, handle)
        VALUES ('a', 's', '/', '{}', 1, 't3');
    `)
    old.close()
    expect(() => new WorkspaceStore(path)).toThrow(
      /earlier build: its schema is version 1, older than the oldest this build carries \(6\)\./,
    )
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("SELECT handle FROM terminals").all()).toEqual([{ handle: "t3" }])
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1)
    } finally {
      database.close()
    }
  })

  it("refuses a database from before murmur titles, which has no murmur_title", ({ directory }) => {
    const path = join(directory(), "workspace.sqlite")
    new WorkspaceStore(path).close()
    const old = new DatabaseSync(path)
    old.exec("ALTER TABLE terminals DROP COLUMN murmur_title")
    old.close()
    expect(() => new WorkspaceStore(path)).toThrow(/expects murmur_title TEXT/)
  })

  it("sets an earlier build's database aside with its log, so a new one starts in its place", ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    for (const suffix of ["", "-wal", "-shm"]) writeFileSync(`${path}${suffix}`, suffix || "db")
    const aside = setAsideWorkspace(path, new Date("2026-10-14T12:00:00.000Z"))
    expect(aside).toBe(`${path}.earlier-2026-10-14T12-00-00-000Z`)
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(existsSync(`${path}${suffix}`)).toBe(false)
      expect(readFileSync(`${aside}${suffix}`, "utf8")).toBe(suffix || "db")
    }
  })

  it("refuses a database an earlier build wrote, naming it and why", ({ directory }) => {
    const path = join(directory(), "workspace.sqlite")
    // The terminals table as an early runner wrote it, before it kept a schema version.
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE terminals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, cwd TEXT NOT NULL,
        agents TEXT NOT NULL, prompted_at REAL, transcript TEXT, updated_at REAL NOT NULL) STRICT;
      INSERT INTO terminals VALUES ('a', 's', '/', '{}', NULL, NULL, 1);
    `)
    old.close()
    let refusal: unknown
    try {
      new WorkspaceStore(path).close()
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(Error)
    const { message } = refusal as Error
    expect(message).toContain(path)
    expect(message).toContain("it has tables but no schema version")
    expect(refusal).toBeInstanceOf(EarlierWorkspaceError)
    // Nothing was changed: the old terminal is there, and nothing was added.
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("SELECT id FROM terminals").all()).toEqual([{ id: "a" }])
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(0)
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name = 'messages'").get(),
      ).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it("refuses a messages table whose recipient session can't be null", ({ directory, store }) => {
    const path = join(directory(), "workspace.sqlite")
    store(path).close()
    const database = new DatabaseSync(path)
    database.exec(`
      DROP TABLE messages;
      CREATE TABLE messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL, hop INTEGER NOT NULL, from_terminal TEXT NOT NULL,
        from_handle TEXT NOT NULL, from_agent TEXT, from_session TEXT,
        to_terminal TEXT NOT NULL, to_handle TEXT NOT NULL, to_agent TEXT NOT NULL,
        to_session TEXT NOT NULL, text TEXT NOT NULL, sent_at REAL NOT NULL,
        state TEXT NOT NULL, delivered_at REAL, notified INTEGER NOT NULL) STRICT;
    `)
    database.close()
    expect(() => new WorkspaceStore(path)).toThrow(/messages table differs .*to_session/)
  })

  it.skipIf(process.platform === "win32")(
    "creates private storage without changing existing parent permissions",
    ({ directory, store }) => {
      const existing = directory()
      chmodSync(existing, 0o755)
      const path = join(existing, "private", "metadata", "workspace.sqlite")
      store(path)
      expect(statSync(existing).mode & 0o777).toBe(0o755)
      expect(statSync(join(existing, "private")).mode & 0o777).toBe(0o700)
      expect(statSync(join(existing, "private", "metadata")).mode & 0o777).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    },
  )
})

// A kept terminal of session s, by its id and handle.
const numbered = (id: string, handle: string) => ({
  id,
  sessionId: "s",
  cwd: "/",
  agents: {},
  promptedAt: null,
  handle,
  naming: { person: null, opener: null, murmur: null, summary: null },
  openedBy: null,
  ledBy: null,
  command: null,
  lastProgram: null,
  work: null,
})

describe("saved terminals", () => {
  it("keep what a session was doing in its agent's report, and read a row saved without it as having none", async ({
    directory,
    kept,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const first = kept(path)
    first.saveTerminal({
      ...numbered("a", "moth"),
      agents: { claude: { sessionId: "abc", seq: 2, turn: "running" } },
    })
    first.saveTerminal({
      ...numbered("b", "owl"),
      agents: {
        claude: { sessionId: "def", seq: 3, turn: "waking" },
        codex: { sessionId: "x", seq: 1 },
      },
    })
    first.close()
    // A row an earlier build saved holds no turn in its JSON, and the schema is unchanged.
    const raw = new DatabaseSync(path)
    raw.exec(`
      INSERT INTO terminals (id, session_id, cwd, agent_reports, saved_at, handle)
        VALUES ('c', 's', '/', '{"claude":{"sessionId":"old","seq":1}}', 1, 'fox');
    `)
    raw.close()
    const reopened = kept(path)
    expect(reopened.terminal("a")?.agents).toEqual({
      claude: { sessionId: "abc", seq: 2, turn: "running" },
    })
    expect(reopened.terminal("b")?.agents).toEqual({
      claude: { sessionId: "def", seq: 3, turn: "waking" },
      codex: { sessionId: "x", seq: 1 },
    })
    expect(reopened.terminal("c")?.agents).toEqual({ claude: { sessionId: "old", seq: 1 } })
  })

  it("keep what restores a terminal, in the owner-only metadata file", async ({
    directory,
    kept,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const first = kept(path)
    const terminal = {
      id: randomUUID(),
      sessionId: "s",
      cwd: "/work",
      agents: { claude: { sessionId: "abc", seq: 2 } },
      promptedAt: 1_000,
      handle: "owl",
      naming: {
        person: null,
        opener: { title: "API author" },
        murmur: { title: "Building the API" },
        summary: "Builds the API.\nThen its tests.",
      },
      openedBy: "fox",
      ledBy: "fox",
      command: "claude",
      lastProgram: "claude",
      work: {
        session: "claude:abc",
        first: "Build the users API",
        latest: "Now add paging",
        folders: { "/work/src": 4 },
        activeAt: 2_000,
        personAt: 1_500,
      },
    }
    first.saveTerminal({ ...terminal, transcript: "screen" })
    // Saving without a transcript leaves the saved one as it is.
    first.saveTerminal({ ...terminal, cwd: "/work/sub" })
    first.close()
    const reopened = kept(path)
    expect(reopened.terminal(terminal.id)).toEqual({
      ...terminal,
      cwd: "/work/sub",
      transcript: "screen",
      savedAt: expect.any(Number),
    })
    expect(reopened.terminalIdentity(terminal.id)).toEqual({
      handle: "owl",
      // What names it, each layer and who gave it, survives a reload, as who opened it does.
      naming: terminal.naming,
      openedBy: "fox",
      ledBy: "fox",
    })
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
    reopened.clearTranscripts()
    expect(reopened.terminal(terminal.id)?.transcript).toBeNull()
    reopened.removeTerminal(terminal.id)
    expect(reopened.terminal(terminal.id)).toBeUndefined()
  })

  it("forgets every transcript that is not sealed, scrubbing the file and its log", ({
    directory,
    kept,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const shape = sealedShape
    const first = kept(path)
    const plain = keptTerminal(first, "session", "owl")
    const sealed = keptTerminal(first, "session", "fox")
    // The shortest a real sealed value is, an empty screen's.
    const value = sealedText("", sealed)
    expect(value).toHaveLength(shape.prefix.length + shape.minChars)
    first.saveTerminal({ ...first.terminal(plain)!, transcript: "TOKEN=hunter2" })
    first.saveTerminal({ ...first.terminal(sealed)!, transcript: value })
    // Plain text that only starts like a sealed value, and one a character too short.
    const lookalike = keptTerminal(first, "session", "elk")
    first.saveTerminal({ ...first.terminal(lookalike)!, transcript: "v1.4.2 released\n$ " })
    const short = keptTerminal(first, "session", "ant")
    first.saveTerminal({ ...first.terminal(short)!, transcript: value.slice(0, -1) })
    // Base64's alphabet, but not a whole number of its four-character groups.
    const ragged = keptTerminal(first, "session", "bee")
    first.saveTerminal({ ...first.terminal(ragged)!, transcript: `${value}A` })
    // A full transcript's worth, sealed: kept, however long.
    const long = keptTerminal(first, "session", "yak")
    const longValue = sealedText("x".repeat(256 * 1024), long)
    first.saveTerminal({ ...first.terminal(long)!, transcript: longValue })
    first.close()

    const next = kept(path)
    next.forgetUnsealed(shape)
    expect(next.terminal(plain)?.transcript).toBeNull()
    expect(next.terminal(sealed)?.transcript).toBe(value)
    expect(next.terminal(lookalike)?.transcript).toBeNull()
    expect(next.terminal(short)?.transcript).toBeNull()
    expect(next.terminal(ragged)?.transcript).toBeNull()
    expect(next.terminal(long)?.transcript).toBe(longValue)
    // Scrubbed from the file and its log at once, not a moment later.
    expect(holds(path, "TOKEN=hunter2") || holds(`${path}-wal`, "TOKEN=hunter2")).toBe(false)
    // Nothing left to forget.
    next.forgetUnsealed(shape)
    expect(next.terminal(sealed)?.transcript).toBe(value)
  })

  it("keep murmur's title and the agent's summary beside the person's and the opener's title", ({
    directory,
    kept,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = kept(path)
    const opener = { title: "Server" }
    const murmur = { title: "Fixing login" }
    const summary = "Fixes the login bug."
    workspace.saveTerminal({
      ...numbered("a", "fox"),
      naming: { person: "Mine", opener, murmur, summary },
    })
    expect(workspace.terminal("a")?.naming).toEqual({ person: "Mine", opener, murmur, summary })
    // Taking the person's title away leaves the other layers.
    expect(workspace.renameTerminal("a", null)).toBe(true)
    expect(workspace.terminalIdentity("a")?.naming).toEqual({
      person: null,
      opener,
      murmur,
      summary,
    })
    // The summary and murmur's title change apart.
    const next = { title: "Fixing signup" }
    workspace.saveTerminal({
      ...numbered("a", "fox"),
      naming: { person: null, opener, murmur: next, summary },
    })
    expect(workspace.terminals().map(({ naming }) => naming)).toEqual([
      { person: null, opener, murmur: next, summary },
    ])
    workspace.saveTerminal({
      ...numbered("a", "fox"),
      naming: { person: null, opener, murmur: null, summary: null },
    })
    expect(workspace.terminal("a")?.naming).toEqual({
      person: null,
      opener,
      murmur: null,
      summary: null,
    })
    workspace.close()
  })

  it("overwrite what they forget, which may hold secrets, and empty their log after", async ({
    directory,
    kept,
  }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const cwd = directory()
      const path = join(cwd, "workspace.sqlite")
      const workspace = kept(path)
      const project = await workspace.createProject({ id: randomUUID(), name: "P", cwd })
      const session = workspace.createSession({
        id: randomUUID(),
        projectId: project.id,
        name: "S",
      })
      const terminal = (transcript: string, agentSession = "s1") => {
        const id = randomUUID()
        workspace.saveTerminal({
          ...numbered(id, id),
          sessionId: session.id,
          agents: { codex: { sessionId: agentSession, at: 1 } } as never,
          transcript,
        })
        return id
      }
      // Each way something is forgotten: what it held, and the forgetting.
      const forgetting: [string, string, () => void][] = [
        [
          "transcripts",
          "SECRET_TRANSCRIPT_ONE",
          () => (terminal("SECRET_TRANSCRIPT_ONE"), workspace.clearTranscripts()),
        ],
        [
          "a terminal",
          "SECRET_TRANSCRIPT_TWO",
          () => workspace.removeTerminal(terminal("SECRET_TRANSCRIPT_TWO")),
        ],
        [
          "an agent",
          "SECRET_AGENT_SESSION",
          () => (terminal("", "SECRET_AGENT_SESSION"), workspace.forgetAgent("codex")),
        ],
        [
          "messages",
          "SECRET_MESSAGE_TEXT",
          () => {
            const id = randomUUID()
            const sent = { ...message(id, "queued"), projectId: project.id, thread: id }
            workspace.saveThread({
              id,
              projectId: project.id,
              between: ["a", "b"],
              hops: 1,
              heldFrom: null,
              heldFor: null,
              lastAt: 1,
              stoppedAt: null,
            })
            workspace.saveMessage({ ...sent, text: "SECRET_MESSAGE_TEXT" })
            workspace.removeMessages([id])
          },
        ],
        [
          "threads",
          "SECRET_THREAD_ID",
          () => {
            const between = ["a", "b"] as const
            const thread = {
              projectId: project.id,
              between,
              hops: 1,
              heldFrom: null,
              heldFor: null,
              lastAt: 1,
              stoppedAt: null,
            }
            workspace.saveThread({ ...thread, id: "SECRET_THREAD_ID" })
            workspace.removeThreads(["SECRET_THREAD_ID"])
          },
        ],
        [
          "an item",
          "SECRET_ITEM_DETAIL",
          () => {
            const shown = item(session.id, keptTerminal(workspace, session.id, "haze"), "/work/x")
            workspace.saveItem({ ...shown, detail: "SECRET_ITEM_DETAIL" })
            workspace.removeItem(shown.id)
          },
        ],
        [
          "an item docked over",
          "SECRET_REPLACED_DETAIL",
          () => {
            const there = keptTerminal(workspace, session.id, "volt")
            const shown = item(session.id, there, "/work/y", {
              detail: "SECRET_REPLACED_DETAIL",
            })
            workspace.saveItem(shown)
            const moving = item(session.id, keptTerminal(workspace, session.id, "dusk"), "/work/y")
            workspace.saveItem(moving)
            workspace.dockItem(moving.id, there)
          },
        ],
        [
          "murmur's titles",
          "SECRET_MURMUR_TITLE",
          () => {
            const naming = { person: null, opener: null, summary: null }
            workspace.saveTerminal({
              ...numbered(randomUUID(), "raven"),
              sessionId: session.id,
              naming: { ...naming, murmur: { title: "SECRET_MURMUR_TITLE" } },
            })
            workspace.clearMurmurTitles()
          },
        ],
      ]
      for (const [what, secret, forget] of forgetting) {
        forget()
        // Its checkpoint waits a moment, for whatever else is forgotten meanwhile.
        vi.advanceTimersByTime(999)
        expect(statSync(`${path}-wal`).size, what).toBeGreaterThan(0)
        vi.advanceTimersByTime(1)
        expect(statSync(`${path}-wal`).size, what).toBe(0)
        expect(holds(path, secret), what).toBe(false)
      }
      // A project goes with all it held; closing empties the log at once.
      terminal("SECRET_PROJECT_TRANSCRIPT")
      workspace.removeProject(project.id)
      workspace.close()
      expect(holds(path, "SECRET_PROJECT_TRANSCRIPT")).toBe(false)
      expect(holds(`${path}-wal`, "SECRET_PROJECT_TRANSCRIPT")).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("write through a log as private as the database, so a save never flushes the disk", ({
    directory,
    kept,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = kept(path)
    workspace.saveTerminal({
      id: randomUUID(),
      sessionId: "s",
      cwd: "/",
      agents: {},
      promptedAt: null,
      handle: "moth",
      naming: { person: null, opener: null, murmur: null, summary: null },
      openedBy: null,
      ledBy: null,
      command: null,
      lastProgram: null,
      work: null,
    })
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
    } finally {
      database.close()
    }
    if (process.platform !== "win32")
      for (const file of [`${path}-wal`, `${path}-shm`])
        expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("keep every terminal until it is closed, listed by session in the order they came", ({
    kept,
  }) => {
    const workspace = kept()
    const ids = Array.from({ length: 130 }, () => randomUUID())
    for (const [index, id] of ids.entries())
      workspace.saveTerminal({
        id,
        sessionId: index % 2 ? "odd" : "even",
        cwd: "/",
        agents: {},
        promptedAt: null,
        handle: `moth${index + 1}`,
        naming: { person: null, opener: null, murmur: null, summary: null },
        openedBy: null,
        ledBy: null,
        command: null,
        lastProgram: null,
        work: null,
      })
    expect(workspace.terminal(ids[0]!)).toBeDefined()
    expect(workspace.terminals()).toHaveLength(130)
    expect(workspace.terminals("odd").map(({ id }) => id)).toEqual(ids.filter((_, i) => i % 2))
    expect(workspace.terminals("odd")[0]).not.toHaveProperty("transcript")
  })

  it("list a session's terminals in the order they were created, whatever their handles", ({
    kept,
  }) => {
    const workspace = kept()
    for (const [id, handle] of [
      ["b", "owl"],
      ["j", "moth"],
      ["a", "crow2"],
    ] as const)
      workspace.saveTerminal(numbered(id, handle))
    // Saved again, a terminal keeps its place.
    workspace.saveTerminal(numbered("b", "owl"))
    expect(workspace.terminals("s").map(({ id }) => id)).toEqual(["b", "j", "a"])
    expect(workspace.terminals().map(({ id }) => id)).toEqual(["b", "j", "a"])
  })

  it("list terminals in the order their handles were given, though saved in another", ({
    kept,
  }) => {
    const workspace = kept()
    const moth = workspace.giveHandle("s")
    const fox = workspace.giveHandle("s")
    // fox's create finished first, so its row was saved before moth's.
    workspace.saveTerminal(numbered("second", fox))
    workspace.saveTerminal(numbered("first", moth))
    expect(workspace.terminals("s").map(({ id }) => id)).toEqual(["first", "second"])
    expect(workspace.terminals().map(({ id }) => id)).toEqual(["first", "second"])
  })

  it("rename a kept terminal, and keep each session's given handles across restarts", ({
    directory,
    kept,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const order = handleOrder("s")
    const first = kept(path)
    expect(first.giveHandle("s")).toBe(order[0])
    expect(first.giveHandle("s")).toBe(order[1])
    first.saveTerminal({
      id: "a",
      sessionId: "s",
      cwd: "/",
      agents: {},
      promptedAt: null,
      handle: order[0]!,
      naming: { person: null, opener: null, murmur: null, summary: null },
      openedBy: null,
      ledBy: null,
      command: null,
      lastProgram: null,
      work: null,
    })
    expect(first.renameTerminal("a", "API author")).toBe(true)
    expect(first.renameTerminal("missing", "x")).toBe(false)
    first.close()
    const reopened = kept(path)
    expect(reopened.terminal("a")?.naming).toEqual({
      person: "API author",
      opener: null,
      murmur: null,
      summary: null,
    })
    expect(reopened.giveHandle("s")).toBe(order[2])
    // Taking the person's title away leaves it automatic.
    expect(reopened.renameTerminal("a", null)).toBe(true)
    expect(reopened.terminalIdentity("a")?.naming.person).toBeNull()
  })

  it("never give a session a handle twice, even after its terminal is closed or the runner restarts", ({
    directory,
    kept,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const first = kept(path)
    const moth = first.giveHandle("s")
    first.saveTerminal(numbered("a", moth))
    const fox = first.giveHandle("s")
    first.saveTerminal(numbered("b", fox))
    first.removeTerminal("a")
    first.close()
    const reopened = kept(path)
    const next = reopened.giveHandle("s")
    const order = handleOrder("s")
    expect([moth, fox]).toEqual(order.slice(0, 2))
    expect(next).toBe(order[2])
    expect([moth, fox, next]).not.toContain(order[3])
  })

  it("prefer a word whose letter no open terminal of the session starts with, whatever other sessions have open", ({
    kept,
  }) => {
    const workspace = kept()
    const [first, second] = handleOrder("s") as [string, string]
    // Another session having the first word open changes nothing.
    workspace.saveTerminal({ ...numbered("b", first), sessionId: "elsewhere" })
    // A terminal open here shares the first word's letter, so the second comes first.
    workspace.saveTerminal(numbered("a", `${first[0]}zz`))
    expect(workspace.giveHandle("s")).toBe(second)
    workspace.saveTerminal(numbered("c", second))
    // Closing it frees the letter.
    workspace.removeTerminal("a")
    expect(workspace.giveHandle("s")).toBe(first)
  })

  it("number the words again once a session has given them all", ({ kept }) => {
    const workspace = kept()
    const all = handleWords.map(() => workspace.giveHandle("s"))
    expect(new Set(all)).toEqual(new Set(handleWords))
    expect(workspace.giveHandle("s")).toMatch(/^[a-z]+2$/)
  })

  it("refuse two terminals with one handle in a session", ({ kept }) => {
    const workspace = kept()
    workspace.saveTerminal(numbered("a", "moth"))
    expect(() => workspace.saveTerminal(numbered("b", "moth"))).toThrow(/UNIQUE/)
    workspace.saveTerminal({ ...numbered("b", "moth"), sessionId: "other" })
    expect(workspace.terminals().map(({ id }) => id)).toEqual(["a", "b"])
  })

  it("keep transcripts until they are turned off", ({ kept }) => {
    const workspace = kept()
    expect(workspace.settings()).toEqual({ transcripts: true, welcomed: false })
    workspace.saveSettings({ transcripts: false })
    workspace.saveSettings({ welcomed: true })
    expect(workspace.settings()).toEqual({ transcripts: false, welcomed: true })
  })
})

const message = (id: string, state: Message["state"]): Message => ({
  id,
  projectId: "p",
  thread: "t-1",
  hop: 1,
  from: { kind: "agent", terminalId: "a", handle: "moth", agent: null, sessionId: null },
  to: { terminalId: "b", handle: "fox", agent: "codex", sessionId: "s" },
  text: "Review a.ts\n\twith care",
  sentAt: 1.5,
  state,
  deliveredAt: null,
  notified: false,
  stopped: false,
  fromLead: false,
  toLead: false,
})

describe("the messages", () => {
  it("keeps messages, threads and the pause across reopen, until removed", ({
    directory,
    kept,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const original = kept(path)
    const thread: Thread = {
      id: "t-1",
      projectId: "p",
      between: ["a", "b"],
      hops: 2,
      heldFrom: null,
      heldFor: null,
      lastAt: 3,
      stoppedAt: null,
    }
    original.saveThread(thread)
    original.saveMessage(message("m-1", "queued"))
    // One from its recipient's lead, which keeps that.
    original.saveMessage({ ...message("m-2", "held"), fromLead: true, toLead: true })
    // One for a terminal's first session, which no agent there has bound yet.
    const waiting = message("m-3", "queued")
    original.saveMessage({ ...waiting, to: { ...waiting.to, sessionId: null } })
    original.saveMessage({
      ...message("m-1", "delivered"),
      to: { ...message("m-1", "queued").to, sessionId: "s2" },
      deliveredAt: 9,
      notified: true,
    })
    original.saveThread({ ...thread, heldFrom: 14, heldFor: "loop" as const })
    // One the person stopped, whose queued message went gone for it.
    original.saveMessage({ ...message("m-4", "gone"), stopped: true })
    original.saveThread({ ...thread, id: "t-2", stoppedAt: 7 })
    original.pauseMessaging(true)
    original.saveTerminal({
      id: "a",
      sessionId: "s",
      cwd: "/",
      agents: {},
      promptedAt: null,
      handle: "moth",
      naming: { person: null, opener: null, murmur: null, summary: null },
      openedBy: null,
      ledBy: null,
      command: null,
      lastProgram: null,
      work: null,
    })
    original.close()
    const reopened = kept(path)
    expect(reopened.messages()).toEqual([
      {
        ...message("m-1", "delivered"),
        to: { ...message("m-1", "queued").to, sessionId: "s2" },
        deliveredAt: 9,
        notified: true,
      },
      { ...message("m-2", "held"), fromLead: true, toLead: true },
      { ...waiting, to: { ...waiting.to, sessionId: null } },
      { ...message("m-4", "gone"), stopped: true },
    ])
    expect(reopened.threads()).toEqual([
      { ...thread, heldFrom: 14, heldFor: "loop" as const },
      { ...thread, id: "t-2", stoppedAt: 7 },
    ])
    expect(reopened.messagingPaused()).toBe(true)
    // The pause is the runner's own, not one of the client's settings.
    expect(reopened.settings()).toEqual({ transcripts: true, welcomed: false })
    expect(reopened.terminalIdentity("a")).toMatchObject({ handle: "moth" })
    expect(reopened.terminalIdentity("b")).toBeUndefined()
    reopened.removeMessages(["m-1"])
    reopened.pauseMessaging(false)
    expect(reopened.messages().map(({ id }) => id)).toEqual(["m-2", "m-3", "m-4"])
    // A thread goes with its messages, as its foreign key says.
    reopened.removeThreads(["t-1"])
    expect(reopened.messages()).toEqual([])
    reopened.saveThread({ ...thread, id: "t-2", stoppedAt: null })
    expect(reopened.threads()[0]?.stoppedAt).toBeNull()
    reopened.removeThreads(["t-2"])
    expect(reopened.threads()).toEqual([])
    expect(reopened.messagingPaused()).toBe(false)
  })
})

// A terminal kept in a session, as the terminals save one.
const keptTerminal = (workspace: WorkspaceStore, sessionId: string, handle: string) => {
  const id = randomUUID()
  workspace.saveTerminal({
    id,
    sessionId,
    cwd: "/work",
    agents: {},
    promptedAt: null,
    handle,
    naming: { person: null, opener: null, murmur: null, summary: null },
    openedBy: null,
    ledBy: null,
    command: null,
    lastProgram: null,
    work: null,
  })
  return id
}

const item = (
  sessionId: string,
  terminalId: string,
  pointerKey: string,
  fields: Partial<ItemRecord> = {},
): ItemRecord => ({
  id: randomUUID(),
  sessionId,
  terminalId,
  windowId: null,
  pointerKey,
  kind: "file",
  path: pointerKey,
  url: null,
  lines: null,
  plan: null,
  name: pointerKey,
  detail: pointerKey,
  secret: false,
  by: "agent",
  from: { terminalId, handle: "moth" },
  version: 1,
  openAsked: false,
  shownAt: 1,
  observedAt: null,
  ...fields,
})

describe("companion items", () => {
  it("keep a changes item, which its kind check allows", async ({ directory, store }) => {
    const cwd = directory()
    const workspace = store(join(cwd, "workspace.sqlite"))
    const project = await workspace.createProject({ id: randomUUID(), name: "P", cwd })
    const session = workspace.createSession({ id: randomUUID(), projectId: project.id, name: "S" })
    const terminal = keptTerminal(workspace, session.id, "moth")
    const changes = item(session.id, terminal, "changes:/work", {
      kind: "changes",
      path: "/work",
      name: "Changes · work",
    })
    workspace.saveItem(changes)
    expect(workspace.items(session.id)).toEqual([changes])
    expect(workspace.item(changes.id)).toEqual(changes)
  })

  it("keep a session's project window with its item from no terminal, one window at most", async ({
    directory,
    store,
  }) => {
    const cwd = directory()
    const workspace = store(join(cwd, "workspace.sqlite"))
    const project = await workspace.createProject({ id: randomUUID(), name: "P", cwd })
    const session = workspace.createSession({ id: randomUUID(), projectId: project.id, name: "S" })
    const windowId = randomUUID()
    const opened = item(session.id, "unused", "/work/a.ts", {
      terminalId: null,
      windowId,
      by: "person",
      from: null,
    })
    workspace.addProjectItem({ id: windowId, createdAt: 5 }, opened)
    expect(workspace.item(opened.id)).toEqual(opened)
    expect(workspace.windows(session.id)).toEqual([
      {
        id: windowId,
        sessionId: session.id,
        home: "project",
        itemId: opened.id,
        itemName: "/work/a.ts",
        personTitle: null,
      },
    ])

    // A second window, or a taken id, refuses, and leaves neither window nor item behind.
    const second = item(session.id, "unused", "/work/b.ts", {
      terminalId: null,
      windowId: randomUUID(),
      from: null,
    })
    expect(() => workspace.addProjectItem({ id: second.windowId!, createdAt: 6 }, second)).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(() => workspace.addProjectItem({ id: windowId, createdAt: 6 }, second)).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(workspace.item(second.id)).toBeUndefined()
    expect(workspace.windows(session.id)).toHaveLength(1)
    expect(() =>
      workspace.addProjectItem(
        { id: randomUUID(), createdAt: 6 },
        { ...second, sessionId: "gone" },
      ),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
  })

  it("keep each item with one holder, replacing a bar's copy and dropping windows left", async ({
    directory,
    store,
  }) => {
    const cwd = directory()
    const path = join(cwd, "workspace.sqlite")
    const workspace = store(path)
    const project = await workspace.createProject({
      id: randomUUID(),
      name: "P",
      cwd,
    })
    const session = workspace.createSession({
      id: randomUUID(),
      projectId: project.id,
      name: "S",
    })
    const first = keptTerminal(workspace, session.id, "moth")
    const second = keptTerminal(workspace, session.id, "fox")
    const shown = item(session.id, first, "/work/a.ts", {
      lines: { from: 2, to: 4 },
    })
    const plan = item(session.id, first, "plan:s1:", {
      kind: "plan",
      plan: { agent: "codex", session: "s1", actor: null, format: "text" },
      observedAt: 5,
      shownAt: 2,
    })
    const copy = item(session.id, second, "/work/a.ts", { shownAt: 3 })
    for (const each of [shown, plan, copy]) workspace.saveItem(each)
    // One pointer per bar.
    expect(() => workspace.saveItem(item(session.id, first, "/work/a.ts"))).toThrow(/UNIQUE/)
    expect(workspace.items(session.id)).toEqual([shown, plan, copy])
    expect(workspace.barItems(first)).toEqual([shown, plan])

    const windowId = randomUUID()
    const undocked = workspace.undockItem(shown.id, { id: windowId, createdAt: 10 })
    expect(undocked.item).toEqual({ ...shown, terminalId: null, windowId })
    expect(workspace.windows(session.id)).toEqual([
      {
        id: windowId,
        sessionId: session.id,
        home: "undocked",
        itemId: shown.id,
        itemName: "/work/a.ts",
        personTitle: null,
      },
    ])
    expect(() => workspace.undockItem(plan.id, { id: windowId, createdAt: 11 })).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(workspace.renameWindow(windowId, "Mine")).toBe(true)
    expect(workspace.renameWindow(randomUUID(), "Nobody's")).toBe(false)
    // A terminal it doesn't keep can hold nothing.
    expect(() => workspace.dockItem(plan.id, randomUUID())).toThrow(
      expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
    )
    expect(() => workspace.saveItem(item(session.id, randomUUID(), "/work/b.ts"))).toThrow(
      expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
    )

    // Docked onto the second bar, it replaces the copy there, and its window goes.
    const docked = workspace.dockItem(shown.id, second)
    expect(docked).toEqual({
      item: { ...shown, terminalId: second },
      left: expect.objectContaining({ id: windowId, personTitle: "Mine" }),
      replaced: copy,
    })
    expect(workspace.windows()).toEqual([])
    expect(workspace.item(copy.id)).toBeUndefined()

    // Closing a windowed item takes its window along.
    const again = randomUUID()
    workspace.undockItem(plan.id, { id: again, createdAt: 12 })
    expect(workspace.removeItem(plan.id)).toEqual({
      item: { ...plan, terminalId: null, windowId: again },
      window: expect.objectContaining({ id: again }),
    })
    expect(workspace.removeItem(plan.id)).toBeUndefined()
    expect(workspace.window(again)).toBeUndefined()
    workspace.close()

    // Kept across a restart, and gone with the terminal holding it.
    const reopened = store(path)
    expect(reopened.items()).toEqual([{ ...shown, terminalId: second }])
    reopened.removeTerminal(second)
    expect(reopened.items()).toEqual([])
  })
})

describe("murmur's settings", () => {
  it("are off until chosen, and the choice is kept or forgotten", ({ directory, store }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = store(path)
    expect(workspace.murmurSettings()).toEqual({ enabled: false })
    expect(workspace.murmurEnabledChoice()).toBeUndefined()
    workspace.saveMurmurSettings({ enabled: true })
    workspace.close()
    const reopened = store(path)
    expect(reopened.murmurSettings()).toEqual({ enabled: true })
    expect(reopened.murmurEnabledChoice()).toBe(true)
    reopened.saveMurmurSettings({ enabled: false })
    expect(reopened.murmurEnabledChoice()).toBe(false)
    // Nothing given changes nothing; null forgets the choice.
    reopened.saveMurmurSettings({})
    expect(reopened.murmurEnabledChoice()).toBe(false)
    reopened.saveMurmurSettings({ enabled: null })
    expect(reopened.murmurEnabledChoice()).toBeUndefined()
  })

  it("keep the check the install passed, validated when read", ({ directory, store }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = store(path)
    expect(workspace.murmurCheck()).toBeNull()
    const check = { device: "Vulkan0", integrated: true, milliseconds: 5_200 }
    workspace.saveMurmurCheck(check)
    expect(workspace.murmurCheck()).toEqual(check)
    workspace.close()
    const database = new DatabaseSync(path)
    database.exec("UPDATE settings SET value = '{\"device\":1}' WHERE key = 'murmur.check'")
    database.close()
    const reopened = store(path)
    expect(reopened.murmurCheck()).toBeNull()
    reopened.saveMurmurCheck(check)
    reopened.saveMurmurCheck(null)
    expect(reopened.murmurCheck()).toBeNull()
  })

  it("keep why this computer can't run murmur, until it is forgotten", ({ directory, store }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = store(path)
    expect(workspace.murmurUnsupported()).toBeNull()
    workspace.saveMurmurUnsupported({ reason: "No graphics device answered.", engine: "abc" })
    workspace.close()
    const reopened = store(path)
    expect(reopened.murmurUnsupported()).toEqual({
      reason: "No graphics device answered.",
      engine: "abc",
    })
    reopened.saveMurmurUnsupported(null)
    expect(reopened.murmurUnsupported()).toBeNull()
  })

  it("reads a voice check an earlier build saved with more in it", ({ directory, store }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = store(path)
    expect(workspace.voiceCheck()).toBeNull()
    workspace.close()
    const database = new DatabaseSync(path)
    const save = (value: string) =>
      database
        .prepare(
          "INSERT INTO settings (key, value) VALUES ('voice.check', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(value)
    save(JSON.stringify({ model: "turbo", milliseconds: 2300, gpu: true, recommended: "turbo" }))
    database.close()
    const reopened = store(path)
    expect(reopened.voiceCheck()).toEqual({ model: "turbo", milliseconds: 2300 })
    reopened.saveVoiceCheck(null)
    expect(reopened.voiceCheck()).toBeNull()
  })
})

describe("the Inbox's entries", () => {
  const entry = (at: number) => ({
    id: randomUUID(),
    terminalId: randomUUID(),
    projectId: "p",
    workspaceSessionId: randomUUID(),
    agent: "claude" as const,
    sessionId: "s",
    handle: "moth",
    at,
    state: "open" as const,
    content: { kind: "tell" as const, subject: "Hi", body: "There" },
  })

  it("saves several entries as one transaction, and a failure saves none", ({
    directory,
    kept,
  }) => {
    const workspace = kept(join(directory(), "workspace.sqlite"))
    const [a, b] = [entry(1), entry(2)]
    workspace.saveEntries([a!, b!])
    expect(workspace.entries().map(({ id }) => id)).toEqual([a!.id, b!.id])
    const broken = { ...entry(3), content: 1n } as never
    expect(() => workspace.saveEntries([entry(3), broken])).toThrow()
    expect(workspace.entries()).toHaveLength(2)
  })

  it("removes several entries as one transaction", ({ directory, kept }) => {
    const workspace = kept(join(directory(), "workspace.sqlite"))
    const all = [entry(1), entry(2), entry(3)]
    workspace.saveEntries(all)
    workspace.removeEntries([all[0]!.id, all[2]!.id])
    expect(workspace.entries().map(({ id }) => id)).toEqual([all[1]!.id])
  })
})

describe("the snapshot taken before a migration", () => {
  const writeOld = (path: string, version = 6) => {
    const old = new DatabaseSync(path)
    old.exec(`${version6()}
      PRAGMA user_version = ${version};
      INSERT INTO projects (position, id, name, cwd) VALUES (1, 'p', 'Shop', '/shop');`)
    old.close()
  }
  const snapshots = (path: string) => {
    try {
      return readdirSync(join(path, "..", "snapshots")).toSorted()
    } catch {
      return []
    }
  }

  it("holds the database as it was, at its old version", ({ directory }) => {
    const path = join(directory(), "workspace.sqlite")
    writeOld(path)
    new WorkspaceStore(path).close()
    const [name, ...rest] = snapshots(path)
    expect(rest).toEqual([])
    expect(name).toMatch(/^workspace-v6-[\dTZ-]+\.sqlite$/)
    const copy = new DatabaseSync(join(path, "..", "snapshots", name ?? ""), {
      readOnly: true,
    })
    try {
      expect(copy.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
      expect(
        copy
          .prepare("SELECT id FROM projects")
          .all()
          .map((row) => row.id),
      ).toEqual(["p"])
    } finally {
      copy.close()
    }
  })

  it("is not taken for a current or a new database", ({ directory }) => {
    const path = join(directory(), "workspace.sqlite")
    new WorkspaceStore(path).close()
    new WorkspaceStore(path).close()
    expect(snapshots(path)).toEqual([])
  })

  it("keeps the newest three", ({ directory }) => {
    const root = directory()
    const path = join(root, "workspace.sqlite")
    const folder = join(root, "snapshots")
    mkdirSync(folder)
    for (const day of ["01", "02", "03", "04"]) {
      writeFileSync(join(folder, `workspace-v2-2026-10-${day}T00-00-00-000Z.sqlite`), "")
    }
    writeOld(path)
    new WorkspaceStore(path).close()
    const kept = readdirSync(folder).toSorted()
    expect(kept).toHaveLength(3)
    expect(kept.some((name) => name.includes("2026-10-01") || name.includes("2026-10-02"))).toBe(
      false,
    )
    expect(kept.some((name) => name.startsWith("workspace-v6-"))).toBe(true)
  })

  it("never stops the migration when it fails", ({ directory }) => {
    const path = join(directory(), "workspace.sqlite")
    writeOld(path)
    writeFileSync(join(path, "..", "snapshots"), "in the way")
    const workspace = new WorkspaceStore(path)
    try {
      expect(workspace.projects().map(({ id }) => id)).toEqual(["p"])
    } finally {
      workspace.close()
    }
  })
})
