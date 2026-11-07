import {
  homeOfTranscript,
  lister,
  presence,
  rulesOf,
  sessionName,
  type Conversation,
  type ConversationScan,
} from "@novadeck/harness-core/conversation"
import type { Harness } from "@novadeck/harness-core/harness"

import { claudeHome } from "./home.js"

type Index = {
  readonly readable: boolean
  readonly files: ReadonlySet<string>
  readonly doubt: boolean
  readonly folders: number
}

/**
 * Claude Code keeps a conversation as `<home>/projects/<project>/<session>.jsonl`, in the
 * folder of the project it began in, which a session resumed elsewhere does not move. The
 * transcript the session reported says its home when a wrapper moved it (`CLAUDE_CONFIG_DIR`
 * is not in the runner's environment then). Each project is listed once for a pass, with no
 * file opened. Gone needs a project folder that is there and lacks the file; a link to
 * nowhere, or a folder that can't be read, leaves it unknown.
 */
export const conversations: Harness["conversations"] = (install): ConversationScan => {
  const rules = rulesOf(install)
  const list = lister()
  // What a home's projects hold, read once for the pass: every transcript's file name, and
  // whether a project could not be read or could hold one (a link to nowhere), or was a folder.
  const indexes = new Map<string, Promise<Index>>()
  const index = (home: string): Promise<Index> => {
    let kept = indexes.get(home)
    if (!kept) {
      kept = (async (): Promise<Index> => {
        const projects = rules.join(home, "projects")
        const root = await list(projects)
        if (root.kind !== "names")
          return { readable: false, files: new Set(), doubt: true, folders: 0 }
        const each = await Promise.all(root.names.map((name) => list(rules.join(projects, name))))
        const files = new Set<string>()
        for (const one of each)
          if (one.kind === "names") for (const name of one.names) files.add(name)
        return {
          readable: true,
          files,
          // A file among the projects holds none; a link to nowhere or an unreadable one may.
          doubt: each.some((one) => one.kind === "missing" || one.kind === "unreadable"),
          folders: each.filter((one) => one.kind === "names").length,
        }
      })()
      indexes.set(home, kept)
    }
    return kept
  }
  const inHome = async (home: string, session: string): Promise<Conversation> => {
    const seen = await index(home)
    if (!seen.readable) return "unknown"
    if (seen.files.has(`${session}.jsonl`)) return "found"
    return seen.doubt || seen.folders === 0 ? "unknown" : "gone"
  }
  return {
    conversation: async (session, known) => {
      if (!sessionName.test(session)) return "unknown"
      const transcript = known?.transcript
      if (transcript !== undefined && (await presence(transcript)) === "present") return "found"
      const hinted = homeOfTranscript(transcript, "projects")
      if (hinted !== undefined) {
        const found = await inHome(hinted, session)
        if (found !== "unknown") return found
      }
      return inHome(claudeHome(install), session)
    },
  }
}

export const conversation: Harness["conversation"] = (install, session, known) =>
  conversations(install).conversation(session, known)
