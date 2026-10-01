import { randomUUID } from "node:crypto"
import {
  chmodSync,
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

import { DomainError } from "../errors.js"
import type { Message, Thread } from "../messaging/mailbox.js"
import { describe, expect, it as base } from "../test.js"
import { WorkspaceStore } from "./store.js"

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
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1)
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
    ]
    for (const operation of operations) {
      expect(operation).toThrow(DomainError)
      expect(operation).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
    }
    expect(workspace.projects()).toEqual([])
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
      "CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('saved'); PRAGMA user_version = 2",
    )
    future.close()
    expect(() => new WorkspaceStore(path)).toThrow(/newer/)
    const database = new DatabaseSync(path)
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(2)
      expect(database.prepare("SELECT value FROM future_data").get()?.value).toBe("saved")
    } finally {
      database.close()
    }
  })

  it("refuses a database an earlier build wrote, naming it and saying to delete it", ({
    directory,
  }) => {
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
    expect(message).toContain("delete that file")
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
  title: `Terminal ${handle}`,
  titledBy: null,
  openedBy: null,
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
      handle: "t3",
      title: "API author",
      titledBy: "t1",
      openedBy: "t2",
      command: "claude",
      lastProgram: "claude",
      work: {
        session: "claude:abc",
        first: "Build the users API",
        latest: "Now add paging",
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
      handle: "t3",
      title: "API author",
      titledBy: "t1",
      // Who opened it with a task survives a reload, as who titled it does.
      openedBy: "t2",
    })
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
    reopened.clearTranscripts()
    expect(reopened.terminal(terminal.id)?.transcript).toBeNull()
    reopened.removeTerminal(terminal.id)
    expect(reopened.terminal(terminal.id)).toBeUndefined()
  })

  it("overwrite forgotten transcripts, which may hold secrets", ({ directory, store }) => {
    const path = join(directory(), "workspace.sqlite")
    const workspace = store(path)
    const terminal = {
      id: randomUUID(),
      sessionId: "s",
      cwd: "/",
      agents: {},
      promptedAt: null,
      handle: "t1",
      title: "Terminal 01",
      titledBy: null,
      openedBy: null,
      command: null,
      lastProgram: null,
      work: null,
    }
    workspace.saveTerminal({ ...terminal, transcript: "SECRET_TRANSCRIPT_TEXT" })
    workspace.clearTranscripts()
    workspace.close()
    expect(readFileSync(path).includes("SECRET_TRANSCRIPT_TEXT")).toBe(false)
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
        handle: `t${index + 1}`,
        title: `Terminal ${index}`,
        titledBy: null,
        openedBy: null,
        command: null,
        lastProgram: null,
        work: null,
      })
    expect(workspace.terminal(ids[0]!)).toBeDefined()
    expect(workspace.terminals()).toHaveLength(130)
    expect(workspace.terminals("odd").map(({ id }) => id)).toEqual(ids.filter((_, i) => i % 2))
    expect(workspace.terminals("odd")[0]).not.toHaveProperty("transcript")
  })

  it("list a session's terminals by number, the order they were asked for, whenever saved", ({
    store,
  }) => {
    const workspace = store()
    // Asked for in order, their shells started the other way round.
    for (const [id, handle] of [
      ["b", "t2"],
      ["j", "t10"],
      ["a", "t1"],
    ] as const)
      workspace.saveTerminal(numbered(id, handle))
    expect(workspace.terminals("s").map(({ id }) => id)).toEqual(["a", "b", "j"])
    expect(workspace.terminals().map(({ id }) => id)).toEqual(["a", "b", "j"])
  })

  it("rename a kept terminal, and number each session's terminals without reuse", ({
    directory,
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const first = store(path)
    expect(first.nextTerminalNumber("s")).toBe(1)
    expect(first.nextTerminalNumber("s")).toBe(2)
    expect(first.nextTerminalNumber("t")).toBe(1)
    first.saveTerminal({
      id: "a",
      sessionId: "s",
      cwd: "/",
      agents: {},
      promptedAt: null,
      handle: "t1",
      title: "Terminal 01",
      titledBy: null,
      openedBy: null,
      command: null,
      lastProgram: null,
      work: null,
    })
    expect(first.renameTerminal("a", "API author")).toBe(true)
    expect(first.renameTerminal("missing", "x")).toBe(false)
    first.close()
    const reopened = store(path)
    expect(reopened.terminal("a")?.title).toBe("API author")
    expect(reopened.nextTerminalNumber("s")).toBe(3)
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
  from: { terminalId: "a", handle: "t1", agent: null, sessionId: null },
  to: { terminalId: "b", handle: "t2", agent: "codex", sessionId: "s" },
  text: "Review a.ts\n\twith care",
  sentAt: 1.5,
  state,
  deliveredAt: null,
  notified: false,
})

describe("the mailbox", () => {
  it("keeps messages, threads and the pause across reopen, until removed", ({
    directory,
    store,
  }) => {
    const path = join(directory(), "workspace.sqlite")
    const original = store(path)
    original.saveMessage(message("m-1", "queued"))
    original.saveMessage(message("m-2", "held"))
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
      handle: "t1",
      title: "Terminal 01",
      titledBy: null,
      openedBy: null,
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
      message("m-2", "held"),
      { ...waiting, to: { ...waiting.to, sessionId: null } },
    ])
    expect(reopened.threads()).toEqual([{ ...thread, allowed: 14 }])
    expect(reopened.messagingPaused()).toBe(true)
    // The pause is the runner's own, not one of the client's settings.
    expect(reopened.settings()).toEqual({ transcripts: true, welcomed: false })
    expect(reopened.terminalIdentity("a")).toMatchObject({ handle: "t1" })
    expect(reopened.terminalIdentity("b")).toBeUndefined()
    reopened.removeMessages(["m-1"])
    reopened.removeThreads(["t-1"])
    reopened.pauseMessaging(false)
    expect(reopened.messages().map(({ id }) => id)).toEqual(["m-2", "m-3"])
    expect(reopened.threads()).toEqual([])
    expect(reopened.messagingPaused()).toBe(false)
  })
})
