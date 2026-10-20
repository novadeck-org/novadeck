import { logs } from "../log.js"

const log = logs.for("terminals")

const failure =
  (evt: string, msg: string) =>
  (error: unknown): void =>
    log.error(evt, msg, { err: error })

/** What the terminals log of the failures they carry on after, each a handler of what was thrown. */
export const failed = {
  integration: failure(
    "shell.integration-unavailable",
    "Novadeck shell integration is unavailable",
  ),
  /** Logs a report that failed and gives `fallback` in its place. */
  report:
    <T>(fallback: T) =>
    (error: unknown): T => {
      failure("reports.take-failed", "Novadeck could not take an agent report")(error)
      return fallback
    },
  title: failure("terminals.title-failed", "Novadeck could not read a title"),
  following: failure("harnesses.follow-failed", "Novadeck stopped following an agent"),
  followingSubagent: failure(
    "harnesses.follow-subagent-failed",
    "Novadeck stopped following a subagent",
  ),
}
