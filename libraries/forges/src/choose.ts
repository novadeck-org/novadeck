import type { PullRequest } from "./forge.js"

/** A pull request found for a branch, with when it last settled (epoch ms; 0 if unknown). */
export type Candidate = { readonly pull: PullRequest; readonly at: number }

const latest = (
  candidates: readonly Candidate[],
  states: readonly PullRequest["state"][],
): Candidate | undefined =>
  candidates
    .filter((candidate) => states.includes(candidate.pull.state))
    .reduce<Candidate | undefined>(
      (best, next) => (best === undefined || next.at > best.at ? next : best),
      undefined,
    )

/** The one to show: an open one, else the latest merged, else the latest closed. */
export const choose = (candidates: readonly Candidate[]): PullRequest | undefined =>
  (
    latest(candidates, ["open", "draft"]) ??
    latest(candidates, ["merged"]) ??
    latest(candidates, ["closed"])
  )?.pull

export const time = (value: unknown): number => {
  if (typeof value !== "string") return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}
