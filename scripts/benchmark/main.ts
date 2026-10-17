import { appendFileSync, existsSync, readFileSync } from "node:fs"

import {
  budgetChanges,
  changedScripts,
  checkCounters,
  countersSummary,
  failsAt,
  goneBudgets,
  parseBaseBudgets,
  parseBudgets,
  parseReading,
  sharesBudgets,
  tickChanges,
} from "./counters.ts"

const readingPath = "application/ui/test-results/counters.json"
const budgetsPath = "application/ui/src/specs/counters/budgets.json"

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"))

// An annotation's text on one line, as the workflow command needs.
const oneLine = (text: string): string => text.replaceAll(/\s+/g, " ")

// `node scripts/benchmark/main.ts [base budgets]`, after the counter run: checks its
// reading against the budgets, and the budgets against the base branch's when given;
// writes the summary to the job's, and fails on a count past `failsAt` times its budget
// (warning on one past it), a script that
// changed under its budgets, or a raise that doesn't say why. A base file given but not
// there, or that doesn't read, is an error: it would let any raise through unseen. In a
// pull request, PULL_REQUEST names its number, which a raise must name.
export const main = (basePath = process.argv[2]): void => {
  const reading = parseReading(readJson(readingPath))
  const budgets = parseBudgets(readJson(budgetsPath), budgetsPath)
  if (basePath && !existsSync(basePath)) throw new Error(`No base budgets at ${basePath}.`)
  const raw = basePath ? readJson(basePath) : undefined
  const base = basePath ? parseBaseBudgets(raw, "The base branch's budget file") : undefined
  // A base that has none of the phases compares with nothing: every budget shows as new,
  // and the gate warns.
  const compared = base !== undefined && sharesBudgets(base)
  const pullRequest = Number(process.env.PULL_REQUEST) || undefined
  const rows = checkCounters(reading, budgets)
  const scripts = changedScripts(reading, budgets)
  const changes = base ? budgetChanges(budgets, base, pullRequest) : []
  const tickNotes = base ? tickChanges(budgets, base) : []
  const gone = base ? goneBudgets(budgets, raw) : []
  const summary = countersSummary(reading, rows, {
    changes,
    scripts,
    tickNotes,
    gone,
    compared,
  })
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  if (!compared)
    console.error(
      "::warning title=Budgets not compared::No base budgets to compare with, so budget changes aren't checked.",
    )
  for (const budget of gone)
    console.error(`::warning title=Budget dropped::${oneLine(budget)} is no longer budgeted.`)
  for (const script of scripts) console.error(`::error title=Script changed::${oneLine(script)}`)
  const fails = rows.filter((row) => row.verdict === "fails")
  for (const { phase, counter, value, budget } of fails)
    console.error(
      `::error title=Counter past ${failsAt}× its budget::${phase} ${counter} is ${value}, over ${failsAt}× its budget of ${budget}.`,
    )
  for (const { phase, counter, value, budget } of rows.filter((row) => row.verdict === "over"))
    console.error(
      `::warning title=Counter over budget::${phase} ${counter} is ${value}, over its budget of ${budget} but within ${failsAt}× it.`,
    )
  for (const { phase, counter, value, budget } of rows.filter((row) => row.verdict === "under"))
    console.error(
      `::warning title=Counter under budget::${phase} ${counter} is ${value}, under its budget of ${budget}: lower the budget to keep the gain.`,
    )
  const unexplained = changes.filter((change) => change.problem)
  for (const { phase, counter, from, to, problem } of unexplained)
    console.error(
      `::error title=Budget raise not explained::${oneLine(`${phase} ${counter} ${from === undefined ? `is new at ${to}` : `went from ${from} to ${to}`}. ${problem}`)}`,
    )
  process.exitCode = fails.length || scripts.length || unexplained.length ? 1 : 0
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
