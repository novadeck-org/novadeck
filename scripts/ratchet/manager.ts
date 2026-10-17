import { stripTypeScriptTypes } from "node:module"

import { parseAst } from "vitest/node"

// The ratchet on application/runner/src/terminals/manager.ts: what it measures, and how a
// measure stands against its budget.

export const measures = ["lines", "methods"] as const
export type Measure = (typeof measures)[number]
export type Counts = Readonly<Record<Measure, number>>

// A measure's budget: a count, or a raised one with why it was raised and the pull request
// or commit it came from.
export type Budget =
  | number
  | { readonly budget: number; readonly reason: string; readonly from: string }
// The budget file: each measure's budget, how far under it the file may sit before the
// budget must come down (raised as a budget is, with why), and notes for the reader.
export type Budgets = Readonly<Record<Measure, Budget>> & {
  readonly slack: Readonly<Record<Measure, Budget>>
  readonly notes?: readonly string[]
}

export const managerPath = "application/runner/src/terminals/manager.ts"
export const budgetsPath = "scripts/ratchet/manager.json"
const raiseForm = '{ "budget": n, "reason": "why", "from": "#PR or commit" }'

type Node = { readonly type: string; readonly [key: string]: unknown }

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string"

// Every node of a syntax tree, depth first.
const nodes = function* (node: unknown): Generator<Node> {
  if (Array.isArray(node)) for (const each of node) yield* nodes(each)
  if (!isNode(node)) return
  yield node
  for (const value of Object.values(node)) if (typeof value === "object") yield* nodes(value)
}

