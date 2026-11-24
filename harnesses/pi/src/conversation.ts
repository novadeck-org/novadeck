import { readdir } from "node:fs/promises"

import {
  presence,
  rulesOf,
  type Conversation,
  type ConversationScan,
} from "@novadeck/harness-core/conversation"
import type { Harness, Install } from "@novadeck/harness-core/harness"

import { agentDir } from "./home.js"

/** Its session files' folder: one folder per project under `sessions`, a file `<time>_<id>.jsonl` each. */
const sessionsOf = (install: Pick<Install, "env" | "home" | "platform">): string =>
  rulesOf(install).join(agentDir(install), "sessions")

// A session id as pi takes it (`--session-id`): letters, digits, `.`, `_` and `-`.
const safeId = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/

const found = async (install: Install, session: string): Promise<Conversation> => {
  const root = sessionsOf(install)
  if ((await presence(root)) !== "present") return "unknown"
  if (!safeId.test(session)) return "unknown"
  try {
    for (const folder of await readdir(root, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue
      // eslint-disable-next-line no-await-in-loop -- Folders are read until one holds it.
      const names = await readdir(rulesOf(install).join(root, folder.name))
      if (names.some((name) => name.endsWith(`_${session}.jsonl`))) return "found"
    }
    return "gone"
  } catch {
    return "unknown"
  }
}

/** A session is a file under its sessions folder, found by its id (to be refined with the probes). */
export const conversation: Harness["conversation"] = (install, session) => found(install, session)

export const conversations: Harness["conversations"] = (install): ConversationScan => ({
  conversation: (session) => found(install, session),
})
