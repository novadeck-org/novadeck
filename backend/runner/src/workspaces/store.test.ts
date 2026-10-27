import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
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
import type { Message, Thread } from "../messaging/messages.js"
import { handleOrder, handleWords } from "../terminals/handles.js"
import { sealedShape } from "../terminals/sealing.js"
import { describe, expect, it as base } from "../test.js"
import { sealed as sealedText } from "../testing/sealing.js"
import {
  EarlierWorkspaceError,
  restoreSetAside,
  setAsideWorkspace,
  WorkspaceStore,
  WorkspaceTooNewError,
} from "./store.js"

const it = base.extend<{
  directory: () => string
  store: (path?: string) => WorkspaceStore
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
})

// Whether a file holds `text`, as a secret it should have forgotten.
const holds = (file: string, text: string) => existsSync(file) && readFileSync(file).includes(text)

// Something in every table a version 2 database has, as that version's runner wrote it.
const heldByVersion2 = `
  INSERT INTO projects (position, id, name, cwd) VALUES (1, 'p', 'Shop', '/shop');
  INSERT INTO sessions (position, id, project_id, name, state) VALUES (1, 's', 'p', 'Main', '{}');
  INSERT INTO terminals (id, session_id, handle, cwd, agents, updated_at, summary, last_program)
    VALUES ('t', 's', 'moth', '/shop', '{}', 2, 'Works on checkout', 'claude');
  INSERT INTO session_handles VALUES ('s', 'moth');
  INSERT INTO settings VALUES ('example', '1');
  INSERT INTO message_threads VALUES ('th', 'p', 't', 'u', 1, 10, 3, NULL);
  INSERT INTO messages VALUES ('m', 'p', 'th', 1, 't', 'moth', 'claude', 'cs', 'u', 'fox',
    'codex', NULL, 'hello', 3, 'delivered', 4, 0, 0, 0, 0, NULL);
  INSERT INTO asks VALUES ('a', 'p', 't', 5, '{}');
  INSERT INTO companion_windows VALUES ('w', 's', NULL, 6);
  INSERT INTO companion_items (id, session_id, terminal_id, window_id, pointer_key, kind,
    path, name, detail, held, shown_by, from_terminal, from_handle, version, asked, shown_at)
    VALUES ('bar', 's', 't', NULL, '/shop/a.ts', 'file', '/shop/a.ts', 'a.ts', '', 0,
      'agent', 't', 'moth', 1, 0, 7);
  INSERT INTO companion_items (id, session_id, terminal_id, window_id, pointer_key, kind,
    url, name, detail, held, shown_by, from_terminal, from_handle, version, asked, shown_at)
    VALUES ('undocked', 's', NULL, 'w', 'page:http://localhost/', 'page', 'http://localhost/',
      'localhost', '', 0, 'person', 't', 'moth', 2, 1, 8);
  INSERT INTO companion_items VALUES ('plan', 's', 't', NULL, 'plan:claude:cs:', 'plan',
    '/shop/plan.jsonl', 'http://unused/', 1, 2, 'claude', 'cs', '', 'text', 'Plan', 'Moth',
    1, 'agent', 't', 'moth', 3, 1, 9, 9.25);
`

// Something in every table a version 3 database has: version 2's rows, and a change, the
// kind version 3 added. Its tables have the same columns, so the rows are written alike.
const heldByVersion3 = `
  ${heldByVersion2}
  INSERT INTO companion_items (id, session_id, terminal_id, window_id, pointer_key, kind,
    path, name, detail, held, shown_by, from_terminal, from_handle, version, asked, shown_at)
    VALUES ('changes', 's', 't', NULL, 'changes:/shop', 'changes', '/shop', 'Shop', '2 files', 0,
      'agent', 't', 'moth', 1, 0, 10);
`

// A version 2 database holding `heldByVersion2` (less what `then` takes), set aside beside
// `path` at `time`, as v0.0.188 left it. Its foreign keys go unchecked, for `then` to break.
const setAsideOfVersion2 = (path: string, time: string, then = "") => {
  const aside = `${path}.earlier-${time}`
  const database = new DatabaseSync(aside, { enableForeignKeyConstraints: false })
  database.exec(`${readFileSync(new URL("schemas/2.sql", import.meta.url), "utf8")}
    PRAGMA user_version = 2;
    ${heldByVersion2}
    ${then}`)
  database.close()
  return aside
}

