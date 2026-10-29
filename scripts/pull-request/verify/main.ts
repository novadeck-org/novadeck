import { attributionErrors } from "./attribution.ts"
import { pullRequestCommits } from "./commits.ts"
import { requiredSections, verifyPullRequest } from "./verify.ts"

export const main = (): void => {
  const result = verifyPullRequest(
    process.env.PR_TITLE ?? "",
    process.env.PR_BODY ?? "",
    requiredSections(process.env.PR_AUTHOR ?? ""),
  )

  for (const message of result.titleErrors) {
    console.error(`::error title=Invalid pull request title::${message}`)
  }
  for (const message of result.descriptionErrors) {
    console.error(`::error title=Missing pull request section::${message}`)
  }

  const attribution = attributionErrors([
    { label: "The pull request title", text: process.env.PR_TITLE ?? "" },
    { label: "The pull request description", text: process.env.PR_BODY ?? "" },
    ...pullRequestCommits(process.env),
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
