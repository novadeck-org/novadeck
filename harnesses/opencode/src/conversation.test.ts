import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import type { Install } from "@novadeck/harness-core/harness"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { conversation, conversations, databasePath } from "./conversation.js"

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "novadeck-opencode-conversation-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const install = (env: NodeJS.ProcessEnv = {}): Install => ({
  env,
  home,
  // The host's own: its temporary folders are its paths.
  platform: process.platform,
  plugin: join(home, "plugin"),
})
const dataDir = () => join(home, ".local", "share", "opencode")
const alive = "ses_dfcf2f964ffeWSXP0XEYhnGmzx"
const other = "ses_dfcef7a25ffeBQ337jh2e91hH1"

// The table as opencode 1.19.6 makes it, in WAL mode as it keeps it.
const database = (file = join(dataDir(), "opencode.db"), sessions = [alive]) => {
  mkdirSync(dataDir(), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(
    "CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, directory text NOT NULL)",
  )
  for (const id of sessions) db.prepare("INSERT INTO session VALUES (?, 'p', '/x')").run(id)
  db.close()
}

describe("whether an opencode session still exists", () => {
  it("is found for a row of its database, gone for none, and read without writing", async () => {
    database()
    expect(await conversation(install(), alive)).toBe("found")
    expect(await conversation(install(), other)).toBe("gone")
  })

  it("is unknown where there is no database yet, or it has no session table", async () => {
    expect(await conversation(install(), alive)).toBe("unknown")
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(join(dataDir(), "opencode.db"), "not a database")
    expect(await conversation(install(), alive)).toBe("unknown")
  })

  it("is gone for an id of any shape the database has no row for", async () => {
    database()
    expect(await conversation(install(), "../x")).toBe("gone")
    expect(await conversation(install(), "x' OR 1=1 --")).toBe("gone")
  })

  it("follows OPENCODE_DB and XDG_DATA_HOME", async () => {
    database(join(home, "mine.db"), [other])
    const env = { OPENCODE_DB: join(home, "mine.db") }
    expect(await conversation(install(env), other)).toBe("found")
    expect(await conversation(install(env), alive)).toBe("gone")
    expect(databasePath(install({ OPENCODE_DB: ":memory:" }))).toBeUndefined()
    expect(databasePath(install({ OPENCODE_DB: "x.db", XDG_DATA_HOME: "/d" }))).toBe(
      "/d/opencode/x.db",
    )
  })

  it("reads many rows of a list from one pass over its database", async () => {
    database(undefined, [alive, other])
    const scan = conversations(install())
    expect(await scan.conversation(alive)).toBe("found")
    // Rows added after the pass began are not in it.
    const db = new DatabaseSync(join(dataDir(), "opencode.db"))
    db.prepare("INSERT INTO session VALUES ('ses_newer0000000', 'p', '/x')").run()
    db.close()
    expect(await scan.conversation("ses_newer0000000")).toBe("gone")
    expect(await scan.conversation(other)).toBe("found")
  })

  it("doesn't wait for a database another process is writing", async () => {
    database()
    const writer = new DatabaseSync(join(dataDir(), "opencode.db"))
    writer.exec("BEGIN IMMEDIATE")
    writer.prepare("INSERT INTO session VALUES ('ses_pending00000', 'p', '/x')").run()
    try {
      expect(await conversation(install(), alive)).toBe("found")
      expect(await conversation(install(), "ses_pending00000")).toBe("gone")
    } finally {
      writer.exec("ROLLBACK")
      writer.close()
    }
  })
})