// The empty workspace v0.0.188 started in place of the one it set aside: version 3, with
// no projects, and the settings it was given.
const emptyOfVersion3 = (path: string, settings = "") => {
  const database = new DatabaseSync(path)
  database.exec(`${readFileSync(new URL("schemas/3.sql", import.meta.url), "utf8")}
    PRAGMA user_version = 3;
    ${settings}`)
  database.close()
}

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

// What `rowsOf` gave a database of version 3 or 2 as a version 6 holds it: its windows have
// a home, 'undocked', its threads hold none, and the rest is as it was.
const carried = ({ asks, ...rows }: ReturnType<typeof rowsOf>) => ({
  ...rows,
  inbox: asks!,
  message_threads: rows
    .message_threads!.map((row) => {
      const { id, project_id, first_terminal, second_terminal, hops, last_at, stopped_at } =
        JSON.parse(row)
      return JSON.stringify({
        id,
        project_id,
        first_terminal,
        second_terminal,
        hops,
        held_from: null,
        held_for: null,
        last_at,
        stopped_at,
      })
    })
    .toSorted(),
  companion_windows: rows
    .companion_windows!.map((row) => {
      const { id, session_id, person_title, created_at } = JSON.parse(row)
      return JSON.stringify({ id, session_id, home: "undocked", person_title, created_at })
    })
    .toSorted(),
})

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
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
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
    expect(session).toEqual({ id: sessionId, projectId, name: "Chosen", state: null })
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
    original.saveSession({ sessionId: session.id, state: '{"layout":1}' })
    original.saveSession({ sessionId: session.id, state: '{"layout":2}' })
    expect(() => original.saveSession({ sessionId: randomUUID(), state: "{}" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    original.close()
    const reopened = store(path)
    expect(reopened.session(session.id)).toEqual({ ...session, state: '{"layout":2}' })
    expect(reopened.sessions(project.id)).toEqual([{ ...session, state: '{"layout":2}' }])
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
    workspace.saveMessage(message("m-1", "queued"))
    workspace.saveMessage({ ...message("m-2", "queued"), projectId: kept.id, thread: "t-2" })
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

    workspace.removeProject(removed.id)
    expect(workspace.projects()).toEqual([kept])
    expect(() => workspace.session("s")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
    expect(workspace.terminals().map(({ id }) => id)).toEqual(["b"])
    expect(workspace.messages().map(({ id }) => id)).toEqual(["m-2"])
    expect(workspace.threads().map(({ id }) => id)).toEqual(["t-2"])
    // A session of the same id gives its words afresh; the other goes on.
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
      "CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('saved'); PRAGMA user_version = 7",
    )
    future.close()
    expect(() => new WorkspaceStore(path)).toThrow(/newer/)
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(7)
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
    // A newer build that also does without a table this runner would create.
    future.exec("ALTER TABLE terminals ADD COLUMN future_note TEXT; DROP TABLE session_handles")
    future.close()
    expect(() => new WorkspaceStore(path)).toThrow(WorkspaceTooNewError)
    const database = new DatabaseSync(path)
    try {
      const columns = database.prepare("SELECT name FROM pragma_table_info('terminals')").all()
      expect(columns).toContainEqual({ name: "future_note" })
      // Nothing was kept: the table this runner would have created is still absent.
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_handles'").get(),
      ).toBeUndefined()
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

  it("carries a version 2 database forward in place, keeping everything it held", ({
    directory,
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const old = new DatabaseSync(path)
    old.exec(`${readFileSync(new URL("schemas/2.sql", import.meta.url), "utf8")}
      PRAGMA user_version = 2;
      ${heldByVersion2}`)
    const before = rowsOf(old)
    old.close()

    const workspace = store(path)
    expect(workspace.projects()).toEqual([{ id: "p", name: "Shop", cwd: "/shop" }])
    expect(workspace.terminals("s").map(({ handle }) => handle)).toEqual(["moth"])
    expect(workspace.items("s").map(({ id }) => id)).toEqual(["bar", "undocked", "plan"])
    expect(workspace.messages().map(({ text }) => text)).toEqual(["hello"])
    workspace.close()

    const fresh = join(directory(), "fresh.sqlite")
    new WorkspaceStore(fresh).close()
    const database = new DatabaseSync(path)
    const reference = new DatabaseSync(fresh)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
      expect(rowsOf(database)).toEqual(carried(before))
      // Its tables are now those a new database gets, constraints and indexes too.
      expect(schemaOf(database)).toEqual(schemaOf(reference))
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      database.prepare("UPDATE companion_items SET kind = 'changes' WHERE id = 'bar'").run()
      expect(() =>
        database.prepare("UPDATE companion_items SET kind = 'video' WHERE id = 'bar'").run(),
      ).toThrow(/CHECK/)
    } finally {
      database.close()
      reference.close()
    }
  })

  it("carries a version 3 database forward in place, keeping everything it held", ({
    directory,
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const old = new DatabaseSync(path)
    old.exec(`${readFileSync(new URL("schemas/3.sql", import.meta.url), "utf8")}
      PRAGMA user_version = 3;
      ${heldByVersion3}`)
    const before = rowsOf(old)
    const order = ["companion_windows", "companion_items"].map((table) =>
      old.prepare(`SELECT rowid, id FROM ${table} ORDER BY rowid`).all(),
    )
    old.close()

    // Opened twice: the second finds it carried already.
    store(path).close()
    const workspace = store(path)
    expect(workspace.items("s").map(({ id }) => id)).toEqual(["bar", "undocked", "plan", "changes"])
    expect(workspace.windows("s").map(({ id, home }) => ({ id, home }))).toEqual([
      { id: "w", home: "undocked" },
    ])
    expect(workspace.items("s").every(({ from }) => from?.terminalId === "t")).toBe(true)
    workspace.close()

    const fresh = join(directory(), "fresh.sqlite")
    new WorkspaceStore(fresh).close()
    const database = new DatabaseSync(path)
    const reference = new DatabaseSync(fresh)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
      expect(rowsOf(database)).toEqual(carried(before))
      expect(
        ["companion_windows", "companion_items"].map((table) =>
          database.prepare(`SELECT rowid, id FROM ${table} ORDER BY rowid`).all(),
        ),
      ).toEqual(order)
      expect(schemaOf(database)).toEqual(schemaOf(reference))
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      // Nothing was left of the tables it was made from.
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%\\_3' ESCAPE '\\'")
          .all(),
      ).toEqual([])
    } finally {
      database.close()
      reference.close()
    }
  })

  it("carries a version 4 database forward in place, holding the threads that waited past their allowance", ({
    directory,
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const old = new DatabaseSync(path)
    old.exec(`${readFileSync(new URL("schemas/4.sql", import.meta.url), "utf8")}
      PRAGMA user_version = 4;
      INSERT INTO projects (position, id, name, cwd) VALUES (1, 'p', 'Shop', '/shop');
      INSERT INTO sessions (position, id, project_id, name, state) VALUES (1, 's', 'p', 'Main', '{}');
      INSERT INTO terminals (id, session_id, handle, cwd, agents, updated_at, summary, last_program)
        VALUES ('t', 's', 'moth', '/shop', '{}', 2, 'Works on checkout', 'claude');
      INSERT INTO session_handles VALUES ('s', 'moth');`)
    // A thread, allowed 5, and its messages: [hop, state, stopped, from_lead, to_lead].
    const thread = (
      id: string,
      allowed: number,
      messages: [number, string, number, number, number][],
    ) => {
      old.exec(
        `INSERT INTO message_threads VALUES ('${id}', 'p', 't', 'u', 9, ${allowed}, 3, NULL);`,
      )
      messages.forEach(([hop, state, stopped, fromLead, toLead], index) => {
        old.exec(`INSERT INTO messages VALUES ('${id}-${index}', 'p', '${id}', ${hop}, 't', 'moth',
          'claude', 'cs', 'u', 'fox', 'codex', NULL, 'text', 3, '${state}', NULL, 0, ${stopped},
          ${fromLead}, ${toLead}, NULL);`)
      })
    }
    thread("held", 5, [
      [5, "delivered", 0, 0, 0],
      [6, "held", 0, 0, 0],
    ])
    thread("gone", 5, [[7, "gone", 0, 0, 0]])
    thread("stopped", 5, [[6, "gone", 1, 0, 0]])
    thread("lead", 5, [
      [6, "held", 0, 1, 0],
      [7, "held", 0, 0, 1],
    ])
    thread("within", 5, [[5, "held", 0, 0, 0]])
    thread("delivered", 5, [[6, "delivered", 0, 0, 0]])
    const messages = old.prepare("SELECT * FROM messages ORDER BY id").all()
    old.close()

    // Opened twice: the second finds it carried already.
    store(path).close()
    store(path).close()

    const fresh = join(directory(), "fresh.sqlite")
    new WorkspaceStore(fresh).close()
    const database = new DatabaseSync(path)
    const reference = new DatabaseSync(fresh)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
      expect(
        database.prepare("SELECT id, held_from, held_for FROM message_threads ORDER BY id").all(),
      ).toEqual([
        { id: "delivered", held_from: null, held_for: null },
        { id: "gone", held_from: 6, held_for: null },
        { id: "held", held_from: 6, held_for: null },
        { id: "lead", held_from: null, held_for: null },
        { id: "stopped", held_from: null, held_for: null },
        { id: "within", held_from: null, held_for: null },
      ])
      expect(database.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(messages)
      expect(schemaOf(database)).toEqual(schemaOf(reference))
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%\\_4' ESCAPE '\\'")
          .all(),
      ).toEqual([])
    } finally {
      database.close()
      reference.close()
    }
    const workspace = store(path)
    expect(workspace.threads().find(({ id }) => id === "held")).toMatchObject({
      heldFrom: 6,
      heldFor: null,
    })
    workspace.close()
  })

  it("carries a version 3 database whose items reference what is gone, leaving those behind", ({
    directory,
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    // Rows only a database written with foreign keys off could hold: an item on a closed
    // terminal's bar, one in a window that is gone, a window of a deleted session, and a
    // window whose only item belongs to a deleted session, which leaves it showing nothing.
    const old = new DatabaseSync(path, { enableForeignKeyConstraints: false })
    old.exec(`${readFileSync(new URL("schemas/3.sql", import.meta.url), "utf8")}
      PRAGMA user_version = 3;
      ${heldByVersion3}
      INSERT INTO companion_windows VALUES ('lost', 'gone', NULL, 13);
      INSERT INTO companion_windows VALUES ('empty', 's', NULL, 14);
      INSERT INTO companion_items (id, session_id, terminal_id, window_id, pointer_key, kind,
        path, name, detail, held, shown_by, from_terminal, from_handle, version, asked, shown_at)
        VALUES ('closed', 's', 'u', NULL, '/shop/b.ts', 'file', '/shop/b.ts', 'b.ts', '', 0,
          'agent', 'u', 'fox', 1, 0, 14),
        ('stray', 's', NULL, 'nowhere', '/shop/c.ts', 'file', '/shop/c.ts', 'c.ts', '', 0,
          'person', 't', 'moth', 1, 0, 15),
        ('stranded', 'gone', NULL, 'empty', '/shop/d.ts', 'file', '/shop/d.ts', 'd.ts', '', 0,
          'person', 't', 'moth', 1, 0, 16);`)
    old.close()

    const workspace = store(path)
    expect(workspace.items("s").map(({ id }) => id)).toEqual(["bar", "undocked", "plan", "changes"])
    expect(workspace.windows().map(({ id }) => id)).toEqual(["w"])
    workspace.close()
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
    } finally {
      database.close()
    }
  })

  it("holds a session to one project window, and an item to a terminal or none", ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const old = new DatabaseSync(path)
    old.exec(`${readFileSync(new URL("schemas/3.sql", import.meta.url), "utf8")}
      PRAGMA user_version = 3;
      ${heldByVersion3}`)
    old.close()
    new WorkspaceStore(path).close()

    const database = new DatabaseSync(path)
    const projectItem = (id: string, window: string, from: string) => `
      INSERT INTO companion_windows (id, session_id, home, created_at)
        VALUES ('${window}', 's', 'project', 11);
      INSERT INTO companion_items (id, session_id, terminal_id, window_id, pointer_key, kind,
        path, name, detail, held, shown_by, from_terminal, from_handle, version, asked, shown_at)
        VALUES ('${id}', 's', NULL, '${window}', '/shop/${id}', 'file', '/shop/${id}', '${id}',
          '', 0, 'person', ${from}, 1, 1, 12);`
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
        count: 2,
      })
    } finally {
      database.close()
    }
  })

  it("sets aside, unchanged, a database whose step forward fails", ({ directory }) => {
    const path = join(directory(), "workspace.sqlite")
    // An item whose session is gone, which a database kept with its foreign keys can't hold.
    const old = new DatabaseSync(path, { enableForeignKeyConstraints: false })
    old.exec(`${readFileSync(new URL("schemas/2.sql", import.meta.url), "utf8")}
      PRAGMA user_version = 2;
      ${heldByVersion2}
      DELETE FROM sessions;`)
    old.close()
    expect(() => new WorkspaceStore(path)).toThrow(
      /earlier build: carrying it from version 2 failed \(FOREIGN KEY constraint failed\)\./,
    )
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(2)
      expect(database.prepare("SELECT count(*) AS count FROM companion_items").get()).toEqual({
        count: 3,
      })
      expect(
        database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'companion_items'").get()?.sql,
      ).toContain("'image', 'file', 'page', 'plan')")
    } finally {
      database.close()
    }
  })

  it("brings back the workspace v0.0.188 set aside, in place of the empty one it started", ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const earlier = setAsideOfVersion2(path, "2026-10-22T07-00-00-000Z")
    // The person turned transcripts off in the empty one since.
    emptyOfVersion3(path, "INSERT INTO settings VALUES ('transcripts', 'false');")
    const held = readFileSync(earlier)

    expect(restoreSetAside(path, new Date("2026-10-22T09:00:00.000Z"))).toBe(earlier)
    const workspace = new WorkspaceStore(path)
    try {
      expect(workspace.projects()).toEqual([{ id: "p", name: "Shop", cwd: "/shop" }])
      expect(workspace.items("s").map(({ id }) => id)).toEqual(["bar", "undocked", "plan"])
      expect(workspace.settings().transcripts).toBe(false)
    } finally {
      workspace.close()
    }
    // The one set aside stays as it was, and the empty one went aside in turn.
    expect(readFileSync(earlier).equals(held)).toBe(true)
    expect(existsSync(`${path}.earlier-2026-10-22T09-00-00-000Z`)).toBe(true)
    expect(existsSync(`${path}.restoring`)).toBe(false)
    // It now holds its projects, so nothing is brought back again.
    expect(restoreSetAside(path)).toBeUndefined()
    // Nor once the person removes them: the newest set aside is now the empty one.
    const emptied = new WorkspaceStore(path)
    emptied.removeProject("p")
    emptied.close()
    expect(restoreSetAside(path)).toBeUndefined()
  })

  it("brings one back where a start since carried the empty workspace to version 6", ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const earlier = setAsideOfVersion2(path, "2026-10-22T07-00-00-000Z")
    emptyOfVersion3(path)
    new WorkspaceStore(path).close()
    expect(restoreSetAside(path, new Date("2026-10-22T09:00:00.000Z"))).toBe(earlier)
    const workspace = new WorkspaceStore(path)
    try {
      expect(workspace.projects().map(({ id }) => id)).toEqual(["p"])
    } finally {
      workspace.close()
    }
  })

  it("finishes bringing one back where a crash cut the swap short", ({ directory }) => {
    const path = join(directory(), "workspace.sqlite")
    setAsideOfVersion2(path, "2026-10-22T07-00-00-000Z")
    emptyOfVersion3(path)
    expect(restoreSetAside(path, new Date("2026-10-22T09:00:00.000Z"))).toBeDefined()
    // As a crash after the empty one went aside would leave it: the copy, and no workspace.
    renameSync(path, `${path}.restoring`)
    expect(restoreSetAside(path)).toBe(`${path}.restoring`)
    const workspace = new WorkspaceStore(path)
    try {
      expect(workspace.projects().map(({ id }) => id)).toEqual(["p"])
    } finally {
      workspace.close()
    }
  })

  it("brings back nothing but in place of the empty workspace v0.0.188 started", ({
    directory,
  }) => {
    // No data folder yet, as on a first start.
    expect(restoreSetAside(join(directory(), "missing", "workspace.sqlite"))).toBeUndefined()
    // No workspace where one was set aside.
    const path = join(directory(), "workspace.sqlite")
    setAsideOfVersion2(path, "2026-10-22T07-00-00-000Z")
    expect(restoreSetAside(path)).toBeUndefined()
    expect(existsSync(path)).toBe(false)
    // A newer build's empty one.
    const newer = new DatabaseSync(path)
    newer.exec("CREATE TABLE projects (id TEXT); PRAGMA user_version = 6")
    newer.close()
    expect(restoreSetAside(path)).toBeUndefined()
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
    } finally {
      database.close()
    }
  })

  it("leaves a workspace set aside where the one in its place holds projects", async ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    setAsideOfVersion2(path, "2026-10-22T07-00-00-000Z")
    const workspace = new WorkspaceStore(path)
    await workspace.createProject({ id: "new", name: "Started again", cwd: directory() })
    workspace.close()
    expect(restoreSetAside(path)).toBeUndefined()
    const reopened = new WorkspaceStore(path)
    try {
      expect(reopened.projects().map(({ id }) => id)).toEqual(["new"])
    } finally {
      reopened.close()
    }
  })

  it("brings back only the newest set aside, and only one that carries forward", ({
    directory,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    emptyOfVersion3(path)
    // An older version 2 one, then a version 1 one set aside since: neither comes back.
    setAsideOfVersion2(path, "2026-10-14T07-00-00-000Z")
    const version1 = new DatabaseSync(`${path}.earlier-2026-10-15T07-00-00-000Z`)
    version1.exec("CREATE TABLE projects (id TEXT); PRAGMA user_version = 1")
    version1.close()
    expect(restoreSetAside(path)).toBeUndefined()

    // A version 2 one whose step doesn't fit it.
    const unfit = setAsideOfVersion2(path, "2026-10-22T07-00-00-000Z", "DELETE FROM sessions;")
    const held = readFileSync(unfit)
    expect(restoreSetAside(path)).toBeUndefined()
    expect(readFileSync(unfit).equals(held)).toBe(true)
    expect(existsSync(`${path}.restoring`)).toBe(false)
    const workspace = new WorkspaceStore(path)
    try {
      expect(workspace.projects()).toEqual([])
    } finally {
      workspace.close()
    }
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
      // A change to a table's columns or constraints raises schemaVersion and adds a step
      // in store.ts's migrations, from schemas/<version before>.sql, which is added for
      // it; a new table needs neither. Then record the new digest here.
      expect({ version, digest }).toEqual({
        version: 6,
        digest: "ee9624dccc4b364c71ad51d5f5ca75cee4b602ca004d1f5c6ac0dce709be2811",
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
    const old = new DatabaseSync(path)
    // Numbered handles' tables had the same columns; only the version tells them apart.
    old.exec(`
      PRAGMA user_version = 1;
      INSERT INTO terminals (id, session_id, cwd, agents, updated_at, handle)
        VALUES ('a', 's', '/', '{}', 1, 't3');
    `)
    old.close()
    expect(() => new WorkspaceStore(path)).toThrow(
      /earlier build: its schema is version 1, from before Novadeck carried workspaces forward\./,
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
    // The terminals table as main's runner writes it, before handles and titles.
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
    expect(message).toContain("expects handle TEXT NOT NULL")
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
  naming: { person: null, agent: null, murmur: null, summary: null },
  openedBy: null,
  ledBy: null,
  command: null,
  lastProgram: null,
  work: null,
})

describe("saved terminals", () => {
  it("keep what a session was doing in its agent's report, and read a row saved without it as having none", async ({
    directory,
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const first = store(path)
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
      INSERT INTO terminals (id, session_id, cwd, agents, updated_at, handle)
        VALUES ('c', 's', '/', '{"claude":{"sessionId":"old","seq":1}}', 1, 'fox');
    `)
    raw.close()
    const reopened = store(path)
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
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const first = store(path)
    const terminal = {
      id: randomUUID(),
      sessionId: randomUUID(),
      cwd: "/work",
      agents: { claude: { sessionId: "abc", seq: 2 } },
      promptedAt: 1_000,
      handle: "owl",
      naming: {
        person: null,
        agent: { title: "API author", by: "moth" },
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
    const reopened = store(path)
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
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const shape = sealedShape
    const first = store(path)
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

    const next = store(path)
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
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = store(path)
    const agent = { title: "Server", by: "moth" }
    const murmur = { title: "Fixing login" }
    const summary = "Fixes the login bug."
    workspace.saveTerminal({
      ...numbered("a", "fox"),
      naming: { person: "Mine", agent, murmur, summary },
    })
    expect(workspace.terminal("a")?.naming).toEqual({ person: "Mine", agent, murmur, summary })
    // Taking the person's title away leaves the other layers.
    expect(workspace.renameTerminal("a", null)).toBe(true)
    expect(workspace.terminalIdentity("a")?.naming).toEqual({
      person: null,
      agent,
      murmur,
      summary,
    })
    // The summary and murmur's title change apart.
    const next = { title: "Fixing signup" }
    workspace.saveTerminal({
      ...numbered("a", "fox"),
      naming: { person: null, agent, murmur: next, summary },
    })
    expect(workspace.terminals().map(({ naming }) => naming)).toEqual([
      { person: null, agent, murmur: next, summary },
    ])
    workspace.saveTerminal({
      ...numbered("a", "fox"),
      naming: { person: null, agent, murmur: null, summary: null },
    })
    expect(workspace.terminal("a")?.naming).toEqual({
      person: null,
      agent,
      murmur: null,
      summary: null,
    })
    workspace.close()
  })

  it("overwrite what they forget, which may hold secrets, and empty their log after", async ({
    directory,
    store,
  }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const cwd = directory()
      const path = join(cwd, "workspace.sqlite")
      const workspace = store(path)
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
            const sent = { ...message(id, "queued"), projectId: project.id }
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
            const kept = item(session.id, keptTerminal(workspace, session.id, "haze"), "/work/x")
            workspace.saveItem({ ...kept, detail: "SECRET_ITEM_DETAIL" })
            workspace.removeItem(kept.id)
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
            const naming = { person: null, agent: null, summary: null }
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
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = store(path)
    workspace.saveTerminal({
      id: randomUUID(),
      sessionId: "s",
      cwd: "/",
      agents: {},
      promptedAt: null,
      handle: "moth",
      naming: { person: null, agent: null, murmur: null, summary: null },
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
    store,
  }) => {
    const workspace = store()
    const ids = Array.from({ length: 130 }, () => randomUUID())
    for (const [index, id] of ids.entries())
      workspace.saveTerminal({
        id,
        sessionId: index % 2 ? "odd" : "even",
        cwd: "/",
        agents: {},
        promptedAt: null,
        handle: `moth${index + 1}`,
        naming: { person: null, agent: null, murmur: null, summary: null },
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
    store,
  }) => {
    const workspace = store()
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
    store,
  }) => {
    const workspace = store()
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
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const order = handleOrder("s")
    const first = store(path)
    expect(first.giveHandle("s")).toBe(order[0])
    expect(first.giveHandle("s")).toBe(order[1])
    first.saveTerminal({
      id: "a",
      sessionId: "s",
      cwd: "/",
      agents: {},
      promptedAt: null,
      handle: order[0]!,
      naming: { person: null, agent: null, murmur: null, summary: null },
      openedBy: null,
      ledBy: null,
      command: null,
      lastProgram: null,
      work: null,
    })
    expect(first.renameTerminal("a", "API author")).toBe(true)
    expect(first.renameTerminal("missing", "x")).toBe(false)
    first.close()
    const reopened = store(path)
    expect(reopened.terminal("a")?.naming).toEqual({
      person: "API author",
      agent: null,
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
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const first = store(path)
    const moth = first.giveHandle("s")
    first.saveTerminal(numbered("a", moth))
    const fox = first.giveHandle("s")
    first.saveTerminal(numbered("b", fox))
    first.removeTerminal("a")
    first.close()
    const reopened = store(path)
    const next = reopened.giveHandle("s")
    const order = handleOrder("s")
    expect([moth, fox]).toEqual(order.slice(0, 2))
    expect(next).toBe(order[2])
    expect([moth, fox, next]).not.toContain(order[3])
  })

  it("prefer a word whose letter no open terminal of the session starts with, whatever other sessions have open", ({
    store,
  }) => {
    const workspace = store()
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

  it("number the words again once a session has given them all", ({ store }) => {
    const workspace = store()
    const all = handleWords.map(() => workspace.giveHandle("s"))
    expect(new Set(all)).toEqual(new Set(handleWords))
    expect(workspace.giveHandle("s")).toMatch(/^[a-z]+2$/)
  })

  it("refuse two terminals with one handle in a session", ({ store }) => {
    const workspace = store()
    workspace.saveTerminal(numbered("a", "moth"))
    expect(() => workspace.saveTerminal(numbered("b", "moth"))).toThrow(/UNIQUE/)
    workspace.saveTerminal({ ...numbered("b", "moth"), sessionId: "other" })
    expect(workspace.terminals().map(({ id }) => id)).toEqual(["a", "b"])
  })

  it("keep transcripts until they are turned off", ({ store }) => {
    const workspace = store()
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
  from: { terminalId: "a", handle: "moth", agent: null, sessionId: null },
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
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const original = store(path)
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
      naming: { person: null, agent: null, murmur: null, summary: null },
      openedBy: null,
      ledBy: null,
      command: null,
      lastProgram: null,
      work: null,
    })
    original.close()
    const reopened = store(path)
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
    reopened.removeThreads(["t-1"])
    reopened.pauseMessaging(false)
    expect(reopened.messages().map(({ id }) => id)).toEqual(["m-2", "m-3", "m-4"])
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
    naming: { person: null, agent: null, murmur: null, summary: null },
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
  held: false,
  by: "agent",
  from: { terminalId, handle: "moth" },
  version: 1,
  asked: false,
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
    projectId: randomUUID(),
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
    store,
  }) => {
    const workspace = store(join(directory(), "workspace.sqlite"))
    const [a, b] = [entry(1), entry(2)]
    workspace.saveEntries([a!, b!])
    expect(workspace.entries().map(({ id }) => id)).toEqual([a!.id, b!.id])
    const broken = { ...entry(3), content: 1n } as never
    expect(() => workspace.saveEntries([entry(3), broken])).toThrow()
    expect(workspace.entries()).toHaveLength(2)
  })

  it("removes several entries as one transaction", ({ directory, store }) => {
    const workspace = store(join(directory(), "workspace.sqlite"))
    const all = [entry(1), entry(2), entry(3)]
    workspace.saveEntries(all)
    workspace.removeEntries([all[0]!.id, all[2]!.id])
    expect(workspace.entries().map(({ id }) => id)).toEqual([all[1]!.id])
  })
})

describe("the Inbox table's rename", () => {
  it("carries a version 5 database's asks table to inbox, its rows unchanged", ({ directory }) => {
    const path = join(directory(), "workspace.sqlite")
    const record = JSON.stringify({
      id: "e",
      terminalId: "t",
      projectId: "p",
      workspaceSessionId: "s",
      agent: "claude",
      sessionId: "cs",
      handle: "moth",
      at: 5,
      state: "open",
      content: { kind: "tell", subject: "Hi", body: "There" },
    })
    const old = new DatabaseSync(path)
    old.exec(`${readFileSync(new URL("schemas/5.sql", import.meta.url), "utf8")}
      PRAGMA user_version = 5;
      INSERT INTO asks VALUES ('e', 'p', 't', 5, '${record}');`)
    old.close()
    const workspace = new WorkspaceStore(path)
    try {
      expect(workspace.entries().map(({ id }) => id)).toEqual(["e"])
      expect(workspace.entries()[0]).toEqual(JSON.parse(record))
    } finally {
      workspace.close()
    }
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
      expect(
        database
          .prepare("SELECT * FROM inbox")
          .all()
          .map((row) => ({ ...row })),
      ).toEqual([{ id: "e", project_id: "p", terminal_id: "t", at: 5, record }])
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name = 'asks'").get(),
      ).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it.for([2, 5])(
    "doesn't need a version %i database to have the asks table",
    (version, { directory }) => {
      const path = join(directory(), "workspace.sqlite")
      const old = new DatabaseSync(path)
      old.exec(`${readFileSync(new URL(`schemas/${version}.sql`, import.meta.url), "utf8")}
        DROP TABLE asks;
        PRAGMA user_version = ${version};
        INSERT INTO projects (position, id, name, cwd) VALUES (1, 'p', 'Shop', '/shop');`)
      old.close()
      const workspace = new WorkspaceStore(path)
      try {
        expect(workspace.projects().map(({ id }) => id)).toEqual(["p"])
        expect(workspace.entries()).toEqual([])
      } finally {
        workspace.close()
      }
      const database = new DatabaseSync(path)
      try {
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
        expect(
          database.prepare("SELECT name FROM sqlite_schema WHERE name = 'asks'").get(),
        ).toBeUndefined()
      } finally {
        database.close()
      }
    },
  )
})

describe("the snapshot taken before a migration", () => {
  const writeOld = (path: string, version = 5) => {
    const old = new DatabaseSync(path)
    old.exec(`${readFileSync(new URL(`schemas/${version}.sql`, import.meta.url), "utf8")}
      DROP TABLE asks;
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
    expect(name).toMatch(/^workspace-v5-[\dTZ-]+\.sqlite$/)
    const copy = new DatabaseSync(join(path, "..", "snapshots", name ?? ""), {
      readOnly: true,
    })
    try {
      expect(copy.prepare("PRAGMA user_version").get()?.user_version).toBe(5)
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
    expect(kept.some((name) => name.startsWith("workspace-v5-"))).toBe(true)
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
