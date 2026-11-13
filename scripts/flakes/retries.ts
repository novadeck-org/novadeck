// Known Flakes' reading of the retry record (retry/record.ts). Each test job of a Quality or
// E2E run uploads its record as a `retried-<job>-<attempt>` artifact when a test passed only
// on a retry; a run's record is all of them, over every attempt, reruns included. From those:
// the pull request's one comment on what its runs retried, each test's count over a week's
// runs against the budget, the issue that names the tests over it, and the tally the weekly
// scoreboard reads. A run that passed with retries is green, so this is where its flakes show;
// the register (register.json) still judges the failures a retry couldn't fix.

import type { Register } from "./match.ts"
import { currentTest } from "./moved-specs.ts"
import { parseRecord, type Retried, withoutColour } from "./retry/record.ts"

/** A retried test, with the artifact (one job's attempt) that recorded it, and that attempt. */
export type RunRetry = Retried & { readonly artifact: string; readonly attempt: number }

/** A finished run, as GitHub describes it. */
export type Run = {
  readonly workflow: string
  readonly run: number
  // Its latest attempt.
  readonly attempt: number
  readonly url: string
  readonly sha: string
  readonly event: string
  readonly branch: string
  readonly pullRequests: readonly number[]
  // When its latest attempt last changed, as ISO 8601.
  readonly at: string
}

