import { type ReleaseNotes } from "../../contract/protocol/src/release-notes.ts"
import { type Commit } from "./commits.ts"

/**
 * One thing a release changed, as the model is asked about it: a commit, or a line a release's
 * own notes already hold (a promotion reuses those).
 */
export type Item = {
  readonly prs: readonly number[]
  readonly line: string
  /** The pull request's `## What`, for a commit. */
  readonly detail: string | undefined
  /** Where it came from, for the model: `feat(ui)` for a commit, `notes` for a reused line. */
  readonly label: string
  /** Whether it counts among the smaller fixes if nothing names it. */
  readonly fix: boolean
}

export const commitItem = (commit: Commit): Item => ({
  prs: commit.pr === undefined ? [] : [commit.pr],
  line: commit.subject,
  detail: commit.what || undefined,
  label: `${commit.type}${commit.scope ? `(${commit.scope})` : ""}`,
  fix: commit.type !== "feat",
})

/** The lines of a prerelease's notes, to be reused: its fixes count is carried apart. */
export const noteItems = (notes: ReleaseNotes): Item[] =>
  notes.changes.map((change) => ({
    prs: change.prs,
    line: change.line,
    detail: undefined,
    label: "notes",
    fix: change.area === "Fixes & speedups",
  }))
