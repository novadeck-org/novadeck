import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { harnesses } from "../../../contract/protocol/src/harnesses.ts"
import { seconds } from "../../ci/plan/durations.ts"

// `node scripts/e2e/plan/durations.ts <run id>…`: reads the logs of the E2E jobs that passed in
// those runs (with `gh`) and writes durations.json beside this file: each suite file's time in
// each harness's job on each system, the median of the runs, a sharded harness's shards added
// up within a run. Vitest prints one line per file, `✓ src/e2e/chat.e2e.ts (12 tests) 235493ms`.
// The plan splits a harness's suite into its shards by these (`split` in plan.ts). The quirks
// jobs, macOS's core scenarios on a pull request and Mixed are left out: none is split.

/**
 * Each suite file's time in one job's log, in seconds, by its name (`chat.e2e.ts`). A file the
 * harness skips whole (`↓`, with no time) takes none, so it weighs nothing in a shard.
 */
export const filesIn = (log: string): ReadonlyMap<string, number> => {
  const found = new Map<string, number>()
  // eslint-disable-next-line no-control-regex -- Colours in the log.
  for (const line of log.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const match = /([✓❯×↓]) src\/e2e\/([\w.-]+\.e2e\.ts) \([^)]*\)(?:\s+(.+))?$/.exec(
      line.trimEnd(),
    )
    if (!match) continue
    const value = match[3] === undefined ? (match[1] === "↓" ? 0 : undefined) : seconds(match[3])
    if (value !== undefined) found.set(match[2]!, (found.get(match[2]!) ?? 0) + value)
  }
  return found
}

/** The harness and system a job of the `e2e` matrix runs (`Codex (Windows, 1/2)`), if one is. */
export const jobOf = (
  name: string,
): { readonly harness: string; readonly system: string } | undefined => {
  const match = /^(.+?)(?: \((.+)\))?$/.exec(name)
  // By its id too: older runs named opencode's and pi's jobs by their ids.
  const harness = harnesses.find((each) => each.name === match?.[1] || each.id === match?.[1])?.id
  if (!harness) return undefined
  const tags = match?.[2]?.split(", ") ?? []
  if (tags.some((tag) => !/^(Windows|macOS|\d+\/\d+)$/.test(tag))) return undefined
  const system = tags.includes("Windows") ? "windows" : tags.includes("macOS") ? "macos" : "linux"
  return { harness, system }
}

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 })

const main = (runs: readonly string[]) => {
  // Per harness, per system, per file, one total per run.
  const totals: Record<string, Record<string, Record<string, number[]>>> = {}
  for (const run of runs) {
    const jobs = JSON.parse(gh("run", "view", run, "--json", "jobs")).jobs as {
      databaseId: number
      name: string
      conclusion: string
    }[]
    const perRun: Record<string, Map<string, number>> = {}
    for (const job of jobs) {
      const of = jobOf(job.name)
      if (!of || job.conclusion !== "success") continue
      const log = gh("api", `repos/{owner}/{repo}/actions/jobs/${job.databaseId}/logs`)
      const into = (perRun[`${of.harness}/${of.system}`] ??= new Map())
      for (const [file, value] of filesIn(log)) into.set(file, (into.get(file) ?? 0) + value)
    }
    for (const [key, found] of Object.entries(perRun)) {
      const [harness, system] = key.split("/") as [string, string]
      for (const [file, value] of found)
        (((totals[harness] ??= {})[system] ??= {})[file] ??= []).push(value)
    }
    console.error(`${run}: ${Object.keys(perRun).join(" ") || "no job that passed"}`)
  }
  const durations = Object.fromEntries(
    Object.entries(totals)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([harness, bySystem]) => [
        harness,
        Object.fromEntries(
          Object.entries(bySystem)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([system, byFile]) => [
              system,
              Object.fromEntries(
                Object.entries(byFile)
                  .toSorted(([a], [b]) => a.localeCompare(b))
                  .map(([file, values]) => [file, Math.round(median(values))]),
              ),
            ]),
        ),
      ]),
  )
  writeFileSync(
    join(import.meta.dirname, "durations.json"),
    `${JSON.stringify(durations, null, 2)}\n`,
  )
}

if (import.meta.main) {
  const runs = process.argv.slice(2)
  if (runs.length === 0) {
    console.error("Usage: node scripts/e2e/plan/durations.ts <run id>…")
    process.exitCode = 1
  } else main(runs)
}
