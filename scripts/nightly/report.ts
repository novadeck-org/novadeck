// What a nightly run's end does to the issue that tracks it, decided from the run. Pure:
// `main.ts` reads the run and the issue, and does what this says. One issue per workflow,
// found by its title: a failed night opens it, or adds to the one still open; the first
// green night closes it. Nothing else touches it, so a person may comment there freely.

import { judgeJob, type Register } from "../flakes/match.ts"

/** A job of the run that didn't succeed. */
export type FailedJob = {
  readonly id: number
  readonly name: string
  readonly conclusion: string
  readonly url: string
  /** Its log read against the known-flake register; none when the log wasn't read. */
  readonly verdict?: Verdict
}

/**
 * How a failed job failed, by the register (`scripts/flakes/register.json`): the known flakes
 * it failed as, those registered as fixed that are back, and what no flake explains (a failed
 * test, or why none could be named).
 */
export type Verdict = {
  readonly known: readonly string[]
  readonly back: readonly string[]
  readonly unexplained: readonly string[]
}

/** A failed job's log judged against the register. */
export const verdictOf = (register: Register, job: string, log: string): Verdict => {
  const { flakes, unknown } = judgeJob(register, job, log)
  const fixed = new Set(
    register.flakes.filter((flake) => flake.status === "fixed").map((flake) => flake.id),
  )
  return {
    known: flakes.filter((id) => !fixed.has(id)),
    back: flakes.filter((id) => fixed.has(id)),
    unexplained: unknown,
  }
}

/** The nightly run as it ended. */
export type Night = {
  /** The workflow's name, as `E2E`. */
  readonly workflow: string
  /** The run's conclusion: `success`, `failure`, `cancelled`, `timed_out`, …. */
  readonly conclusion: string
  readonly url: string
  readonly attempt: number
  /** The commit it ran, in full. */
  readonly sha: string
  /** When it started, as an ISO date. */
  readonly startedAt: string
  readonly failed: readonly FailedJob[]
  /**
   * Why the night couldn't be followed to its end, as a pinned E2E run that couldn't be
   * started, found or waited for: a failed night, so it isn't missed in silence.
   */
  readonly lost?: string
}

export type Action =
  | { readonly kind: "open"; readonly title: string; readonly body: string }
  | { readonly kind: "comment"; readonly issue: number; readonly body: string }
  | { readonly kind: "close"; readonly issue: number; readonly body: string }
  /** The issue's own text replaced, for a report that keeps a current list there; no night does. */
  | { readonly kind: "edit"; readonly issue: number; readonly body: string }
  | { readonly kind: "none" }

/**
 * The name a night is reported under: its workflow's, except E2E's run on the pinned
 * harnesses, which Nightly Quality starts by dispatch, while E2E's own night (`schedule`)
 * runs the latest ones. A regression and a harness's drift get an issue each.
 */
export const nameOf = (workflow: string, event: string): string =>
  workflow === "E2E" && event === "workflow_dispatch" ? "E2E (pinned)" : workflow

/** The tracking issue's title, by which it is found again. A workflow named for its night already says so once. */
export const titleOf = (workflow: string): string =>
  `Nightly ${workflow.replace(/^Nightly /, "")} is failing`

// A run that ended neither green nor red, as one skipped, says nothing of the night.
const failing = new Set(["failure", "cancelled", "timed_out", "startup_failure"])

// What a workflow's failed night most likely means, for whoever picks it up.
const notes: { readonly [workflow: string]: string } = {
  E2E:
    "This night runs each harness's latest release, and the probes too, so a failure the " +
    "pinned pull-request runs don't show is most likely a harness's own change, to adapt " +
    "to before its pin moves (`backend/runner/src/e2e/harnesses.json`). The probes' " +
    "findings are the run's `probes-*` artifacts.",
  "E2E (pinned)":
    "This night runs the whole suite on main against the pinned harnesses, as pull " +
    "requests do, so a failure here is Novadeck's own (a change that broke another when " +
    "merged beside it, a row a pull request's plan skipped) or a flake, not a harness's " +
    "drift, which E2E's own night reports. Nightly Quality starts it, and a release is " +
    "promoted only once it passed.",
  "Nightly Quality":
    "It runs every check and test Quality has on main, so a failure here passed on its pull " +
    "request or never ran there: a change that broke another when merged beside it, a test a " +
    "pull request skipped on this system, or a flake. A flake belongs in #784 and the register " +
    "(`scripts/flakes/register.json`). Failed UI specs leave their screenshots as the run's " +
    "`ui-test-failures-*` artifacts.",
}

