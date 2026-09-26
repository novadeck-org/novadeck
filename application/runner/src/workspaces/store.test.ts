import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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
    const first = await original.createProject({ name: "Zebra", cwd })
    const second = await original.createProject({ name: "Alpha", cwd })
    const initial = original.createSession({ projectId: first.id, name: "Zebra" })
    const next = original.createSession({ projectId: first.id, name: "Alpha" })
    const other = original.createSession({ projectId: second.id, name: "Other project" })
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

  it("rejects missing projects and sessions without creating orphan records", ({ store }) => {
    const workspace = store()
    const operations = [
      () => workspace.project("missing"),
      () => workspace.sessions("missing"),
      () => workspace.createSession({ projectId: "missing", name: "Orphan" }),
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
    const project = await store().createProject({ name: "Project", cwd: link })
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
        expect(workspace.createProject({ name: "Invalid", cwd: path })).rejects.toMatchObject({
          code: "INVALID_DIRECTORY",
        }),
      ),
    )
    expect(workspace.projects()).toEqual([])
  })

  it("rejects empty and oversized names at the storage boundary", async ({ directory, store }) => {
    const cwd = directory()
    const workspace = store()
    const project = await workspace.createProject({ name: "Project", cwd })
    const session = workspace.createSession({ projectId: project.id, name: "Session" })
    const names = ["", "x".repeat(201)]
    await Promise.all(
      names.map((name) => expect(workspace.createProject({ name, cwd })).rejects.toThrow(/CHECK/)),
    )
    for (const name of names) {
      expect(() => workspace.createSession({ projectId: project.id, name })).toThrow(/CHECK/)
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
