import { fileIn, rulesOf, sessionName } from "@novadeck/harness-core/conversation"
import type { Harness } from "@novadeck/harness-core/harness"

import { antigravityHome } from "./home.js"

/**
 * Antigravity keeps a conversation as `<home>/conversations/<session>.db`, and that file
 * decides: a resume of an id without it starts a new conversation without a word, and
 * `brain/<session>` stays after the file is gone (probed 2026-11-06, 1.5.2). One `stat`.
 */
export const conversation: Harness["conversation"] = (install, session) => {
  if (!sessionName.test(session)) return Promise.resolve("unknown")
  const rules = rulesOf(install)
  const folder = rules.join(antigravityHome(install), "conversations")
  return fileIn(folder, rules.join(folder, `${session}.db`))
}
