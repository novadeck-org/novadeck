import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

import { timingComment, type TimingReport } from "./timing.ts"

const read = (path: string): TimingReport => {
  const report: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (typeof report !== "object" || report === null) throw new Error(`${path} is not a report.`)
  return report as TimingReport
}

// Main's last report, if one is there and reads as version 1; one that doesn't is noted
// and left out, as it says nothing about this run.
const readMain = (path: string | undefined): TimingReport | undefined => {
  if (!path || !existsSync(path)) return undefined
  try {
    const report = read(path)
    if (report.version !== 1) throw new Error(`it is version ${JSON.stringify(report.version)}`)
    return report
  } catch (error) {
    console.error(
      `::warning title=Main's timing report unread::${String(error).split("\n")[0]}; reported without it.`,
    )
    return undefined
  }
}

// The comment, beside main's report when it renders; one whose fields aren't what this
// reads is left out as one that doesn't read is. This run's own report renders first, so
// a fault in it is never laid at main's door.
export const besideMain = (
  report: TimingReport,
  main: TimingReport | undefined,
  label: string,
): string => {
  const alone = timingComment(report, { label })
  if (!main) return alone
  try {
    return timingComment(report, { main, label })
  } catch (error) {
    console.error(
      `::warning title=Main's timing report unread::${String(error).split("\n")[0]}; reported without it.`,
    )
    return alone
  }
}

// `node scripts/benchmark/timing-main.ts <report> [main's report] [comment file]`: the
// timing run's report as Markdown, beside main's last one when given, in the job summary
// and, for a pull request, in the file its comment step posts. It never fails on the
// numbers, a trend and not a gate; only on this run's report missing or not reading.
export const main = (
  reportPath = process.argv[2],
  mainPath = process.argv[3],
  commentPath = process.argv[4],
): void => {
  if (!reportPath || !existsSync(reportPath)) {
    console.error(`::error title=No timing report::${reportPath ?? "(none given)"} is missing.`)
    process.exitCode = 1
    return
  }
  const report = read(reportPath)
  if (report.version !== 1)
    console.error(
      `::warning title=Unknown timing report::It says version ${JSON.stringify(report.version)}; this reads version 1.`,
    )
  const mainReport = readMain(mainPath)
  const label = commentPath ? "This pull request" : "This run"
  const comment = besideMain(report, mainReport, label)
  console.log(comment)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, comment)
  if (commentPath) writeFileSync(commentPath, comment)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
