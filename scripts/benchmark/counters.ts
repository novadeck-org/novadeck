// The counter run's reading against its budgets. The run gives the same counts every
// time, so a count past its budget is a regression, never noise: the gate warns on it, and
// fails on one past `failsAt` times it.
// Commits and component renders are framework cost, reported beside them, never gated.
// Work that really costs more may raise a budget in the same pull request, saying why and
// where the cost comes from; every changed budget shows in the summary, old to new.

export const phases = ["grid", "focus", "switches"] as const
export const gated = ["wakes", "mutations", "bytes", "streamingPeak", "streamingSettled"] as const
const ticked = ["wakes", "mutations", "commits", "renders"] as const

type Phase = (typeof phases)[number]
type Gated = (typeof gated)[number]

// What frontend/specs/src/counters/ leaves in test-results/counters.json.
export type PhaseReading = {
  readonly ticks: number
  readonly tickTotals: Readonly<Record<(typeof ticked)[number], number>>
  readonly bytes: number
  readonly streamingPeak: number
  readonly streamingSettled: number
}
export type Reading = Readonly<Record<Phase, PhaseReading>>

// A counter's budget: a count, or a raised one with why it was raised and the pull request
// or commit it came from.
export type Budget =
  | number
  | { readonly budget: number; readonly reason: string; readonly from: string }
