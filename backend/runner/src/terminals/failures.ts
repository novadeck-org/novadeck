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
  /**
   * What terminal `terminalId`'s host carried on past: a listener of `event` that threw, or, as
   * `"parse"`, output its screen could not parse.
   */
  terminal: (error: unknown, event: string, terminalId: string): void =>
    event === "parse"
      ? log.error("terminals.parse-failed", "Novadeck could not draw a terminal's output", {
          data: { terminalId },
          err: error,
        })
      : log.error("terminals.listener-failed", "Novadeck could not handle a terminal's event", {
          data: { terminalId, event },
          err: error,
        }),
  following: failure("harnesses.follow-failed", "Novadeck stopped following an agent"),
  interrupted: failure(
    "terminals.interrupted-notice-failed",
    "Novadeck could not tell a resumed agent to carry on",
  ),
  followingSubagent: failure(
    "harnesses.follow-subagent-failed",
    "Novadeck stopped following a subagent",
  ),
}
