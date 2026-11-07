import {
  names,
  presence,
  rulesOf,
  sessionName,
  type Conversation,
} from "@novadeck/harness-core/conversation"
import type { Harness, Install } from "@novadeck/harness-core/harness"

import { codexHome } from "./home.js"

// How many day folders a walk may read for an id that carries no date, newest first.
const walkBudget = 400

// A UUIDv7 starts with the milliseconds it was made at; undefined for any other id.
const madeAt = (session: string): number | undefined => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i.test(session)) return undefined
  const time = Number.parseInt(session.replaceAll("-", "").slice(0, 12), 16)
  return Number.isSafeInteger(time) ? time : undefined
}

// The rollout of the session in a day folder: `rollout-<time>-<session>.jsonl`, or `.zst`
// once Codex compressed it.
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

// The newest names first, among those that are numbers.
const numbered = async (folder: string): Promise<readonly string[] | "unreadable"> => {
  const found = await names(folder)
  if (found === "absent") return []
  if (found === "unreadable") return "unreadable"
  return found.filter((name) => /^\d+$/.test(name)).toSorted((a, b) => Number(b) - Number(a))
}

/**
 * Codex files a rollout as `<home>/sessions/YYYY/MM/DD/rollout-<time>-<session>.jsonl` (or
 * `.jsonl.zst`), and moves an archived thread out of `sessions`, which cannot be resumed,
 * so it counts as gone. A UUIDv7 session carries the day it began, so three day folders
 * answer; an id without one is looked for newest day first, and unknown once the budget of
 * folders is spent without finding it. Only `stat` and `readdir`.
 */
export const conversation: Harness["conversation"] = async (
  install: Install,
  session: string,
): Promise<Conversation> => {
  if (!sessionName.test(session)) return "unknown"
  const rules = rulesOf(install)
  const sessions = rules.join(codexHome(install), "sessions")
  if ((await presence(sessions)) !== "present") return "unknown"
  const time = madeAt(session)
  if (time !== undefined) {
    let unknown = false
    for (const day of dayFolders(time)) {
      // eslint-disable-next-line no-await-in-loop -- Three folders, the likeliest first.
      const files = await names(rules.join(sessions, ...day))
      if (files === "unreadable") unknown = true
      else if (files !== "absent" && holds(files, session)) return "found"
    }
    return unknown ? "unknown" : "gone"
  }
  let budget = walkBudget
  /* eslint-disable no-await-in-loop -- A bounded walk reads one folder at a time. */
  const years = await numbered(sessions)
  if (years === "unreadable") return "unknown"
  for (const year of years) {
    const months = await numbered(rules.join(sessions, year))
    if (months === "unreadable") return "unknown"
    for (const month of months) {
      const days = await numbered(rules.join(sessions, year, month))
      if (days === "unreadable") return "unknown"
      for (const day of days) {
        if (budget-- <= 0) return "unknown"
        const files = await names(rules.join(sessions, year, month, day))
        if (files === "unreadable") return "unknown"
        if (files !== "absent" && holds(files, session)) return "found"
      }
    }
  }
  /* eslint-enable no-await-in-loop */
  return "gone"
}
