// When each night was scheduled and when it really started. GitHub starts this repository's
// scheduled runs hours late, and Nightly Quality's cron is set for that delay
// (quality-nightly.yml), so the scoreboard shows it, and a change in it shows.

import { isNightlyQuality, isPinnedE2e } from "./bar.ts"
import type { Run } from "./scoreboard.ts"

const day = 86_400_000

/** A daily cron, as `M H * * *` sets it. */
export type Daily = { readonly minute: number; readonly hour: number }

/** The workflow's daily cron, from its file; none for any other schedule. */
export const dailyCron = (workflow: string): Daily | undefined => {
  const match = /cron:\s*["']?(\d{1,2}) (\d{1,2}) \* \* \*["']?\s*$/m.exec(workflow)
  if (!match) return undefined
  const minute = Number(match[1])
  const hour = Number(match[2])
  return minute < 60 && hour < 24 ? { minute, hour } : undefined
}

/** When the daily cron last fired at or before `at`, the start it was late for. */
export const scheduledBefore = (cron: Daily, at: number): number => {
  const date = new Date(at)
  const fire = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    cron.hour,
    cron.minute,
  )
  return fire <= at ? fire : fire - day
}

const time = (at: number): string => new Date(at).toISOString().slice(5, 16).replace("T", " ")

const late = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  return `+${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

const byStart = (a: Run, b: Run): number => a.created_at.localeCompare(b.created_at)

/**
 * Each of the latest `latest` scheduled nights of Nightly Quality: when its cron fired, when
 * GitHub started it and how late, and when the pinned E2E run it started began, as one line.
 * Empty without a night.
 */
export const renderStarts = (
  runs: readonly Run[],
  cron: Daily | undefined,
  latest = 14,
): string => {
  const nights = runs.filter(isNightlyQuality).toSorted(byStart).slice(-latest)
  if (nights.length === 0) return ""
  const pinned = runs.filter(isPinnedE2e).toSorted(byStart)
  const entries = nights.map((night, index) => {
    const started = Date.parse(night.created_at)
    const next = nights[index + 1]?.created_at
    const e2e = pinned.find(
      (run) => run.created_at >= night.created_at && (next === undefined || run.created_at < next),
    )
    const scheduled = cron ? scheduledBefore(cron, started) : undefined
    return [
      scheduled === undefined ? "?" : time(scheduled),
      `${time(started)}${scheduled === undefined ? "" : ` (${late(started - scheduled)})`}`,
      e2e ? time(Date.parse(e2e.created_at)) : "none",
    ].join(" → ")
  })
  return [
    `Each night's start (UTC), scheduled → Nightly Quality started → its pinned E2E started: ${entries.join("; ")}.`,
    "",
  ].join("\n")
}
