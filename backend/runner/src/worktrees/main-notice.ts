import { noticeText } from "../messaging/notice-format.js"
import type { Landing } from "./landing.js"

/** How many changed files a notice names. */
const named = 12

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

/**
 * What an agent working in a repository's own checkout is told when the runner moved its main:
 * facts only, the commits and the files that changed under it, and the lockfile among them.
 */
export const mainNotice = (repository: string, landing: Landing): string => {
  const shown = landing.files.slice(0, named)
  const more = landing.filesTotal - shown.length
  return noticeText("Main", {
    facts: `main in ${repository} moved ${plural(landing.commits, "commit")} from origin; ${plural(landing.filesTotal, "file")} changed.`,
    details: [
      ...shown,
      ...(more > 0 ? [`and ${more} more`] : []),
      ...(landing.dependencies ? [`${landing.dependencies.file} is among them`] : []),
    ],
  })
}
