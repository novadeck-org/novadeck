// The known-flake register's matcher: which of a failed run's jobs failed the way a
// registered flake does. A run whose every failure is a known flake gets one recorded
// rerun; anything else is left failed, for someone to triage.

// A flake in the register, matched against a failed job by its name and its log. A test
// flake names its failing test; a job flake, as a timeout before any test ran, has none.
export type Flake = {
  readonly id: string
  // The jobs it fails, as regular expressions over the job's name.
  readonly jobs: readonly string[]
  // The failing test, as its id begins in the log: "file > describe > ... > it".
  readonly test?: string
  // A regular expression the failure's lines match, and another failure's don't.
  readonly signature: string
  // "known" is rerun when it fails; "fixed" was repaired, so its return is triaged.
  readonly status: "known" | "fixed"
  // What is known of its cause, and where it was seen.
  readonly cause: string
  readonly seen: readonly string[]
}

export type Register = {
  readonly flakes: readonly Flake[]
  // Jobs that only gather others' results, as Quality's Test: they fail with the job
  // they gather, so they say nothing of their own.
  readonly aggregates: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

const compiles = (pattern: string): boolean => {
  try {
    return new RegExp(pattern) instanceof RegExp
  } catch {
    return false
  }
}

// Reads the register file's contents, failing on an entry that couldn't match as meant: a
// bad pattern would match nothing, or everything.
export const parseRegister = (data: unknown): Register => {
  if (!isRecord(data) || !Array.isArray(data.flakes) || !Array.isArray(data.aggregates))
    throw new Error("The register holds `flakes` and `aggregates` lists.")
  const ids = new Set<string>()
  for (const flake of data.flakes) {
    if (!isRecord(flake) || !isText(flake.id)) throw new Error("Every flake has an id.")
    const { id } = flake
    if (ids.has(id)) throw new Error(`Flake ${id} is registered twice.`)
    ids.add(id)
    if (!Array.isArray(flake.jobs) || !flake.jobs.length || !flake.jobs.every(isText))
      throw new Error(`Flake ${id} names no job.`)
    if (flake.test !== undefined && !isText(flake.test))
      throw new Error(`Flake ${id}'s test is empty.`)
    if (!isText(flake.signature)) throw new Error(`Flake ${id} has no signature.`)
    if (flake.status !== "known" && flake.status !== "fixed")
      throw new Error(`Flake ${id}'s status is "known" or "fixed".`)
    if (!isText(flake.cause)) throw new Error(`Flake ${id} says nothing of its cause.`)
    if (!Array.isArray(flake.seen) || !flake.seen.every(isText))
      throw new Error(`Flake ${id} says nothing of where it was seen.`)
    for (const pattern of [...flake.jobs, flake.signature])
      if (!compiles(pattern))
        throw new Error(`Flake ${id} has a pattern that doesn't compile: ${pattern}`)
  }
  if (!data.aggregates.every(isText)) throw new Error("Aggregate jobs are named by text.")
  return data as Register
}

// One failed test in a job's log: its id, as "file > describe > ... > it", and the lines
// that tell of its failure.
// A test failed once per error it reports, each with the lines that tell of it; a report
// with no lines of its own, as in a summary, only names it.
export type Failure = { readonly test: string; readonly reports: readonly string[] }

// GitHub's timestamp on each log line, and terminal colours.
const timestamp = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/
// oxlint-disable-next-line no-control-regex -- Colour codes are what this removes.
const colour = /\u001b\[[\d;]*m/g
// Vitest's failed test or file: "FAIL  [project [(browser)]]  path > a > b", or a file
// that failed whole as "path [ path ]". The browser projects print a test once, the end
// to end runner once per error.
const failedLine =
  /^FAIL\s+(?:\S+(?: \(\S+\))?\s+)?(\S+\.(?:spec|test|e2e)\.[cm]?tsx?(?: > .+?)?)(?: \[ .* \])?$/
// Any line that says a test failed, read or not.
const failedMark = /^FAIL\s/
// Errors Vitest catches outside any test: they fail the run, and name no test.
const unhandled = /\bUnhandled (?:Errors?|Rejection)\b|\bVitest caught \d+ unhandled/
// Where a failure's lines end: the next failure, Vitest's separator, or its summary.
const blockEnd = /^(?:FAIL\s|⎯{3,}|Test Files\s)/
// How many lines after a failed test's line still tell of it, at most.
const blockLines = 40

export const cleanLog = (log: string): string[] =>
  log.split(/\r?\n/).map((line) => line.replace(colour, "").replace(timestamp, ""))

// A job's log read for failures: each failed test once, with every report of it, and what
// says something failed that names no test this can read. A test is a known flake only if
// each of its reports fails as the flake does.
export type LogReading = { readonly failures: Failure[]; readonly unreadable: string[] }

export const readLog = (log: string): LogReading => {
  const lines = cleanLog(log).map((line) => line.trim())
  const found = new Map<string, string[]>()
  const unreadable: string[] = []
  lines.forEach((line, index) => {
    if (unhandled.test(line)) unreadable.push(`an error outside any test: ${line}`)
    if (!failedMark.test(line)) return
    const match = failedLine.exec(line)
    if (!match) {
      unreadable.push(`a failure this can't read: ${line}`)
      return
    }
    const rest = lines.slice(index + 1, index + blockLines)
    const end = rest.findIndex((next) => blockEnd.test(next))
    const own = end < 0 ? rest : rest.slice(0, end)
    const reports = found.get(match[1]!) ?? []
    if (own.some((each) => each !== "")) reports.push([line, ...own].join("\n"))
    found.set(match[1]!, reports)
  })
  return {
    failures: [...found].map(([test, reports]) => ({ test, reports })),
    unreadable: [...new Set(unreadable)],
  }
}

export const failuresOf = (log: string): Failure[] => readLog(log).failures

export type JobVerdict = {
  readonly job: string
  // The registered flakes it failed as, and failures no flake explains.
  readonly flakes: readonly string[]
  readonly unknown: readonly string[]
}

const named = (job: string, flake: Flake): boolean =>
  flake.jobs.some((pattern) => new RegExp(pattern).test(job))

// How a failed job failed: each failed test against the test flakes, or, with no failure
// in its log at all, the whole log against the job flakes.
export const judgeJob = (register: Register, job: string, log: string): JobVerdict => {
  const { failures, unreadable } = readLog(log)
  if (!failures.length && !unreadable.length) {
    const text = cleanLog(log).join("\n")
    const flake = register.flakes.find(
      (each) =>
        each.test === undefined && named(job, each) && new RegExp(each.signature).test(text),
    )
    return flake
      ? { job, flakes: [flake.id], unknown: [] }
      : { job, flakes: [], unknown: ["no failed test in its log"] }
  }
  const flakes: string[] = []
  // What failed that this can't read is never a known flake.
  const unknown: string[] = [...unreadable]
  for (const failure of failures) {
    const flake = register.flakes.find(
      (each) =>
        each.test !== undefined &&
        failure.test.startsWith(each.test) &&
        named(job, each) &&
        failure.reports.length > 0 &&
        failure.reports.every((report) => new RegExp(each.signature).test(report)),
    )
    if (flake) flakes.push(flake.id)
    else unknown.push(failure.test)
  }
  return { job, flakes, unknown }
}

export type RunVerdict = {
  readonly jobs: readonly JobVerdict[]
  // Whether the run gets its one recorded rerun, and why not if it doesn't.
  readonly rerun: boolean
  readonly reason: string
}

// A run's failed jobs judged together. It gets a rerun only if every failure is a known
// flake, and only on its first attempt: one that fails again is triaged.
export const judgeRun = (
  register: Register,
  failed: readonly { readonly job: string; readonly log: string }[],
  attempt: number,
): RunVerdict => {
  const jobs = failed
    .filter(({ job }) => !register.aggregates.includes(job))
    .map(({ job, log }) => judgeJob(register, job, log))
  const status = new Map(register.flakes.map((flake) => [flake.id, flake.status]))
  const fixed = jobs.flatMap((verdict) => verdict.flakes.filter((id) => status.get(id) === "fixed"))
  const reason = !jobs.length
    ? "No failed job to judge."
    : jobs.some((verdict) => verdict.unknown.length)
      ? "A failure no registered flake explains: triage it."
      : fixed.length
        ? `A flake registered as fixed is back (${[...new Set(fixed)].join(", ")}): triage it.`
        : attempt > 1
          ? "Known flakes failed it again on a rerun: triage it."
          : "Every failure is a known flake: rerun once."
  const rerun = reason === "Every failure is a known flake: rerun once."
  return { jobs, rerun, reason }
}

// The verdict as Markdown, for the job summary and the pull request.
export const verdictSummary = (
  verdict: RunVerdict,
  { workflow, run }: { readonly workflow: string; readonly run: string },
): string =>
  [
    `## Known flakes: ${workflow}`,
    "",
    `${verdict.rerun ? "🔁" : "🔍"} ${verdict.reason} ([run](${run}))`,
    "",
    "| Job | Known flakes | Not explained |",
    "| --- | --- | --- |",
    ...verdict.jobs.map(
      ({ job, flakes, unknown }) =>
        `| ${job.replaceAll("|", "\\|")} | ${flakes.join(", ") || "–"} | ${unknown.map((test) => test.replaceAll("|", "\\|")).join("<br>") || "–"} |`,
    ),
    "",
    "The register is `scripts/flakes/register.json`.",
    "",
  ].join("\n")
