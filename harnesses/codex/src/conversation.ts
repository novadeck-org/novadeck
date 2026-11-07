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
// Codex compressed it.
const holds = (files: readonly string[], session: string): boolean =>
  files.some(
    (file) =>
      file.startsWith("rollout-") &&
      (file.endsWith(`-${session}.jsonl`) || file.endsWith(`-${session}.jsonl.zst`)),
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
type Looked = { found: boolean; unknown: boolean; days: number }

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

  const look = async (root: string, session: string): Promise<Looked> => {
    const out: Looked = { found: false, unknown: false, days: 0 }
    const top = await list(root)
    if (top.kind === "unreadable" || top.kind === "file") out.unknown = true
    if (top.kind !== "names") return out
    // Archived threads may sit flat in their folder.
    if (holds(top.names, session)) return { ...out, found: true }
    const day = (listing: Listing): boolean => {
      if (listing.kind === "unreadable") out.unknown = true
      if (listing.kind !== "names") return false
      out.days += 1
      return holds(listing.names, session)
    }
    const time = madeAt(session)
    if (time !== undefined) {
      const listings = await Promise.all(
        dayFolders(time).map((parts) => list(rules.join(root, ...parts))),
      )
      if (listings.some(day)) out.found = true
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
          // eslint-disable-next-line no-await-in-loop -- Same.
          if (day(await list(rules.join(root, year, month, name)))) return { ...out, found: true }
        }
      }
    }
    return out
  }

  const inHome = async (home: string, session: string): Promise<Conversation> => {
    const [live, archived] = await Promise.all([
      look(rules.join(home, "sessions"), session),
      look(rules.join(home, "archived_sessions"), session),
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
