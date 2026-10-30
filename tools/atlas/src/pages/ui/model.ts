import { atlas, groupBy } from "../../atlas-data.ts"
import type { BoxId, UiAction, UiProcedure, UiStream } from "../../ui-lens.ts"

export const lens = atlas.ui

export const actionByType = new Map(lens.actions.map((action) => [action.type, action]))
export const uiProcedureById = new Map(
  lens.procedures.map((procedure) => [procedure.id, procedure]),
)
export const streamByProcedure = new Map(lens.streams.map((stream) => [stream.procedure, stream]))
export const boxById = new Map(lens.boxes.map((box) => [box.id, box]))

export type Selection =
  | { kind: "box"; id: BoxId }
  | { kind: "action"; id: string }
  | { kind: "procedure"; id: string }
  | null

// How strongly a box sits on the selected path: 2 on it, 1 on the every-commit save that
// every action rides, 0 off it.
export type Lit = Map<BoxId, 0 | 1 | 2>

export const hasEffect = (action: UiAction) => action.effects.length > 0

const mark = (lit: Lit, ids: BoxId[], level: 1 | 2) => {
  for (const id of ids) if ((lit.get(id) ?? 0) < level) lit.set(id, level)
}

export const litFor = (selection: Selection): Lit => {
  const lit: Lit = new Map()
  if (!selection) return lit
  if (selection.kind === "box") {
    mark(lit, [selection.id], 2)
    return lit
  }
  if (selection.kind === "action") {
    const action = actionByType.get(selection.id)
    if (!action) return lit
    mark(lit, ["workspace", "port"], 2)
    if (action.fromUi.length) mark(lit, ["commands"], 2)
    if (hasEffect(action)) mark(lit, ["adapter", "procedures", "runner"], 2)
    else mark(lit, ["adapter", "procedures", "runner"], 1)
    if (action.returns.length) mark(lit, ["streams", "consumers", "sink", "runner"], 2)
    else if (action.fromAdapter.length) mark(lit, ["sink", "consumers"], 2)
    return lit
  }
  const procedure = uiProcedureById.get(selection.id)
  if (!procedure) return lit
  mark(lit, ["adapter", "runner"], 2)
  if (procedure.kind === "stream") {
    const stream = streamByProcedure.get(procedure.id)
    mark(lit, ["streams", "consumers"], 2)
    if (stream?.dispatches.length) mark(lit, ["sink", "workspace"], 2)
    else if (stream?.feeds) mark(lit, ["feature"], 2)
  } else {
    mark(lit, ["procedures"], 2)
    if (procedure.fromCommit) mark(lit, ["port", "workspace"], 2)
  }
  return lit
}

export const nameOf = (type: string) => type.split("/").slice(1).join("/")

export const groupedActions = (): [string, UiAction[]][] =>
  groupBy(lens.actions, (action) => action.prefix)

export const groupedProcedures = (kind: UiProcedure["kind"]): [string, UiProcedure[]][] =>
  groupBy(
    lens.procedures.filter((procedure) => procedure.kind === kind),
    (procedure) => procedure.id.split(".")[0]!,
  )

export const untracedStreams = (): UiStream[] => lens.streams.filter((stream) => !stream.feeds)