const night = (run: Night): string =>
  `[${run.workflow}, ${run.startedAt.slice(0, 10)}](${run.url})` +
  `${run.attempt > 1 ? ` (attempt ${run.attempt})` : ""} on ${run.sha.slice(0, 8)}`

// The most failed tests named under a job; a file that failed whole can name dozens.
const testsShown = 10

const code = (text: string): string => `\`${text.replaceAll("`", "'")}\``

const listed = (label: string, items: readonly string[]): string[] =>
  items.length === 0
    ? []
    : [
        `  - ${label}: ${items.slice(0, testsShown).map(code).join(", ")}${
          items.length > testsShown ? `, and ${items.length - testsShown} more` : ""
        }`,
      ]

// Whether the failed jobs' logs show a flaky night or a break, as far as the register knows.
const reading = (jobs: readonly FailedJob[]): string => {
  const read = jobs.flatMap((job) => (job.verdict ? [job.verdict] : []))
  if (read.length === 0) return ""
  const unexplained = read.some((verdict) => verdict.unexplained.length > 0)
  const back = read.some((verdict) => verdict.back.length > 0)
  const unread = read.length < jobs.length ? " Some jobs' logs weren't read; see them." : ""
  if (unexplained)
    return `**A failure no registered flake explains**, listed as "not explained" below: a break until shown to be a flake.${unread}`
  if (back)
    return `**A flake registered as fixed is back**, listed below: its fix didn't hold.${unread}`
  return `**Every failure is a registered known flake** (\`scripts/flakes/register.json\`): a flaky night, not a break.${unread}`
}

const failures = (run: Night): string => {
  if (run.lost) return `It couldn't be followed to its end: ${run.lost}`
  if (run.failed.length === 0) return `The run ended \`${run.conclusion}\` with no job failed.`
  // Logs are read when the register is at hand; a job beyond those read says so.
  const anyRead = run.failed.some((job) => job.verdict)
  const jobs = run.failed
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .flatMap((job) => [
      `- [${job.name}](${job.url})${job.conclusion === "failure" ? "" : ` (${job.conclusion})`}${job.verdict || !anyRead ? "" : " (log not read)"}`,
      ...(job.verdict
        ? [
            ...listed("Not explained", job.verdict.unexplained),
            ...listed("Fixed flake back", job.verdict.back),
            ...listed("Known flake", job.verdict.known),
          ]
        : []),
    ])
  const verdict = reading(run.failed)
  return [
    `${run.failed.length} job${run.failed.length === 1 ? "" : "s"} failed:`,
    "",
    ...jobs,
    ...(verdict ? ["", verdict] : []),
  ].join("\n")
}

/**
 * What the run's end does to the open tracking issue (`open`, its number, or null when none
 * is open).
 */
export const decide = (run: Night, open: number | null): Action => {
  if (run.conclusion === "success")
    return open === null
      ? { kind: "none" }
      : { kind: "close", issue: open, body: `Green again: ${night(run)}.` }
  if (!failing.has(run.conclusion)) return { kind: "none" }
  const body = `${night(run)} failed.\n\n${failures(run)}`
  if (open !== null) return { kind: "comment", issue: open, body }
  const about = notes[run.workflow]
  return {
    kind: "open",
    title: titleOf(run.workflow),
    body: [
      body,
      "",
      `Each failed night adds a comment here; the first green night closes this.${about ? ` ${about}` : ""}`,
    ].join("\n"),
  }
}
