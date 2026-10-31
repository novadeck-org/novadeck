import { dirname } from "node:path"

import type { HarnessEvent } from "@novadeck/harness-core/events"

import { rootedIn, type Root, type RootChange } from "../harnesses/roots.js"
import { shorten } from "../text.js"

/**
 * What the agent session at a terminal's root worked on, as its hooks said: the person's
 * first and latest root prompts there, shortened, never a turn the harness started by
 * itself; how often it wrote in each folder, and the files it wrote last; and when it was
 * last active. A fact of the terminal, kept with its record, so it outlives the agent
 * compacting its context and the runner restarting; agents messaging each other read it.
 */
export type Work = {
  /** The session it is of, as `agent:session`. */
  readonly session: string
  readonly first: string | null
  /**
   * Whether the person's own submission started the turn of `first` (as delivery tells
   * it, `byPerson`), so it is theirs; false for one nobody submitted, as an agent's
   * command-line prompt; undefined until told.
   */
  readonly firstByPerson?: boolean
  /**
   * Whether it is the first root session of a terminal an agent opened, whose first
   * prompt may be that agent's command; later sessions are the person's.
   */
  readonly opened?: true
  readonly latest: string | null
  /**
   * When the person's latest root prompt started its turn, as delivery judges the prompt
   * theirs (their Enter), so never a self-wake's or the doorbell's; absent before one.
   */
  readonly personAt?: number
  /** Edits by folder, by absolute path, the `keptFolders` written in most. */
  readonly folders: { readonly [folder: string]: number }
  /** The paths of the `keptFiles` files it wrote in last, the latest first; absent until one. */
  readonly files?: readonly string[]
  /**
   * The folders of its latest `keptPlaces` tool calls that name one, the latest first: the
   * folder a root's shell command ran in, and the folder of a file any of its actors wrote.
   * What tells where it works now (see `currentFolder`); absent until one.
   */
  readonly places?: readonly string[]
  readonly activeAt: number | null
}

/** How long a prompt shows, in characters. */
export const promptChars = 120

// A tag that wraps what one agent hands another (Novadeck's `<novadeck-messages>` and its
// `<message>`, or a harness's own, as `<agent-message from="…">`): its name, and its
// attributes, of which `from` names the sender.
const wrapper = /<\/?((?:[a-z]+-)+[a-z]+|message)(\s[^<>]*)?>/gi

/**
 * A prompt as others read it: tags wrapping a message one agent handed another dropped,
 * with who it is from where the first names a sender, so its words show rather than the
 * markup around them.
 */
export const plainPrompt = (prompt: string): string => {
  let from: string | undefined
  const words = prompt.replace(wrapper, (_tag, _name: string, attributes?: string) => {
    if (from === undefined && attributes) from = /\sfrom="([^"]{1,64})"/.exec(attributes)?.[1]
    return " "
  })
  if (words === prompt) return prompt
  const text = words.replace(/\s+/g, " ").trim()
  return from ? `(a message from ${from}) ${text}` : text
}

/** How many folders' edits are kept. */
export const keptFolders = 20
/** How many files' paths are kept. */
export const keptFiles = 8
/** How many tool calls' folders are kept. */
export const keptPlaces = 8

/**
 * Whose the root session's first prompt is: the `user`'s; the `opener`'s, in the first
 * session of a terminal an agent opened, when the person's own submission didn't start it
 * (or that isn't told yet), as the opener's command-line prompt; null without one.
 */
export const firstFrom = (work: Work | null, openedBy: string | null): "user" | "opener" | null => {
  if (!work?.first) return null
  if (openedBy === null || work.opened !== true) return "user"
  return work.firstByPerson === true ? "user" : "opener"
}

/** The work once the person's own prompt started a root turn at `at`; never earlier than it was. */
export const personPrompted = (work: Work, at: number): Work =>
  work.personAt !== undefined && work.personAt >= at ? work : { ...work, personAt: at }

/** The work once told whether the person's own submission started its first prompt; told once. */
export const judgedFirst = (work: Work, byPerson: boolean): Work =>
  !work.first || work.firstByPerson !== undefined ? work : { ...work, firstByPerson: byPerson }

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

/** The file paths with `file` the latest, once, kept to the `keptFiles` latest. */
export const lastFiles = (files: Work["files"], file: string): readonly string[] =>
  [file, ...(files ?? []).filter((name) => name !== file)].slice(0, keptFiles)

/**
 * The folders of the latest tool calls with `folder` the latest, kept to `keptPlaces`: the
 * same list when nothing changes, as for calls all in one folder, so steady work in one
 * place saves nothing more.
 */
export const placed = (places: Work["places"], folder: string): readonly string[] => {
  const next = [folder, ...(places ?? [])].slice(0, keptPlaces)
  return places?.length === next.length && next.every((each, at) => each === places[at])
    ? places
    : next
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
 * Where a session works now, from its latest `places`, as `checkout` names the git checkout
 * each is in (null for one outside any, as a scratchpad or a memory folder): the checkout
 * most of them are in, the latest of those on a tie; null when none is in one. A look
 * elsewhere (a log, a search) doesn't move it; working in another worktree soon does.
 */
export const currentCheckout = (
  places: readonly string[],
  checkout: (folder: string) => string | null,
): string | null => {
  const counts = new Map<string, number>()
  for (const place of places) {
    const found = checkout(place)
    if (found !== null) counts.set(found, (counts.get(found) ?? 0) + 1)
  }
  let best: string | null = null
  // Map keeps first-seen order, which is the latest first, so a tie keeps the latest.
  for (const [found, count] of counts) if (best === null || count > counts.get(best)!) best = found
  return best
}

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
        event.cause === "prompt" && event.prompt
          ? shorten(plainPrompt(event.prompt), promptChars)
          : null
      next = {
        ...next,
        ...(prompt && { first: next.first ?? prompt, latest: prompt }),
        activeAt: now,
      }
    } else if (event.type === "turn-ended") next = { ...next, activeAt: now }
    else if (event.type === "file-touched")
      next = {
        ...next,
        folders: tallied(next.folders, dirname(event.path)),
        files: lastFiles(next.files, event.path),
        places: placed(next.places, dirname(event.path)),
        activeAt: now,
      }
    // A subagent's commands look around (a search, a log) more than they say where the
    // work is; the files any actor writes do.
    else if (event.type === "tool-called" && event.folder !== undefined && event.actor === null) {
      const places = placed(next.places, event.folder)
      if (places !== next.places) next = { ...next, places }
    }
  }
  return next
}
