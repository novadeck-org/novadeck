import type { PullRequest as Found, Check } from "@novadeck/forges"
import { forgeLimits, type PullRequest, type PullRequestCheck } from "@novadeck/protocol"

// A forge's pull request as the contract carries it on a work: only the fields the contract
// names (the runner keeps the rest, as each check's runner kind, for the agents' listing), a
// long title or check name cut, the checks capped, and each check's state in the contract's
// words: queued for a runner, or held by an approval, a concurrency group or an earlier job, is
// `waiting`; a trigger job held by the downstream pipeline it started is `running`.

const states: Record<Check["state"], PullRequestCheck["state"]> = {
  passed: "passed",
  failed: "failed",
  running: "running",
  queued: "waiting",
  held: "waiting",
}

export const wirePullRequest = (found: Found): PullRequest => {
  const { number, url, title, state, ci, base, checks, review } = found
  const listed = (checks ?? []).flatMap((check): PullRequestCheck[] => {
    // A trigger job runs while the pipeline it started does.
    const shown = check.hold === "downstream" ? "running" : states[check.state]
    return check.name === "" || shown === undefined
      ? []
      : [{ name: check.name.slice(0, forgeLimits.check), state: shown }]
  })
  return {
    number,
    url,
    title: title.slice(0, forgeLimits.title),
    state,
    ...(ci !== undefined && { ci }),
    // A longer name is no branch a worktree could be on.
    ...(base !== undefined && base !== "" && base.length <= forgeLimits.branch && { base }),
    ...(listed.length > 0 && { checks: listed.slice(0, forgeLimits.checks) }),
    ...(review !== undefined && { review }),
  }
}
