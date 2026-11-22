import { DatabaseSync } from "node:sqlite"

import { presence, rulesOf, type Conversation } from "@novadeck/harness-core/conversation"
import type { ConversationScan } from "@novadeck/harness-core/conversation"
import type { Harness, Install } from "@novadeck/harness-core/harness"

import { dirs } from "./home.js"

/**
 * Its database: the file `OPENCODE_DB` names (relative to its data folder), else
 * `<data>/opencode.db` (core/src/database/database.ts:43-53, 1.19.6; a development channel's build
 * keeps `opencode-<channel>.db`, which Novadeck doesn't look for). `:memory:` has no file.
 */
export const databasePath = (
  install: Pick<Install, "env" | "home" | "platform">,
): string | undefined => {
  const rules = rulesOf(install)
  const { data } = dirs(install)
  const named = install.env.OPENCODE_DB
  if (named === ":memory:") return undefined
  if (named) return rules.isAbsolute(named) ? named : rules.join(data, named)
  return rules.join(data, "opencode.db")
}

/**
 * Reads the `session` table of the database, read-only and for the moment of one query: opencode
 * keeps it in WAL mode, where a reader never blocks its writer (storage/db.ts: `journal_mode =
 * WAL`), and nothing here writes or checkpoints. `node:sqlite` is in the runner's Node, as in
 * Electron's utility process (the workspace store uses it too). Anything it can't do (a missing
 * table, a locked file, a folder it can't write the WAL's index in) is `undefined`.
 */
const read = <T>(path: string, use: (database: DatabaseSync) => T): T | undefined => {
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 250 })
    return use(database)
  } catch {
    return undefined
  } finally {
    try {
      database?.close()
    } catch {
      // Nothing to release.
    }
  }
}

/** Whether `session` is a row of the database; undefined where that can't be told. */
const has = (path: string, session: string): boolean | undefined =>
  read(
    path,
    (database) => database.prepare("SELECT 1 FROM session WHERE id = ?").get(session) !== undefined,
  )

/** Every session id of the database; undefined where that can't be told. */
const all = (path: string): Set<string> | undefined =>
  read(
    path,
    (database) =>
      new Set(
        database
          .prepare("SELECT id FROM session")
          .all()
          .map((row) => String(row.id)),
      ),
  )

/**
 * A session is a row of its database, and that row decides: `opencode --session <id>` of one that
 * isn't there prints "Error: Session not found: <id>" and exits 1 (cli/cmd/tui.ts:291-300, probed
 * 2026-11-22, 1.19.6), and the database's file being there with no such row is the only `gone`.
 * Whatever the id's shape: a query binds it, and no row is no session. One `stat` for the file; a row, or none, from one read-only query.
 */
export const conversations: Harness["conversations"] = (install): ConversationScan => {
  const path = databasePath(install)
  let ids: Promise<Set<string> | undefined> | undefined
  return {
    conversation: async (session): Promise<Conversation> => {
      if (path === undefined) return "unknown"
      if ((await presence(path)) !== "present") return "unknown"
      // A pass over a list reads the ids once, whatever its length.
      ids ??= Promise.resolve().then(() => all(path))
      const found = await ids
      if (found === undefined) return "unknown"
      return found.has(session) ? "found" : "gone"
    },
  }
}

export const conversation: Harness["conversation"] = async (install, session) => {
  const path = databasePath(install)
  if (path === undefined) return "unknown"
  if ((await presence(path)) !== "present") return "unknown"
  const found = has(path, session)
  return found === undefined ? "unknown" : found ? "found" : "gone"
}
