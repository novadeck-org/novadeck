import { randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import type { Message, Thread } from "../messaging/mailbox.js"
import { handleWords } from "../terminals/handles.js"
import { describe, expect, it as base } from "../test.js"
import {
  EarlierWorkspaceError,
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
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(2)
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
    workspace.giveHandle(other.id)
    workspace.saveMessage(message("m-1", "queued"))
    workspace.saveMessage({ ...message("m-2", "queued"), projectId: kept.id, thread: "t-2" })
    const thread: Thread = {
      id: "t-1",
      projectId: removed.id,
      between: ["a", "b"],
      hops: 1,
      allowed: 12,
      lastAt: 1,
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
    expect(workspace.giveHandle(other.id)).not.toBe(handleWords[0])
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
      "CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('saved'); PRAGMA user_version = 3",
    )
    future.close()
    expect(() => new WorkspaceStore(path)).toThrow(/newer/)
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(3)
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
      /earlier build: its schema is version 1, before 2\./,
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
        recent: ["Build the users API", "Now add paging"],
        folders: { "/work/src": 4 },
        activeAt: 2_000,
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
            const thread = { projectId: project.id, between, hops: 1, allowed: 12, lastAt: 1 }
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
    const first = store(path)
    expect(first.giveHandle("s")).toBe(handleWords[0])
    expect(first.giveHandle("s")).toBe(handleWords[1])
    first.saveTerminal({
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
    expect(reopened.giveHandle("s")).toBe(handleWords[2])
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
    expect([moth, fox]).toEqual(handleWords.slice(0, 2))
    expect(next).toBe(handleWords[2])
    expect([moth, fox, next]).not.toContain(handleWords[3])
  })

  it("prefer a word whose letter no open terminal of the session starts with, then one open nowhere else", ({
    store,
  }) => {
    const workspace = store()
    // "fox" and "mink" are open in another session.
    workspace.saveTerminal({ ...numbered("b", "fox"), sessionId: "elsewhere" })
    workspace.saveTerminal({
      ...numbered("c", "mink"),
      sessionId: "elsewhere",
    })
    expect(workspace.giveHandle("s")).toBe("moth")
    workspace.saveTerminal(numbered("a", "moth"))
    // "fox" is open elsewhere, so "owl" comes first; "mink" would share "moth"'s letter.
    expect(workspace.giveHandle("s")).toBe("owl")
    workspace.saveTerminal(numbered("d", "owl"))
    // Closing "moth" frees its letter, but the word is never given again.
    workspace.removeTerminal("a")
    expect(workspace.giveHandle("s")).toBe("crow")
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
  fromLead: false,
  toLead: false,
})

describe("the mailbox", () => {
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
      allowed: 12,
      lastAt: 3,
    }
    original.saveThread(thread)
    original.saveThread({ ...thread, allowed: 14 })
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
    ])
    expect(reopened.threads()).toEqual([{ ...thread, allowed: 14 }])
    expect(reopened.messagingPaused()).toBe(true)
    // The pause is the runner's own, not one of the client's settings.
    expect(reopened.settings()).toEqual({ transcripts: true, welcomed: false })
    expect(reopened.terminalIdentity("a")).toMatchObject({ handle: "moth" })
    expect(reopened.terminalIdentity("b")).toBeUndefined()
    reopened.removeMessages(["m-1"])
    reopened.removeThreads(["t-1"])
    reopened.pauseMessaging(false)
    expect(reopened.messages().map(({ id }) => id)).toEqual(["m-2", "m-3"])
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
})
