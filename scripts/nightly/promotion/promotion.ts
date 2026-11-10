// Whether a release may be promoted to stable, by the nightlies that ran after it. A pull
// request may skip tests that can't break with its change (scripts/e2e/plan, and Quality's
// own plan to come); the nightlies run everything on main. So a release is promotable only
// when each full nightly passed on its commit or a later one of main, and nothing a pull
// request skipped reaches stable untested. Pure: `main.ts` reads the runs and how their
// commits relate to the release's, and reports what this says.

/** A nightly workflow a release must have passed. */
export type Nightly = {
  /** The workflow's name, as the Actions list shows it. */
  readonly name: string
  /** Its file in `.github/workflows`, by which it is listed and dispatched. */
  readonly file: string
}

/** The nightlies every promotion needs: all of Quality's checks, and the whole E2E suite. */
export const nightlies: readonly Nightly[] = [
  { name: "Nightly Quality", file: "quality-nightly.yml" },
  { name: "E2E", file: "e2e.yml" },
]

/** A completed run of a nightly on main. */
export type Run = {
  readonly url: string
  /** The commit it ran, in full. */
  readonly sha: string
  /** `schedule` or `workflow_dispatch`; a pull request's run is never full. */
  readonly event: string
  /** `success`, `failure`, `cancelled`, …. */
  readonly conclusion: string
  /** When it started, as an ISO date. */
  readonly createdAt: string
}

/**
 * How a run's commit stands to the release's, as GitHub's compare of the release's commit
 * with the run's says: `identical` or `ahead` is at or after it.
 */
export type Relation = "identical" | "ahead" | "behind" | "diverged"

// The events whose runs are full: a pull request's E2E runs only what its change needs.
const full = new Set(["schedule", "workflow_dispatch"])

/** The runs worth comparing with the release, newest first: full runs, at most `limit`. */
export const candidates = (runs: readonly Run[], limit = 10): readonly Run[] =>
  runs
    .filter((run) => full.has(run.event))
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)

export type Verdict =
  | { readonly ok: true; readonly run: Run }
  | {
      readonly ok: false
      /** The newest full run at or after the release, when one ran and didn't pass. */
      readonly failed?: Run | undefined
      /** The newest green full run, when it ran on an older commit than the release's. */
      readonly older?: Run | undefined
    }

const covers = (relation: Relation | undefined): boolean =>
  relation === "identical" || relation === "ahead"

/**
 * Whether the nightly passed at or after the release's commit, from its runs and how each
 * run's commit stands to the release's (`relations`, by commit; a commit missing there
 * counts as not after it).
 */
export const judge = (runs: readonly Run[], relations: ReadonlyMap<string, Relation>): Verdict => {
  const ordered = candidates(runs, Number.POSITIVE_INFINITY)
  const after = ordered.filter((run) => covers(relations.get(run.sha)))
  const green = after.find((run) => run.conclusion === "success")
  if (green) return { ok: true, run: green }
  return {
    ok: false,
    failed: after[0],
    older: ordered.find((run) => run.conclusion === "success"),
  }
}

const short = (sha: string): string => sha.slice(0, 8)

/** What the promotion's log says of one nightly: a line when it passed, the way out when not. */
export const explain = (nightly: Nightly, tag: string, sha: string, verdict: Verdict): string => {
  if (verdict.ok)
    return `${nightly.name} passed on ${short(verdict.run.sha)}, at or after ${tag} (${short(sha)}): ${verdict.run.url}`
  const seen = verdict.failed
    ? `Its newest run at or after it ended \`${verdict.failed.conclusion}\` on ${short(verdict.failed.sha)}: ${verdict.failed.url}. Fix what failed, or rerun it if it was a flake.`
    : verdict.older
      ? `Its newest green run is on ${short(verdict.older.sha)}, older than the release: ${verdict.older.url}.`
      : "It has no green full run on main."
  return [
    `${tag} (${short(sha)}) has no green ${nightly.name} at or after its commit, so what a pull request skipped may not have run on it. ${seen}`,
    `To unblock: \`gh workflow run ${nightly.file} --ref main\`, wait for it to pass, then promote again.`,
  ].join(" ")
}
