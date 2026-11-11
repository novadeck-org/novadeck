import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

// `node scripts/ci/plan/durations.ts <run id>…`: reads the Test jobs' logs of green Quality runs
// (with `gh`) and writes durations.json beside this file: each package's test time on each
// system, the median of the runs, a sharded package's shards added up within a run. Vitest
// prints one `Duration` line per package, prefixed with turbo's `@novadeck/<name>:test:`; the
// repository's own tests print theirs first, unprefixed, as `//`. The replay reads the file.

/** Seconds in Vitest's `Duration` text: `12.90s`, `890ms`, `4m 53s`. */
export const seconds = (text: string): number | undefined => {
  const minutes = /(\d+)m(?!s)\s*(?:(\d+(?:\.\d+)?)s)?/.exec(text)
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2] ?? 0)
  const plain = /(\d+(?:\.\d+)?)(ms|s)\b/.exec(text)
  if (!plain) return undefined
  return plain[2] === "ms" ? Number(plain[1]) / 1000 : Number(plain[1])
}

/** Each package's duration in one job's log, by name (`//` for the repository's tests). */
export const durationsIn = (log: string): ReadonlyMap<string, number> => {
  const found = new Map<string, number>()
  // eslint-disable-next-line no-control-regex -- Colours in the log.
  for (const line of log.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const match = /^\S+\s+(?:(@[\w-]+\/[\w-]+):test:\s+)?Duration\s+(.+)$/.exec(line.trim())
    if (!match) continue
    const value = seconds(match[2]!)
    if (value === undefined) continue
    const name = match[1] ?? "//"
    found.set(name, (found.get(name) ?? 0) + value)
  }
  return found
}

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const systemOf = (job: string) =>
  /macOS/.test(job)
    ? "macos"
    : /Windows/.test(job)
      ? "windows"
      : /Linux/.test(job)
        ? "linux"
        : undefined

const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 })

const main = (runs: readonly string[]) => {
  // Per system, per package, one total per run.
  const totals: Record<string, Record<string, number[]>> = {}
  for (const run of runs) {
    const jobs = JSON.parse(gh("run", "view", run, "--json", "jobs")).jobs as {
      databaseId: number
      name: string
      conclusion: string
    }[]
    const perRun: Record<string, Map<string, number>> = {}
    for (const job of jobs) {
      const system = systemOf(job.name)
      if (!system || !job.name.startsWith("Test (") || job.conclusion !== "success") continue
      const log = gh("api", `repos/{owner}/{repo}/actions/jobs/${job.databaseId}/logs`)
      const into = (perRun[system] ??= new Map())
      for (const [name, value] of durationsIn(log)) into.set(name, (into.get(name) ?? 0) + value)
    }
    for (const [system, found] of Object.entries(perRun))
      for (const [name, value] of found) ((totals[system] ??= {})[name] ??= []).push(value)
  }
  const durations = Object.fromEntries(
    Object.entries(totals).map(([system, byName]) => [
      system,
      Object.fromEntries(
        Object.entries(byName)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([name, values]) => [name, Math.round(median(values) * 10) / 10]),
      ),
    ]),
  )
  writeFileSync(
    join(import.meta.dirname, "durations.json"),
    `${JSON.stringify({ runs, seconds: durations }, null, 2)}\n`,
  )
  console.log(JSON.stringify(durations, null, 2))
}

if (import.meta.main) main(process.argv.slice(2))
