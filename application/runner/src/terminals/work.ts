import { dirname } from "node:path"

import type { HarnessEvent } from "../harnesses/events.js"
import { rootedIn, type Root, type RootChange } from "../harnesses/roots.js"

/**
 * What the agent session at a terminal's root worked on, as its hooks said: the person's
 * first and latest root prompts there, shortened, never a turn the harness started by
 * itself; how often it wrote in each folder; and when it was last active. A fact of the
 * terminal, kept with its record, so it outlives the agent compacting its context and the
 * runner restarting; agents messaging each other read it.
 */
export type Work = {
  /** The session it is of, as `agent:session`. */
  readonly session: string
  readonly first: string | null
  readonly latest: string | null
  /** Edits by folder, by absolute path, the `keptFolders` written in most. */
  readonly folders: { readonly [folder: string]: number }
  readonly activeAt: number | null
}

/** How long a prompt shows, in characters. */
export const promptChars = 120
/** How many folders' edits are kept. */
export const keptFolders = 20

/** Text on one line, cut to `max` characters with an ellipsis. */
export const shorten = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

const sessionOf = (root: Root): string => `${root.agent}:${root.sessionId}`

/** The work of a session that has done none yet. */
export const freshWork = (session: string): Work => ({
  session,
  first: null,
  latest: null,
  folders: {},
  activeAt: null,
})

/**
 * The tally with one more edit in `folder`, kept to the `keptFolders` written in most,
 * and always the one just written in, so a new folder gets its chance.
 */
export const tallied = (folders: Work["folders"], folder: string): Work["folders"] => {
  const edits = (folders[folder] ?? 0) + 1
  const others = Object.entries(folders)
    .filter(([name]) => name !== folder)
    .toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, keptFolders - 1)
  return Object.fromEntries([...others, [folder, edits]])
}

/** The folders a session wrote in most, by edits, at most `count` of them. */
export const busiestFolders = (
  folders: Work["folders"],
  count = 3,
): readonly { readonly folder: string; readonly edits: number }[] =>
  Object.entries(folders)
    .toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, count)
    .map(([folder, edits]) => ({ folder, edits }))

/**
 * The work of the root's session after its root `changes` and a report's facts: the same
 * session keeps what it worked on, and so does a guess at it corrected to another
 * session, as Antigravity's root once its status line names it; another session starts
 * afresh, and none has none.
 */
export const workAfter = (
  work: Work | null,
  root: Root | null,
  events: readonly HarnessEvent[],
  now: number,
  changes: readonly RootChange[] = [],
): Work | null => {
  if (!root) return work
  let carried = work
  for (const change of changes)
    if (change.type === "corrected" && carried?.session === `${change.root.agent}:${change.from}`)
      carried = { ...carried, session: sessionOf(change.root) }
  const session = sessionOf(root)
  let next = carried?.session === session ? carried : freshWork(session)
  for (const event of events) {
    if (event.type === "session-observed" || !rootedIn(root, event)) continue
    if (event.type === "turn-started") {
      // Only the person's prompts say what the session works on.
      const prompt =
        event.cause === "prompt" && event.prompt ? shorten(event.prompt, promptChars) : null
      next = {
        ...next,
        ...(prompt && { first: next.first ?? prompt, latest: prompt }),
        activeAt: now,
      }
    } else if (event.type === "turn-ended") next = { ...next, activeAt: now }
    else if (event.type === "file-touched")
      next = { ...next, folders: tallied(next.folders, dirname(event.path)), activeAt: now }
  }
  return next
}
