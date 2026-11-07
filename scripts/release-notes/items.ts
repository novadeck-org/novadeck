import { type Commit } from "./commits.ts"

/** One thing a release changed, as the model is asked about it: a commit. */
export type Item = {
  readonly prs: readonly number[]
  readonly line: string
  /** The pull request's `## What`, for a commit. */
  readonly detail: string | undefined
  /** Its `## Why`. */
  readonly reason: string | undefined
  /** Its type and scope, for the model: `feat(ui)`. */
  readonly label: string
  /** Whether it counts among the smaller fixes if nothing names it. */
  readonly fix: boolean
}

export const commitItem = (commit: Commit): Item => ({
  prs: commit.pr === undefined ? [] : [commit.pr],
  line: commit.subject,
  detail: commit.what || undefined,
  reason: commit.why || undefined,
  label: `${commit.type}${commit.scope ? `(${commit.scope})` : ""}`,
  fix: commit.type !== "feat",
})
