// Whether a release may be promoted to stable, by the nightlies that ran after it. A pull
// request may skip tests that can't break with its change (scripts/e2e/plan, and Quality's
// own plan to come); the nightlies run everything on main. So a release is promotable only
// when each full nightly passed on its commit or a later one of main, and nothing a pull
// request skipped reaches stable untested. Pure: `main.ts` reads the runs, how their commits
// relate to the release's and which systems they passed on, and reports what this says.

/** An operating system a run's jobs ran on. */
export type System = "Linux" | "Windows" | "macOS"

/** A completed run of a nightly on main. */
export type Run = {
  readonly id: number
  readonly url: string
  /** The commit it ran, in full. */
  readonly sha: string
  /** `schedule`, `workflow_dispatch`, `pull_request`, …. */
  readonly event: string
  /** Who started it: a rerun keeps the run's first actor. */
  readonly actor: string
  /** `success`, `failure`, `cancelled`, …. */
  readonly conclusion: string
  /** When it started, as an ISO date. */
  readonly createdAt: string
}

/** A nightly workflow a release must have passed. */
export type Nightly = {
  /** What it is called in the log. */
  readonly name: string
  /** Its file in `.github/workflows`, by which its runs are listed. */
  readonly file: string
  /** Whether a run of the workflow is this nightly. */
  readonly counts: (run: Run) => boolean
  /** Whether it must have passed on all three systems, which only its jobs say. */
  readonly everySystem: boolean
  /** What to run when no green night covers the release. */
  readonly unblock: string
}

// Nightly Quality dispatches E2E with the Actions token, always on the pinned harnesses.
const actionsBot = "github-actions[bot]"

const startNight = "`gh workflow run quality-nightly.yml --ref main`"

/**
 * The nightlies every promotion needs: all of Quality's checks, and the whole E2E suite on
 * the pinned harnesses, the versions pull requests test. E2E's own night (`schedule`) runs
 * the latest ones to catch a harness's drift, which says nothing of Novadeck's code, so it
 * counts neither way; nor does a person's dispatch, whose harnesses the run doesn't show.
 */
export const nightlies: readonly Nightly[] = [
  {
    name: "Nightly Quality",
    file: "quality-nightly.yml",
    counts: (run) => run.event === "schedule" || run.event === "workflow_dispatch",
    everySystem: false,
    unblock: `start a night: ${startNight}`,
  },
  {
    name: "E2E on the pinned harnesses",
    file: "e2e.yml",
    counts: (run) => run.event === "workflow_dispatch" && run.actor === actionsBot,
    everySystem: true,
    unblock: `start a night, which starts this run when its tests are done: ${startNight}`,
  },
]

/**
 * How a run's commit stands to the release's, as GitHub's compare of the release's commit
 * with the run's says: `identical` or `ahead` is at or after it.
 */
export type Relation = "identical" | "ahead" | "behind" | "diverged"

/** The runs of the nightly worth comparing with the release, newest first, at most `limit`. */
export const candidates = (nightly: Nightly, runs: readonly Run[], limit = 10): readonly Run[] =>
  runs
    .filter(nightly.counts)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)

/** The system a job ran on, by its runner's labels. */
export const systemOf = (labels: readonly string[]): System | undefined => {
  const label = labels.join(" ").toLowerCase()
  if (label.includes("macos")) return "macOS"
  if (label.includes("windows")) return "Windows"
  if (label.includes("ubuntu") || label.includes("linux")) return "Linux"
  return undefined
}

/** The systems a run passed on: those of its jobs that succeeded. */
export const passedOn = (
  jobs: readonly { readonly labels: readonly string[]; readonly conclusion: string | null }[],
): ReadonlySet<System> =>
  new Set(
    jobs
      .filter((job) => job.conclusion === "success")
      .map((job) => systemOf(job.labels))
      .filter((system) => system !== undefined),
  )

const all: readonly System[] = ["Linux", "Windows", "macOS"]

export type Verdict =
  | { readonly ok: true; readonly run: Run }
  | {
      readonly ok: false
      /** The newest run at or after the release, when one ran and didn't pass. */
      readonly failed?: Run | undefined
      /** The newest green run at or after it that skipped a system, and the ones it skipped. */
      readonly partial?: { readonly run: Run; readonly missing: readonly System[] } | undefined
      /** The newest green run, when it ran on an older commit than the release's. */
      readonly older?: Run | undefined
    }

const covers = (relation: Relation | undefined): boolean =>
  relation === "identical" || relation === "ahead"

/**
 * Whether the nightly passed at or after the release's commit, from its runs, how each run's
 * commit stands to the release's (`relations`, by commit; a commit missing there counts as
 * not after it), and, where the nightly must pass on every system, which ones each green run
 * passed on (`systems`, by run id; a run missing there passed on none).
 */
export const judge = (
  nightly: Nightly,
  runs: readonly Run[],
  relations: ReadonlyMap<string, Relation>,
  systems: ReadonlyMap<number, ReadonlySet<System>> = new Map(),
): Verdict => {
  const ordered = candidates(nightly, runs, Number.POSITIVE_INFINITY)
  const after = ordered.filter((run) => covers(relations.get(run.sha)))
  const green = after.filter((run) => run.conclusion === "success")
  const missing = (run: Run): readonly System[] =>
    nightly.everySystem ? all.filter((system) => !systems.get(run.id)?.has(system)) : []
  const whole = green.find((run) => missing(run).length === 0)
  if (whole) return { ok: true, run: whole }
  return {
    ok: false,
    failed: after.find((run) => run.conclusion !== "success"),
    partial: green[0] && { run: green[0], missing: missing(green[0]) },
    older: ordered.find((run) => run.conclusion === "success"),
  }
}

const short = (sha: string): string => sha.slice(0, 8)

/** What the promotion's log says of one nightly: a line when it passed, the way out when not. */
export const explain = (nightly: Nightly, tag: string, sha: string, verdict: Verdict): string => {
  if (verdict.ok)
    return `${nightly.name} passed on ${short(verdict.run.sha)}, at or after ${tag} (${short(sha)}): ${verdict.run.url}`
  const seen = verdict.partial
    ? `Its newest green run at or after it has no passed job on ${verdict.partial.missing.join(" or ")}: ${verdict.partial.run.url}.`
    : verdict.failed
      ? `Its newest run at or after it ended \`${verdict.failed.conclusion}\` on ${short(verdict.failed.sha)}: ${verdict.failed.url}. Fix what failed, or if it was a flake rerun its failed jobs: \`gh run rerun ${verdict.failed.id} --failed\`.`
      : verdict.older
        ? `Its newest green run is on ${short(verdict.older.sha)}, older than the release: ${verdict.older.url}.`
        : "It has no green run on main yet."
  return [
    `${tag} (${short(sha)}) has no green ${nightly.name} at or after its commit, so what a pull request skipped may not have run on it. ${seen}`,
    `To unblock, ${nightly.unblock}, wait for it to pass, then promote again. For an urgent fix that can't wait for it, promote with a reason in \`skip-nightlies\`, which the run's summary keeps.`,
  ].join(" ")
}
