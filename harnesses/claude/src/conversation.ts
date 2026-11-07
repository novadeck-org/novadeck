import { names, presence, rulesOf, sessionName } from "@novadeck/harness-core/conversation"
import type { Harness } from "@novadeck/harness-core/harness"

import { claudeHome } from "./home.js"

/**
 * Claude Code keeps a conversation as `<home>/projects/<project>/<session>.jsonl`, in the
 * folder of the project it began in, which a session resumed elsewhere does not move. One
 * `readdir` of `projects` and a `stat` in each folder, with no file opened.
 */
export const conversation: Harness["conversation"] = async (install, session) => {
  if (!sessionName.test(session)) return "unknown"
  const rules = rulesOf(install)
  const projects = rules.join(claudeHome(install), "projects")
  const folders = await names(projects)
  if (typeof folders === "string") return "unknown"
  const seen = await Promise.all(
    folders.map((folder) => presence(rules.join(projects, folder, `${session}.jsonl`))),
  )
  if (seen.includes("present")) return "found"
  return seen.every((one) => one === "absent") ? "gone" : "unknown"
}
