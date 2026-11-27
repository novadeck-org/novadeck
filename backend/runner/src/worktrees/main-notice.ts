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

/**
 * The terminals to tell that main moved in the repository whose main checkout is `home`: those
 * working in that checkout (not a worktree) whose agent is mid-turn, which gets the notice with
 * the hook it is already running. An idle agent is not woken for it: it can read main when it next works.
 */
export const terminalsToTell = (
  checkouts: readonly {
    readonly terminalId: string
    readonly root: string
    readonly working: boolean
  }[],
  home: string,
): string[] =>
  checkouts
    .filter(({ root, working }) => root === home && working)
    .map(({ terminalId }) => terminalId)
