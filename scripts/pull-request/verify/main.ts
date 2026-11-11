import { attributionErrors } from "./attribution.ts"
import { pullRequestCommits } from "./commits.ts"
import { queuedEnv } from "./queued.ts"
import { requiredSections, verifyPullRequest } from "./verify.ts"

export const main = (): void => {
  // A merge group's event names no pull request: its own is read from the group's branch.
  const env = process.env.GITHUB_EVENT_NAME === "merge_group" ? queuedEnv(process.env) : process.env
  const result = verifyPullRequest(
    env.PR_TITLE ?? "",
    env.PR_BODY ?? "",
    requiredSections(env.PR_AUTHOR ?? ""),
  )

  for (const message of result.titleErrors) {
    console.error(`::error title=Invalid pull request title::${message}`)
  }
  for (const message of result.descriptionErrors) {
    console.error(`::error title=Missing pull request section::${message}`)
  }

  const attribution = attributionErrors([
    { label: "The pull request title", text: env.PR_TITLE ?? "" },
    { label: "The pull request description", text: env.PR_BODY ?? "" },
    ...pullRequestCommits(env),
  ])
  for (const message of attribution) {
    console.error(`::error title=AI attribution::${message}`)
  }

  process.exitCode =
    result.titleErrors.length > 0 || result.descriptionErrors.length > 0 || attribution.length > 0
      ? 1
      : 0
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