// The budget file: for each phase, the ticks its script plays and each gated count's
// budget; and notes for the reader.
export type PhaseBudgets = Readonly<Record<Gated, Budget>> & { readonly ticks: number }
export type Budgets = Readonly<Record<Phase, PhaseBudgets>> & {
  readonly notes?: readonly string[]
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
const said = (text: unknown): text is string => typeof text === "string" && text.trim() !== ""
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const budgetOf = (budget: Budget): number => (typeof budget === "object" ? budget.budget : budget)
const raiseForm = '{ "budget": n, "reason": "why", "from": "#PR" }'

// Reads a reading file's contents, failing on anything the gate couldn't see whole: a
// counter it can't see must not pass as within budget.
export const parseReading = (data: unknown): Reading => {
  if (!isRecord(data)) throw new Error("The reading is not an object.")
  for (const phase of phases) {
    const reading = data[phase]
    if (!isRecord(reading)) throw new Error(`The reading has no ${phase} phase.`)
    const totals = reading.tickTotals
    if (!isCount(reading.ticks) || !isRecord(totals))
      throw new Error(`The reading's ${phase} phase has no ticks.`)
    for (const counter of ticked)
      if (!isCount(totals[counter]))
        throw new Error(`The reading has no whole count for ${phase} ${counter}.`)
    for (const counter of ["bytes", "streamingPeak", "streamingSettled"])
      if (!isCount(reading[counter]))
        throw new Error(`The reading has no whole count for ${phase} ${counter}.`)
  }
  return data as Reading
}

// Reads a budget file's contents: every phase's ticks and every gated budget, each a whole
// count or a raise written { budget, reason, from }. `name` says which file, for the error.
export const parseBudgets = (data: unknown, name: string): Budgets => {
  if (!isRecord(data)) throw new Error(`${name} is not an object.`)
  for (const phase of phases) {
    const budgets = data[phase]
    if (!isRecord(budgets)) throw new Error(`${name} has no ${phase} phase.`)
    if (!isCount(budgets.ticks))
      throw new Error(`${name} doesn't say how many ticks ${phase} plays.`)
    for (const counter of gated) checkEntry(budgets[counter], `${name}'s ${phase} ${counter}`)
    // A key the gate doesn't read would stand in for a budget renamed away.
    for (const key of Object.keys(budgets))
      if (key !== "ticks" && !(gated as readonly string[]).includes(key))
        throw new Error(`${name}'s ${phase} has ${key}, which the gate doesn't budget.`)
  }
  for (const key of Object.keys(data))
    if (key !== "notes" && !(phases as readonly string[]).includes(key))
      throw new Error(`${name} has ${key}, which is no phase the counter run plays.`)
  return data as Budgets
}

// A base branch's budget file as it reads today: one written before `notifications` became
// `wakes` has its counts under the old key, which would otherwise show as a budget dropped
// and a new one added.
export const withCurrentNames = (data: unknown): unknown => {
  if (!isRecord(data)) return data
  return Object.fromEntries(
    Object.entries(data).map(([phase, counters]) => {
      if (!isRecord(counters) || !("notifications" in counters) || "wakes" in counters)
        return [phase, counters]
      const { notifications, ...rest } = counters
      return [phase, { ...rest, wakes: notifications }]
    }),
  )
}

// The base branch's budgets, as far as comparing with them needs: each budget it has. It
// may be in an older form, without a phase's ticks or a counter added since, so a change
// to the file's form can land; a budget it has must still read.
export type BaseBudgets = Readonly<Partial<Record<Phase, Partial<Record<Gated, Budget>>>>>
export const parseBaseBudgets = (data: unknown, name: string): BaseBudgets => {
  if (!isRecord(data)) throw new Error(`${name} is not an object.`)
  for (const phase of phases) {
    const budgets = data[phase]
    if (budgets === undefined) continue
    if (!isRecord(budgets)) throw new Error(`${name}'s ${phase} is not an object.`)
    for (const counter of gated)
      if (budgets[counter] !== undefined)
        checkEntry(budgets[counter], `${name}'s ${phase} ${counter}`)
  }
  return data as BaseBudgets
}

const checkEntry = (entry: unknown, label: string): void => {
  const count = isRecord(entry) ? entry.budget : entry
  if (!isCount(count)) throw new Error(`${label} is not a whole-number budget.`)
  if (isRecord(entry) && (typeof entry.reason !== "string" || typeof entry.from !== "string"))
    throw new Error(`${label} is written ${raiseForm}.`)
}

// How many times its budget a count may reach before the gate fails; past its budget but
// no further than this, it only warns. Loose by choice: the product is early and still
// being defined, and feature work must move without tripping hard gates, while a blow-up,
// as the 11,271 wakes Grid once cost against a budget of 78, still fails. The
// person's call, on 2026-10-17.
export const failsAt = 2

// Past `failsAt` times its budget, past its budget, under it, or at it.
export type Verdict = "fails" | "over" | "under" | "within"
export type Row = {
  readonly phase: Phase
  readonly counter: Gated
  readonly value: number
  readonly budget: number
  readonly verdict: Verdict
}

// The gated values of a phase: per-tick counts as totals over its fixed number of ticks.
const gatedValues = (phase: PhaseReading): Record<Gated, number> => ({
  wakes: phase.tickTotals.wakes,
  mutations: phase.tickTotals.mutations,
  bytes: phase.bytes,
  streamingPeak: phase.streamingPeak,
  streamingSettled: phase.streamingSettled,
})

// The phases whose script plays another number of ticks than its budgets were set for: the
// counts then measure something else, so the budgets change with the script.
export const changedScripts = (reading: Reading, budgets: Budgets): string[] =>
  phases.flatMap((phase) =>
    reading[phase].ticks === budgets[phase].ticks
      ? []
      : [
          `${phase} played ${reading[phase].ticks} ticks, and its budgets are for ${budgets[phase].ticks}: set them, and its ticks, for the new script.`,
        ],
  )

// Every gated count of every phase beside its budget.
export const checkCounters = (reading: Reading, budgets: Budgets): Row[] =>
  phases.flatMap((phase) => {
    const values = gatedValues(reading[phase])
    return gated.map((counter) => {
      const value = values[counter]
      const budget = budgetOf(budgets[phase][counter])
      const verdict: Verdict =
        value > budget * failsAt
          ? "fails"
          : value > budget
            ? "over"
            : value < budget
              ? "under"
              : "within"
      return { phase, counter, value, budget, verdict }
    })
  })

export type BudgetChange = {
  readonly phase: Phase
  readonly counter: Gated
  // Undefined for a budget the base doesn't have, as a counter added or renamed.
  readonly from?: number
  readonly to: number
  readonly reason?: string
  readonly source?: string
  // Why the change can't stand: a raise that doesn't say why or where it came from.
  readonly problem?: string
}

// Why a raise, or a new budget in a phase the base has, can't stand, if it can't: it must
// say why, and name where it came from: the pull request it is in, when that is known, or
// else anything but the source of the raise it replaces.
const raiseProblem = (
  entry: Budget,
  was: Budget | undefined,
  pullRequest: number | undefined,
): string | undefined => {
  const why = typeof entry === "object" ? entry : undefined
  if (!said(why?.reason) || !said(why.from))
    return `${was === undefined ? "A new" : "A raised"} budget is written ${raiseForm}.`
  if (pullRequest !== undefined && !new RegExp(`#${pullRequest}\\b`).test(why.from))
    return `This change is in #${pullRequest}; name it in "from".`
  if (typeof was === "object" && why.from.trim() === was.from.trim())
    return `This raise names the earlier raise's source (${why.from}); name its own pull request.`
  return undefined
}

// Every budget this change moves against the base branch's. A cut needs no reason. A
// budget the base doesn't have shows as new: one in a phase the base has, as a counter
// added or renamed, needs a reason as a raise does; one in a phase it doesn't, as after
// the phases' rename, doesn't. `pullRequest` is the number of the pull request the change
// is in, if any.
export const budgetChanges = (
  budgets: Budgets,
  base: BaseBudgets,
  pullRequest?: number,
): BudgetChange[] =>
  phases.flatMap((phase) =>
    gated.flatMap((counter) => {
      const was = base[phase]?.[counter]
      const entry = budgets[phase][counter]
      const to = budgetOf(entry)
      const from = was === undefined ? undefined : budgetOf(was)
      if (from === to) return []
      if (from !== undefined && to < from) return [{ phase, counter, from, to }]
      const why = typeof entry === "object" ? entry : undefined
      const known = base[phase] !== undefined
      const problem =
        from === undefined && !known ? undefined : raiseProblem(entry, was, pullRequest)
      return [
        {
          phase,
          counter,
          ...(from === undefined ? {} : { from }),
          to,
          ...(said(why?.reason) ? { reason: why.reason } : {}),
          ...(said(why?.from) ? { source: why.from } : {}),
          ...(problem ? { problem } : {}),
        },
      ]
    }),
  )

// The budgets the base branch's file has that this one doesn't, as a counter or phase
// renamed or dropped, read from the file as it is: "phase counter n", or "(unreadable)"
// for an entry that isn't a budget.
export const goneBudgets = (budgets: Budgets, base: unknown): string[] => {
  if (!isRecord(base)) return []
  const kept = (phase: string, counter: string): boolean =>
    Object.hasOwn(budgets, phase) &&
    Object.hasOwn(budgets[phase as Phase] as Record<string, unknown>, counter)
  return Object.entries(base).flatMap(([phase, counters]) => {
    if (phase === "notes") return []
    if (!isRecord(counters)) return Object.hasOwn(budgets, phase) ? [] : [`${phase} (unreadable)`]
    return Object.entries(counters).flatMap(([counter, entry]) => {
      if (counter === "ticks" || kept(phase, counter)) return []
      const count = isRecord(entry) ? entry.budget : entry
      return [`${phase} ${counter} ${isCount(count) ? count : "(unreadable)"}`]
    })
  })
}

// Whether the base has any phase the counter run plays: one with none, as after a rename
// of every phase, compares with nothing, and every budget shows as new.
export const sharesBudgets = (base: BaseBudgets): boolean =>
  phases.some((phase) => base[phase] !== undefined)

// The phases whose script this change makes play another number of ticks, for the
// summary: their counts measure something else, so their budgets change with it.
export const tickChanges = (budgets: Budgets, base: BaseBudgets): string[] =>
  phases.flatMap((phase) => {
    const was = (base[phase] as { readonly ticks?: unknown } | undefined)?.ticks
    const now = budgets[phase].ticks
    return isCount(was) && was !== now ? [`${phase} now plays ${now} ticks, was ${was}`] : []
  })

const perTick = (total: number, ticks: number): string => (ticks ? (total / ticks).toFixed(1) : "–")
// Text from the budget file, safe in a Markdown table's cell.
const cell = (text: string): string => text.replaceAll(/\s+/g, " ").replaceAll("|", "\\|")

const mark: Record<Verdict, string> = {
  fails: `❌ over ${failsAt}×`,
  over: "⚠️ over",
  under: "⬇️ under",
  within: "✅",
}

// The reading as Markdown, for the job summary: what stops the budgets standing, any
// budgets the change moves, the gated counts against their budgets, then the framework
// cost per tick.
export const countersSummary = (
  reading: Reading,
  rows: readonly Row[],
  {
    changes = [],
    scripts = [],
    tickNotes = [],
    gone = [],
    compared = true,
  }: {
    readonly changes?: readonly BudgetChange[]
    readonly scripts?: readonly string[]
    readonly tickNotes?: readonly string[]
    // Budgets the base has that this change drops, as "phase counter n".
    readonly gone?: readonly string[]
    // Whether the budgets were compared with the base branch's.
    readonly compared?: boolean
  } = {},
): string => {
  const gatedRows = rows.map(({ phase, counter, value, budget, verdict }) => {
    const tick = counter === "wakes" || counter === "mutations"
    const ticks = reading[phase].ticks
    const shown = tick ? `${value} (${perTick(value, ticks)}/tick)` : String(value)
    return `| ${phase} | ${counter} | ${shown} | ${budget} | ${mark[verdict]} |`
  })
  const costRows = phases.map((phase) => {
    const { ticks, tickTotals } = reading[phase]
    return `| ${phase} | ${ticks} | ${perTick(tickTotals.commits, ticks)} | ${perTick(tickTotals.renders, ticks)} |`
  })
  const changeRows = changes.map(
    ({ phase, counter, from, to, reason, source, problem }) =>
      `| ${phase} | ${counter} | ${from ?? "new"} → ${to} | ${problem ? `❌ ${cell(problem)}` : cell(reason ?? (from === undefined ? "not in the base" : "lowered"))} | ${cell(source ?? "")} |`,
  )
  const fails = rows.filter((row) => row.verdict === "fails")
  const over = rows.filter((row) => row.verdict === "over")
  const under = rows.filter((row) => row.verdict === "under")
  const raise = `raise the budget in frontend/specs/src/counters/budgets.json, written ${raiseForm}`
  return [
    "## Counter run",
    "",
    ...(compared
      ? []
      : ["> ⚠️ No base budgets to compare with: budget changes aren't checked.", ""]),
    ...scripts.flatMap((script) => [`> ❌ ${script}`, ""]),
    ...(changes.length || tickNotes.length || gone.length
      ? [
          "This change moves budgets:",
          "",
          ...tickNotes.map((note) => `- ${note}: its counts are totals over the new number.`),
          ...gone.map((budget) => `- ${cell(budget)}: no longer budgeted.`),
          ...(tickNotes.length || gone.length ? [""] : []),
          ...(changeRows.length
            ? [
                "| Phase | Counter | Budget | Why | From |",
                "| --- | --- | --- | --- | --- |",
                ...changeRows,
                "",
              ]
            : []),
        ]
      : []),
    ...(fails.length
      ? [
          `${fails.length} counter(s) past ${failsAt}× their budget, which fails the build. Fix the regression, or, for work that really costs more, ${raise}.`,
          "",
        ]
      : []),
    ...(over.length
      ? [
          `${over.length} counter(s) past their budget, within ${failsAt}× it: a warning, not a failure. Look at what costs more, and ${raise} if it should.`,
          "",
        ]
      : []),
    ...(under.length
      ? [
          `${under.length} counter(s) under their budget: lower the budget in frontend/specs/src/counters/budgets.json to lock the gain in.`,
          "",
        ]
      : []),
    ...(fails.length || over.length || under.length ? [] : ["Every counter within budget.", ""]),
    "| Phase | Counter | Count | Budget | |",
    "| --- | --- | --- | --- | --- |",
    ...gatedRows,
    "",
    "Framework cost per tick (reported, not gated):",
    "",
    "| Phase | Ticks | React commits | Component renders |",
    "| --- | --- | --- | --- |",
    ...costRows,
    "",
  ].join("\n")
}
