import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { parseRegister, type Register } from "./match.ts"
import {
  budgetAction,
  overOf,
  packagesChanged,
  prComment,
  pullRequestsOf,
  recordSummary,
  runOf,
  runRecord,
  tally,
  tallyReport,
  tallySummary,
  within,
  type RunRecord,
} from "./retries.ts"

// Known Flakes' readings of the retry record (retries.ts), as its workflow runs them. The
// workflow does the GitHub calls; these read what it downloaded and write what it posts.
//
// `comment <run.json> <artifacts dir> <changed files> <previous comment> <comment out>`: a pull
// request's comment after a run. run.json is the run as the Actions API gives it; the artifacts
// dir holds the run's `retried-*` artifacts, a folder each; the changed files are the pull
// request's, a line each; the previous comment is the one it has, or an empty file. Writes the
// comment, or nothing when no test was retried.
//
// `pulls <run.json>`: the numbers of the pull requests the run is for, a space between, a merge
// group's from its branch; nothing for a run that is for none.
//
// `tally <runs dir> <days> <out dir> <open issue>`: each test's retries over the runs of the
// last days. The runs dir holds a folder per run: its run.json and its `retried-*` artifacts.
// The open issue is the budget issue's {number, body} as JSON, or an empty file. Writes
// tally.json (the scoreboard's), issue.json (what to do to the budget issue) and `over` to
// GITHUB_OUTPUT.

const registerPath = "scripts/flakes/register.json"
const register = (): Register => parseRegister(JSON.parse(readFileSync(registerPath, "utf8")))

const summarize = (text: string): void => {
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
}

const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "")

/** Every record file under each artifact folder of a folder, by artifact. */
const artifactsIn = (folder: string): Map<string, string[]> =>
  new Map(
    (existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : [])
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("retried-"))
      .map((entry) => [
        entry.name,
        readdirSync(join(folder, entry.name), { withFileTypes: true, recursive: true })
          .filter((file) => file.isFile() && file.name.endsWith(".jsonl"))
          .map((file) => join(file.parentPath, file.name))
          .toSorted()
          .map((path) => readFileSync(path, "utf8")),
      ]),
  )

/** The workspace's packages' names, by folder, from the checkout. */
const packageNames = (): Map<string, string> =>
  new Map(
    ["apps", "backend", "contract", "engines", "frontend", "harnesses", "libraries", "tools"]
      .filter((tree) => existsSync(tree))
      .flatMap((tree) => readdirSync(tree).map((name) => `${tree}/${name}`))
      .filter((folder) => existsSync(join(folder, "package.json")))
      .flatMap((folder) => {
        const { name } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as {
          readonly name?: unknown
        }
        return typeof name === "string" ? [[folder, name] as const] : []
      }),
  )

const comment = (
  runFile: string,
  artifacts: string,
  changedFiles: string,
  previous: string,
  out: string,
): void => {
  const record = runRecord(runOf(JSON.parse(readFileSync(runFile, "utf8"))), artifactsIn(artifacts))
  summarize(recordSummary(record, register()))
  const files = read(changedFiles).split(/\r?\n/).filter(Boolean)
  const body = prComment(
    read(previous) || undefined,
    record,
    packagesChanged(files, packageNames()),
  )
  if (body) writeFileSync(out, body)
}

const tallyRuns = (runs: string, days: number, out: string, openIssue: string): void => {
  if (!Number.isFinite(days) || days <= 0) throw new Error(`Not a number of days: ${days}`)
  const flakes = register()
  const records: RunRecord[] = (existsSync(runs) ? readdirSync(runs) : [])
    .filter((name) => existsSync(join(runs, name, "run.json")))
    .map((name) =>
      runRecord(
        runOf(JSON.parse(readFileSync(join(runs, name, "run.json"), "utf8"))),
        artifactsIn(join(runs, name)),
      ),
    )
  const until = new Date()
  const since = new Date(until.getTime() - days * 86_400_000)
  const counted = within(records, since)
  const tallied = tally(counted)
  summarize(tallySummary(tallied, flakes, { runs: counted.length, since }))
  writeFileSync(
    join(out, "tally.json"),
    `${JSON.stringify(tallyReport(tallied, flakes, { since, until, runs: counted.length }), null, 2)}\n`,
  )
  const open = read(openIssue).trim()
  const action = budgetAction(tallied, flakes, open ? (JSON.parse(open) as never) : null, {
    url: process.env.RUN_URL ?? "",
    since,
  })
  writeFileSync(join(out, "issue.json"), `${JSON.stringify(action, null, 2)}\n`)
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `over=${overOf(tallied, flakes).length}\n`)
}

export const main = (args = process.argv.slice(2)): void => {
  const [command, ...rest] = args
  if (command === "pulls" && rest.length === 1) {
    const numbers = pullRequestsOf(runOf(JSON.parse(readFileSync(rest[0]!, "utf8"))))
    if (numbers.length) console.log(numbers.join(" "))
    return
  }
  if (command === "comment" && rest.length === 5)
    return comment(rest[0]!, rest[1]!, rest[2]!, rest[3]!, rest[4]!)
  if (command === "tally" && rest.length === 4)
    return tallyRuns(rest[0]!, Number(rest[1]), rest[2]!, rest[3]!)
  throw new Error(
    "Usage: retries-main.ts comment <run.json> <artifacts> <changed files> <previous> <out>" +
      " | pulls <run.json> | tally <runs dir> <days> <out dir> <open issue>",
  )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
