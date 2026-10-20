// What a nightly run's end does to the issue that tracks it, decided from the run. Pure:
// `main.ts` reads the run and the issue, and does what this says. One issue per workflow,
// found by its title: a failed night opens it, or adds to the one still open; the first
// green night closes it. Nothing else touches it, so a person may comment there freely.

/** A job of the run that didn't succeed. */
export type FailedJob = {
  readonly id: number
  readonly name: string
  readonly conclusion: string
  readonly url: string
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
}

export type Action =
  | { readonly kind: "open"; readonly title: string; readonly body: string }
  | { readonly kind: "comment"; readonly issue: number; readonly body: string }
  | { readonly kind: "close"; readonly issue: number; readonly body: string }
  | { readonly kind: "none" }

/** The tracking issue's title, by which it is found again. */
export const titleOf = (workflow: string): string => `Nightly ${workflow} is failing`

// A run that ended neither green nor red, as one skipped, says nothing of the night.
const failing = new Set(["failure", "cancelled", "timed_out", "startup_failure"])

// What a workflow's failed night most likely means, for whoever picks it up.
const notes: { readonly [workflow: string]: string } = {
  E2E:
    "The nightly runs each harness's latest release, and the probes too, so a failure the " +
    "pinned pull-request runs don't show is most likely a harness's own change, to adapt " +
    "to before its pin moves (`backend/runner/src/e2e/harnesses.json`). The probes' " +
    "findings are the run's `probes-*` artifacts.",
}

const night = (run: Night): string =>
  `[${run.workflow}, ${run.startedAt.slice(0, 10)}](${run.url})` +
  `${run.attempt > 1 ? ` (attempt ${run.attempt})` : ""} on ${run.sha.slice(0, 8)}`

const failures = (run: Night): string => {
  if (run.failed.length === 0) return `The run ended \`${run.conclusion}\` with no job failed.`
  const jobs = run.failed
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map(
      (job) =>
        `- [${job.name}](${job.url})${job.conclusion === "failure" ? "" : ` (${job.conclusion})`}`,
    )
  return [
    `${run.failed.length} job${run.failed.length === 1 ? "" : "s"} failed:`,
    "",
    ...jobs,
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