/** What a run retried, over all its attempts. */
export type RunRecord = Run & { readonly retried: readonly RunRetry[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A run from the Actions API's run object, failing on one that isn't. */
export const runOf = (data: unknown): Run => {
  if (
    !isRecord(data) ||
    typeof data.name !== "string" ||
    !Number.isInteger(data.id) ||
    !Number.isInteger(data.run_attempt) ||
    typeof data.html_url !== "string" ||
    typeof data.updated_at !== "string" ||
    Number.isNaN(Date.parse(data.updated_at))
  )
    throw new Error("Not a workflow run.")
  const requests = Array.isArray(data.pull_requests) ? data.pull_requests : []
  return {
    // A run's own name is its title, which a workflow's `run-name` sets: the workflow's name,
    // where Retried Tests adds it to the run, is what the comment goes by.
    workflow:
      typeof data.workflow_name === "string" && data.workflow_name !== ""
        ? data.workflow_name
        : data.name,
    run: data.id as number,
    attempt: data.run_attempt as number,
    url: data.html_url,
    sha: typeof data.head_sha === "string" ? data.head_sha : "",
    event: typeof data.event === "string" ? data.event : "",
    branch: typeof data.head_branch === "string" ? data.head_branch : "",
    pullRequests: requests.flatMap((request) =>
      isRecord(request) && Number.isInteger(request.number) ? [request.number as number] : [],
    ),
    at: data.updated_at,
  }
}

// A merge group's branch, as GitHub names it from the queued pull request and its head:
// `gh-readonly-queue/<base>/pr-<number>-<head sha>`. The base may itself hold slashes.
const queueBranch = /^gh-readonly-queue\/.+\/pr-([1-9]\d*)-[0-9a-f]{40}$/

/**
 * The pull requests a run is for. A pull request's run names them; a merge group's names
 * none, so its one is read from the group's branch, and only for a run GitHub started for a
 * group, as any pull request's branch could carry that name.
 */
export const pullRequestsOf = (run: Pick<Run, "event" | "branch" | "pullRequests">) => {
  if (run.pullRequests.length || run.event !== "merge_group") return run.pullRequests
  const found = queueBranch.exec(run.branch)
  return found ? [Number(found[1])] : []
}

/** The attempt an artifact's name ends in (`retried-macOS-2`), as the jobs name them. */
export const attemptOf = (artifact: string): number => {
  const found = /-(\d+)$/.exec(artifact)
  if (!found) throw new Error(`The artifact ${artifact} names no attempt.`)
  return Number(found[1])
}

/** A run's record, from each of its artifacts' record files, by artifact name. */
export const runRecord = (
  run: Run,
  artifacts: ReadonlyMap<string, readonly string[]>,
): RunRecord => ({
  ...run,
  retried: [...artifacts]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([artifact, files]) =>
      files.flatMap((text) =>
        parseRecord(text).map((entry) => ({ ...entry, artifact, attempt: attemptOf(artifact) })),
      ),
    ),
})

/** A test's key across runs: its package and its id, as the specs' moves renamed it. */
export const testKey = (entry: Pick<Retried, "package" | "test">): string =>
  `${entry.package} ${currentTest(entry.test)}`

/**
 * The register's flake for a retried test, if any: one whose test the test's id begins with,
 * as match.ts reads it, and whose signature one of its recorded errors matches. The signature
 * counts as it does when Triage judges a log: an entry may name a whole folder (a process
 * left behind, in any end to end test), and a test of it that failed some other way isn't
 * that flake.
 */
export const registered = (register: Register, test: string, errors: readonly string[]) =>
  register.flakes.find(
    (flake) =>
      flake.test !== undefined &&
      currentTest(test).startsWith(currentTest(flake.test)) &&
      errors.some((error) => new RegExp(flake.signature).test(error)),
  )

// What keeps an `@` from mentioning anyone, unseen.
const zeroWidth = String.fromCharCode(0x200b)

/**
 * Text from a record, which a pull request's tests wrote, made safe for a Markdown table cell:
 * no column breaks, no HTML, and no mention that would notify anyone.
 */
export const cell = (text: string, length = 200): string => {
  // Without colours, as a comment's state from before the record took them out still has them.
  const one = withoutColour(text).replaceAll(/\s*\n\s*/g, " ")
  const cut = one.length > length ? `${one.slice(0, length - 1)}…` : one
  return cut.replaceAll("<", "&lt;").replaceAll("|", "\\|").replaceAll("@", `@${zeroWidth}`)
}

const standing = (register: Register, test: string, errors: readonly string[]): string => {
  const flake = registered(register, test, errors)
  if (!flake) return "not registered"
  return flake.status === "fixed" ? `**${flake.id}, registered as fixed: back**` : flake.id
}

/** A run's record as Markdown, for the job's summary. */
export const recordSummary = (record: RunRecord, register: Register): string => {
  const head = `## Retried tests: ${cell(record.workflow)}`
  const link = `([run ${record.run}](${record.url}))`
  if (!record.retried.length) return `${head}\n\nNo test needed a retry. ${link}\n`
  return [
    head,
    "",
    `${record.retried.length} test(s) passed only on a retry. ${link}`,
    "",
    "| Test | Package | Job | Runs | First failure | Register |",
    "| --- | --- | --- | --- | --- | --- |",
    ...record.retried.map(
      (entry) =>
        `| ${cell(entry.test)} | ${cell(entry.package)} | ${cell(entry.artifact)} | ${entry.attempts} | ${cell(entry.error)} | ${standing(register, entry.test, [entry.error])} |`,
    ),
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------------------
// The count over a window, and the budget
// ---------------------------------------------------------------------------------------

/** A test's retries over a window: the runs it needed one in, and how many runs those took. */
export type Tally = {
  readonly key: string
  readonly test: string
  readonly package: string
  // Distinct runs it was retried in; two attempts of one run count once.
  readonly runs: number
  // Every run it took beyond the first, over them all.
  readonly retries: number
  readonly last: string
  readonly links: readonly string[]
  // Each distinct first failure's first line, as shown, and in full, as the register reads it.
  readonly errors: readonly string[]
  readonly failures: readonly string[]
}

/** Each retried test's count over the records, most retried first. */
export const tally = (records: readonly RunRecord[]): readonly Tally[] => {
  type Found = {
    test: string
    package: string
    runs: Set<number>
    retries: number
    last: string
    links: string[]
    errors: Set<string>
    failures: Set<string>
  }
  const byTest = new Map<string, Found>()
  for (const record of records)
    for (const entry of record.retried) {
      const key = testKey(entry)
      const found: Found = byTest.get(key) ?? {
        test: currentTest(entry.test),
        package: entry.package,
        runs: new Set(),
        retries: 0,
        last: "",
        links: [],
        errors: new Set(),
        failures: new Set(),
      }
      if (!found.runs.has(record.run)) found.links.push(record.url)
      found.runs.add(record.run)
      found.retries += entry.attempts - 1
      if (record.at > found.last) found.last = record.at
      found.errors.add(entry.error.split("\n")[0]!)
      found.failures.add(entry.error)
      byTest.set(key, found)
    }
  return [...byTest]
    .map(([key, found]) => ({
      key,
      test: found.test,
      package: found.package,
      runs: found.runs.size,
      retries: found.retries,
      last: found.last,
      links: found.links,
      errors: [...found.errors],
      failures: [...found.failures],
    }))
    .toSorted((a, b) => b.runs - a.runs || b.retries - a.retries || a.key.localeCompare(b.key))
}

/**
 * The retry budget: a test retried in this many distinct runs within the window is over it,
 * as is one the register says was fixed, at its first retry.
 */
export const budget = { runs: 3, days: 7 } as const

/** Why a test is over the budget, or undefined while it is within it. */
export const overBudget = (entry: Tally, register: Register): string | undefined => {
  if (registered(register, entry.test, entry.failures)?.status === "fixed")
    return "registered as fixed, and retried again"
  if (entry.runs >= budget.runs) return `retried in ${entry.runs} runs in ${budget.days} days`
  return undefined
}

/** The records of a window's runs, those whose latest attempt ended at or after `since`. */
export const within = (records: readonly RunRecord[], since: Date): readonly RunRecord[] =>
  records.filter((record) => Date.parse(record.at) >= since.getTime())

const tableHeader = [
  "| Test | Package | Runs | Retries | Last runs | First failure | Why |",
  "| --- | --- | --- | --- | --- | --- | --- |",
]

const tallyRow = (entry: Tally, why: string): string =>
  `| ${cell(entry.test)} | ${cell(entry.package)} | ${entry.runs} | ${entry.retries} | ${entry.links
    .slice(-3)
    .map((link, index) => `[${index + 1}](${link})`)
    .join(" ")} | ${cell(entry.errors[0] ?? "", 160)} | ${why} |`

/** The tests over the budget, each with why. */
export const overOf = (tallied: readonly Tally[], register: Register) =>
  tallied.flatMap((entry) => {
    const why = overBudget(entry, register)
    return why ? [{ entry, why }] : []
  })

/** The tally as Markdown, those over the budget first. */
export const tallySummary = (
  tallied: readonly Tally[],
  register: Register,
  { runs, since }: { readonly runs: number; readonly since: Date },
): string => {
  const over = overOf(tallied, register)
  const rest = tallied.filter((entry) => !overBudget(entry, register))
  return [
    `## Retried tests since ${since.toISOString().slice(0, 10)}`,
    "",
    `${tallied.length} test(s) passed only on a retry, across ${runs} run(s) that retried one. ` +
      `The budget: fewer than ${budget.runs} runs in ${budget.days} days, and none for a flake registered as fixed.`,
    "",
    ...(over.length
      ? [
          `### Over the budget: ${over.length}`,
          "",
          ...tableHeader,
          ...over.map(({ entry, why }) => tallyRow(entry, why)),
          "",
        ]
      : ["Every retried test is within the budget.", ""]),
    ...(rest.length
      ? [
          "### Within the budget",
          "",
          ...tableHeader,
          ...rest.map((entry) => tallyRow(entry, standing(register, entry.test, entry.failures))),
          "",
        ]
      : []),
  ].join("\n")
}

/**
 * The tally the weekly scoreboard reads, as the `flake-tally` artifact's tally.json. Its shape
 * is documented in docs/development.md ("Retried tests"); change both together.
 */
export type TallyReport = {
  readonly since: string
  readonly until: string
  readonly days: number
  readonly budget: { readonly runs: number; readonly days: number }
  // The runs in the window that retried a test.
  readonly runs: number
  readonly tests: readonly {
    readonly test: string
    readonly package: string
    readonly runs: number
    readonly retries: number
    readonly last: string
    // Why it is over the budget, or null within it.
    readonly over: string | null
    // Its flake in the register, or null.
    readonly flake: string | null
  }[]
}

export const tallyReport = (
  tallied: readonly Tally[],
  register: Register,
  { since, until, runs }: { readonly since: Date; readonly until: Date; readonly runs: number },
): TallyReport => ({
  since: since.toISOString(),
  until: until.toISOString(),
  days: Math.round((until.getTime() - since.getTime()) / 86_400_000),
  budget,
  runs,
  tests: tallied.map((entry) => ({
    test: entry.test,
    package: entry.package,
    runs: entry.runs,
    retries: entry.retries,
    last: entry.last,
    over: overBudget(entry, register) ?? null,
    flake: registered(register, entry.test, entry.failures)?.id ?? null,
  })),
})

// ---------------------------------------------------------------------------------------
// The issue for the tests over the budget
// ---------------------------------------------------------------------------------------

/** The budget issue's title, by which it is found again. */
export const budgetTitle = "Tests over the retry budget"

const budgetMarker = "<!-- known-flakes:budget "

/** The tests over the budget an issue body names, by key, from the marker it carries. */
export const keysNamed = (body: string): readonly string[] => {
  const start = body.indexOf(budgetMarker)
  if (start < 0) return []
  const end = body.indexOf(" -->", start)
  try {
    const keys: unknown = JSON.parse(
      Buffer.from(body.slice(start + budgetMarker.length, end), "base64").toString("utf8"),
    )
    return Array.isArray(keys) ? keys.filter((key) => typeof key === "string") : []
  } catch {
    return []
  }
}

/** What the day's tally does to the budget issue (`open`, the open one, or null). */
export type IssueAction =
  | { readonly kind: "none" }
  | { readonly kind: "open"; readonly title: string; readonly body: string }
  | {
      readonly kind: "edit"
      readonly issue: number
      readonly body: string
      // When tests joined the list, so its watchers hear of them.
      readonly comment?: string
    }
  | { readonly kind: "close"; readonly issue: number; readonly body: string }

export const budgetAction = (
  tallied: readonly Tally[],
  register: Register,
  open: { readonly number: number; readonly body: string } | null,
  { url, since }: { readonly url: string; readonly since: Date },
): IssueAction => {
  const over = overOf(tallied, register)
  if (!over.length)
    return open
      ? {
          kind: "close",
          issue: open.number,
          body: `Every retried test is within the budget again ([tally](${url})).`,
        }
      : { kind: "none" }
  const keys = over.map(({ entry }) => entry.key)
  const body = [
    `${budgetMarker}${Buffer.from(JSON.stringify(keys)).toString("base64")} -->`,
    `These tests passed on CI only after failing first more often than the budget allows: ` +
      `${budget.runs} or more runs in ${budget.days} days, or any retry of a flake the register ` +
      `says was fixed. Counted from the runs since ${since.toISOString().slice(0, 10)} ([tally](${url})).`,
    "",
    ...tableHeader,
    ...over.map(({ entry, why }) => tallyRow(entry, why)),
    "",
    "A retry keeps a pull request green, so a race it hides shows only here: find each one's " +
      "cause and fix it, or register it in `scripts/flakes/register.json` while it's being " +
      "found. Known Flakes edits this list each morning, and closes this issue once every " +
      'retried test is within the budget. See docs/development.md, "Retried tests".',
    "",
    `A test stays listed while its retried runs in the last ${budget.days} days are over the ` +
      "budget, even once a fix has landed: the count doesn't know of the fix, so a fixed test " +
      "leaves the list as its runs age out. Its last runs show whether it still fails after it.",
  ].join("\n")
  if (!open) return { kind: "open", title: budgetTitle, body }
  const before = new Set(keysNamed(open.body))
  const joined = over.filter(({ entry }) => !before.has(entry.key))
  return {
    kind: "edit",
    issue: open.number,
    body,
    ...(joined.length
      ? {
          comment: `Over the budget now: ${joined
            .map(({ entry }) => `\`${cell(entry.test, 120)}\` (${cell(entry.package)})`)
            .join(", ")}.`,
        }
      : {}),
  }
}

// ---------------------------------------------------------------------------------------
// The pull request's comment
// ---------------------------------------------------------------------------------------

/** What marks the pull request's one comment, which each of its runs updates. */
export const commentMarker = "<!-- known-flakes:retried -->"
const stateMarker = "<!-- state "

/** A test the pull request's runs retried, with the runs it needed one in. */
type Seen = {
  readonly test: string
  readonly package: string
  readonly error: string
  // A merge group's run is marked, as it ran the change on top of the queue, not alone.
  readonly runs: readonly { readonly run: number; readonly url: string; readonly queue?: true }[]
}

const parseState = (body: string | undefined): readonly Seen[] => {
  if (!body) return []
  const start = body.indexOf(stateMarker)
  if (start < 0) return []
  const end = body.indexOf(" -->", start)
  try {
    const state: unknown = JSON.parse(
      Buffer.from(body.slice(start + stateMarker.length, end), "base64").toString("utf8"),
    )
    if (!Array.isArray(state)) return []
    return state.filter(
      (seen): seen is Seen =>
        isRecord(seen) &&
        typeof seen.test === "string" &&
        typeof seen.package === "string" &&
        typeof seen.error === "string" &&
        Array.isArray(seen.runs),
    )
  } catch {
    return []
  }
}

/** The packages a pull request's changed files are in, by name, from each folder's name. */
export const packagesChanged = (
  files: readonly string[],
  names: ReadonlyMap<string, string>,
): ReadonlySet<string> =>
  new Set(
    files.flatMap((file) => {
      const name = names.get(file.split("/").slice(0, 2).join("/"))
      return name ? [name] : []
    }),
  )

const seenRow = (each: Seen): string =>
  `| ${cell(each.test)} | ${cell(each.package)} | ${each.runs
    .slice(-5)
    .map((run) => `[${run.run}](${run.url})${run.queue ? " (queue)" : ""}`)
    .join(" ")} | ${cell(each.error, 160)} |`

/**
 * The pull request's comment after a run: what its runs have retried so far, this run's
 * added to what the comment held, the tests in packages the pull request changes first. No
 * comment while nothing was retried.
 */
export const prComment = (
  previous: string | undefined,
  record: RunRecord,
  changed: ReadonlySet<string>,
): string | undefined => {
  const seen = new Map(parseState(previous).map((each) => [testKey(each), each]))
  for (const entry of record.retried) {
    const key = testKey(entry)
    const before = seen.get(key)
    const runs = before?.runs ?? []
    seen.set(key, {
      test: currentTest(entry.test),
      package: entry.package,
      error: before?.error ?? entry.error.split("\n")[0]!.slice(0, 300),
      runs: runs.some((each) => each.run === record.run)
        ? runs
        : [
            ...runs,
            {
              run: record.run,
              url: record.url,
              ...(record.event === "merge_group" ? { queue: true as const } : {}),
            },
          ],
    })
  }
  if (!seen.size) return undefined
  const all = [...seen.values()].toSorted(
    (a, b) => b.runs.length - a.runs.length || a.test.localeCompare(b.test),
  )
  const mine = all.filter((each) => changed.has(each.package))
  const rest = all.filter((each) => !changed.has(each.package))
  const header = ["| Test | Package | Runs | First failure |", "| --- | --- | --- | --- |"]
  return [
    commentMarker,
    `${stateMarker}${Buffer.from(JSON.stringify(all)).toString("base64")} -->`,
    "## Tests that passed only on a retry",
    "",
    "These failed first on this pull request's CI and passed when run again, so its checks " +
      "stayed green. A retry can hide a race the change brings, as #798's flake did.",
    "",
    ...(mine.length
      ? [
          `**${mine.length} in packages this pull request changes:**`,
          "",
          ...header,
          ...mine.map(seenRow),
          "",
        ]
      : ["None in packages this pull request changes.", ""]),
    ...(rest.length
      ? [
          `<details><summary>${rest.length} elsewhere, most likely flakes this change doesn't touch</summary>`,
          "",
          ...header,
          ...rest.map(seenRow),
          "",
          "</details>",
          "",
        ]
      : []),
    'Known Flakes updates this comment after each run, and counts each retry against the budget (docs/development.md, "Retried tests").',
    "",
  ].join("\n")
}