const isFunction = (node: unknown): boolean =>
  isNode(node) && (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")

// A member that is a function: a method, an accessor or the constructor, or a property
// set to a function or arrow expression (one set to what a call returns, as `.bind`'s, isn't).
const isFunctionMember = (member: Node): boolean =>
  member.type === "MethodDefinition" ||
  (member.type === "PropertyDefinition" && isFunction(member.value))

// Its code as JavaScript: types blanked out as Node strips them, keeping every position.
// Syntax Node can't strip (an enum, a namespace, a parameter property) is refused, as no
// parser for it is at hand here.
const stripped = (source: string): string => {
  try {
    return stripTypeScriptTypes(source, { mode: "strip" })
  } catch (error) {
    throw new Error(
      `${managerPath} uses TypeScript syntax the ratchet can't read, which Node can't strip: write it without enums, namespaces or parameter properties.`,
      { cause: error },
    )
  }
}

// Its syntax tree; code the parser can't read is refused the same way, naming the file.
const parsed = (code: string): ReturnType<typeof parseAst> => {
  try {
    return parseAst(code)
  } catch (error) {
    throw new Error(
      `${managerPath} has syntax the ratchet's parser can't read (${error instanceof Error ? error.message : String(error)}): write it as Node runs it, plain JavaScript once its types are stripped.`,
      { cause: error },
    )
  }
}

// The file's lines, and the functions its `Terminals` class defines, read from its syntax
// tree, so formatting never moves the count.
export const countManager = (source: string): Counts => {
  const tree = parsed(stripped(source))
  const classes = [...nodes(tree)].filter(
    (node) =>
      (node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
      isNode(node.id) &&
      node.id.name === "Terminals",
  )
  if (classes.length !== 1)
    throw new Error(
      `${managerPath} should define one Terminals class; it defines ${classes.length}.`,
    )
  const body = (classes[0]!.body as { readonly body: readonly Node[] }).body
  return {
    lines: source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length,
    methods: body.filter(isFunctionMember).length,
  }
}

// A budget's number, from a count or a raise; anything else, as a hand-written null, has none.
const budgetOf = (budget: Budget | null | undefined): number | undefined =>
  typeof budget === "object" && budget !== null ? budget.budget : (budget ?? undefined)

const said = (text: unknown): text is string => typeof text === "string" && text.trim() !== ""

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

const advice: Record<Measure, string> = {
  lines: "lines",
  methods: "methods in the Terminals class",
}

// Why a raise against the base branch's value can't stand: it says neither why nor where
// it came from, or names the earlier raise's source, as when only the number was edited.
// `measure` names what is raised: a budget, or a slack.
const raiseProblem = (measure: string, entry: Budget, was: Budget): string | undefined => {
  const from = budgetOf(was)
  const to = budgetOf(entry)
  if (!isCount(from) || !isCount(to) || to <= from) return undefined
  if (typeof entry !== "object")
    return `${budgetsPath} raises ${measure} from ${from} to ${to} without saying why: write it ${raiseForm}.`
  if (typeof was === "object" && said(was.from) && entry.from.trim() === was.from.trim())
    return `${budgetsPath} raises ${measure} from ${from} to ${to} under the earlier raise's source, ${was.from}: name this one's pull request or commit.`
  return undefined
}

// What's wrong with the counts against the budgets, and with the budgets against the base
// branch's where they can be read; nothing when the ratchet holds. A count past its budget
// asks for the code to go to a sibling module; one further under it than its slack asks for
// the budget to come down; a raise must say why and where it came from.
export const ratchetProblems = (counts: Counts, budgets: Budgets, base?: Budgets): string[] =>
  measures.flatMap((measure) => {
    const entry = budgets[measure]
    const budget = budgetOf(entry)
    if (!isCount(budget)) return [`${budgetsPath} sets no budget for ${measure}.`]
    const slackEntry = budgets.slack?.[measure]
    const slack = budgetOf(slackEntry)
    if (!isCount(slack))
      return [
        `${budgetsPath} sets no slack for ${measure}: write "slack": { "lines": n, "methods": n }.`,
      ]
    for (const [what, given] of [
      ["budget", entry],
      ["slack", slackEntry],
    ] as const)
      if (typeof given === "object" && (!said(given.reason) || !said(given.from)))
        return [
          `A raised ${what} in ${budgetsPath} is written ${raiseForm}; the one for ${measure} isn't.`,
        ]
    const count = counts[measure]
    const was = base ? budgetOf(base[measure]) : undefined
    // A raise in this change gives the file what it needs now, never headroom for later:
    // at most its count, or the base's budget where the file needs no raise at all.
    const limit = isCount(was) ? Math.max(count, was) : budget
    const raised = [
      base ? raiseProblem(measure, entry, base[measure]) : undefined,
      base?.slack && slackEntry !== undefined
        ? raiseProblem(`${measure} slack`, slackEntry, base.slack[measure])
        : undefined,
      budget > limit
        ? count > (was ?? count)
          ? `${budgetsPath} raises ${measure} to ${budget}, past the ${count} the file has: raise it only to ${count}.`
          : `${budgetsPath} raises ${measure} to ${budget}, though the file's ${count} needs no raise: keep it at ${limit} at most.`
        : undefined,
    ].filter((problem): problem is string => problem !== undefined)
    if (count > budget)
      return [
        ...raised,
        `${managerPath} has ${count} ${advice[measure]}, past its budget of ${budget}. Put new code in a sibling module under application/runner/src/terminals/ (as closes.ts, opens.ts and naming.ts are) and call it from the class, instead of growing the Terminals class. If it really can't go there, raise the budget in ${budgetsPath} to ${count}, written ${raiseForm}. Where changes to it merged one after the other had already put the base branch past the budget, not all of the overrun is this change's: say so in the reason.`,
      ]
    if (budget - count > slack)
      return [
        ...raised,
        `${managerPath} has ${count} ${advice[measure]}, ${budget - count} under its budget of ${budget}, past the ${slack} it may sit under: lower the budget in ${budgetsPath} to ${count}, so the ratchet holds what was won.`,
      ]
    return raised
  })

// The budgets that could come down, though the file sits within their slack: worth doing
// in a change that touches the budget file anyway. Past the slack, the failure says it.
export const ratchetNotes = (counts: Counts, budgets: Budgets): string[] =>
  measures.flatMap((measure) => {
    const budget = budgetOf(budgets[measure])
    const slack = budgetOf(budgets.slack?.[measure])
    const count = counts[measure]
    return isCount(budget) && isCount(slack) && count < budget && budget - count <= slack
      ? [
          `${managerPath} has ${count} ${advice[measure]}, under its budget of ${budget}: it could be lowered to ${count} in ${budgetsPath}.`,
        ]
      : []
  })
