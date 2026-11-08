import {
  homeOfTranscript,
  lister,
  presence,
  rulesOf,
  sessionName,
  type Conversation,
  type ConversationScan,
  type Listing,
} from "@novadeck/harness-core/conversation"
import type { Harness } from "@novadeck/harness-core/harness"

import { codexHome } from "./home.js"

// How many day folders a walk may read for an id that carries no date, newest first.
const walkBudget = 400

// A UUIDv7 starts with the milliseconds it was made at; undefined for any other id.
const madeAt = (session: string): number | undefined => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i.test(session)) return undefined
  const time = Number.parseInt(session.replaceAll("-", "").slice(0, 12), 16)
  return Number.isSafeInteger(time) ? time : undefined
}

// The rollout of the session in a folder: `rollout-<time>-<session>.jsonl`, or `.zst` once
// Codex compressed it, which only the check counts (`plain` false): no line of it can be read.
const holds = (files: readonly string[], session: string, plain: boolean): string | undefined =>
  files.find(
    (file) =>
      file.startsWith("rollout-") &&
      (file.endsWith(`-${session}.jsonl`) || (!plain && file.endsWith(`-${session}.jsonl.zst`))),
  )

const pad = (value: number): string => String(value).padStart(2, "0")

// The folders a session made at `time` may be filed under: its local day and its neighbours,
// as the clock at the rollout's creation may differ from the id's by a time zone's edge.
const dayFolders = (time: number): string[][] =>
  [-1, 0, 1].map((offset) => {
    const day = new Date(time + offset * 86_400_000)
    return [String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate())]
  })

const isNumber = (name: string): boolean => /^\d+$/.test(name)

const newest = (listing: Listing): string[] =>
  listing.kind === "names"
    ? listing.names.filter(isNumber).toSorted((a, b) => Number(b) - Number(a))
    : []

// What looking through one tree of rollouts came to: found, anything it could not read,
// and how many day folders it read (a tree with none is no store to call anything gone by).
type Looked = { found: string | undefined; unknown: boolean; days: number }

type Rules = ReturnType<typeof rulesOf>

/** Looks for the session's rollout in one tree of them, live or archived: its path where found. */
const look = async (
  rules: Rules,
  list: (folder: string) => Promise<Listing>,
  root: string,
  session: string,
  plain: boolean,
): Promise<Looked> => {
  const out: Looked = { found: undefined, unknown: false, days: 0 }
  const top = await list(root)
  if (top.kind === "unreadable" || top.kind === "file") out.unknown = true
  if (top.kind !== "names") return out
  // Archived threads may sit flat in their folder.
  const flat = holds(top.names, session, plain)
  if (flat !== undefined) return { ...out, found: rules.join(root, flat) }
  const day = (folder: string, listing: Listing): string | undefined => {
    if (listing.kind === "unreadable") out.unknown = true
    if (listing.kind !== "names") return undefined
    out.days += 1
    const name = holds(listing.names, session, plain)
    return name === undefined ? undefined : rules.join(folder, name)
  }
  const time = madeAt(session)
  if (time !== undefined) {
    const folders = dayFolders(time).map((parts) => rules.join(root, ...parts))
    const found = await Promise.all(folders.map(async (folder) => day(folder, await list(folder))))
    out.found = found.find((path) => path !== undefined)
    return out
  }
  let budget = walkBudget
  for (const year of newest(top)) {
    // eslint-disable-next-line no-await-in-loop -- A bounded walk reads one folder at a time.
    const months = await list(rules.join(root, year))
    for (const month of newest(months)) {
      // eslint-disable-next-line no-await-in-loop -- Same.
      const days = await list(rules.join(root, year, month))
      for (const name of newest(days)) {
        if (budget-- <= 0) return { ...out, unknown: true }
        const folder = rules.join(root, year, month, name)
        // eslint-disable-next-line no-await-in-loop -- Same.
        const found = day(folder, await list(folder))
        if (found !== undefined) return { ...out, found }
      }
    }
  }
  return out
}

/**
 * Codex files a rollout as `<home>/sessions/YYYY/MM/DD/rollout-<time>-<session>.jsonl` (or
 * `.jsonl.zst`). An archived thread moves to `<home>/archived_sessions`, where
 * `codex resume` offers to unarchive it, so it is found there too. A UUIDv7 session carries
 * the day it began, so three day folders answer; an id without one is looked for newest day
 * first, and unknown once the budget of folders is spent. Gone needs a day folder that is
 * there and lacks it. The transcript the session reported says its home when a wrapper moved
 * it (`CODEX_HOME` is not in the runner's environment then). Only `stat` and `readdir`, each
 * folder once for a pass.
 */
export const conversations: Harness["conversations"] = (install): ConversationScan => {
  const rules = rulesOf(install)
  const list = lister()

  const inHome = async (home: string, session: string): Promise<Conversation> => {
    const [live, archived] = await Promise.all([
      look(rules, list, rules.join(home, "sessions"), session, false),
      look(rules, list, rules.join(home, "archived_sessions"), session, false),
    ])
    if (live.found || archived.found) return "found"
    if (live.unknown || archived.unknown) return "unknown"
    return live.days > 0 ? "gone" : "unknown"
  }

  return {
    conversation: async (session, known) => {
      if (!sessionName.test(session)) return "unknown"
      const transcript = known?.transcript
      if (transcript !== undefined && (await presence(transcript)) === "present") return "found"
      const hinted =
        homeOfTranscript(transcript, "sessions") ??
        homeOfTranscript(transcript, "archived_sessions")
      if (hinted !== undefined) {
        const found = await inHome(hinted, session)
        if (found !== "unknown") return found
      }
      return inHome(codexHome(install), session)
    },
  }
}

export const conversation: Harness["conversation"] = (install, session, known) =>
  conversations(install).conversation(session, known)

/**
 * The plain rollout of the session under the home the reported path names, live or
 * archived, by the check's own walk: where `locate` is given a path that holds none. A
 * compressed one is not found, as no line of it can be read.
 */
export const rolloutAway = async (
  reported: string,
  session: string,
  rules: Rules,
): Promise<string | undefined> => {
  const home =
    homeOfTranscript(reported, "sessions") ?? homeOfTranscript(reported, "archived_sessions")
  if (!sessionName.test(session) || home === undefined) return undefined
  const list = lister()
  const [live, archived] = await Promise.all([
    look(rules, list, rules.join(home, "sessions"), session, true),
    look(rules, list, rules.join(home, "archived_sessions"), session, true),
  ])
  return live.found ?? archived.found
}
