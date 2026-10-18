import { atlas } from "../../atlas-data.ts"
import type { BoxId, UiAction, UiProcedure, UiStream } from "../../lens-ui.ts"

export const lens = atlas.ui

export const actionBy = new Map(lens.actions.map((action) => [action.type, action]))
export const procedureBy = new Map(lens.procedures.map((procedure) => [procedure.id, procedure]))
export const streamBy = new Map(lens.streams.map((stream) => [stream.procedure, stream]))
export const boxBy = new Map(lens.boxes.map((box) => [box.id, box]))

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
    const action = actionBy.get(selection.id)
    if (!action) return lit
    mark(lit, ["workspace", "port"], 2)
    if (action.fromUi.length) mark(lit, ["commands"], 2)
    if (hasEffect(action)) mark(lit, ["adapter", "procedures", "runner"], 2)
    else mark(lit, ["adapter", "procedures", "runner"], 1)
    if (action.returns.length) mark(lit, ["streams", "consumers", "sink", "runner"], 2)
    else if (action.fromAdapter.length) mark(lit, ["sink", "consumers"], 2)
    return lit
  }
  const procedure = procedureBy.get(selection.id)
  if (!procedure) return lit
  mark(lit, ["adapter", "runner"], 2)
  if (procedure.kind === "stream") {
    const stream = streamBy.get(procedure.id)
    mark(lit, ["streams", "consumers"], 2)
    if (stream?.dispatches.length) mark(lit, ["sink", "workspace"], 2)
    else if (stream?.feeds) mark(lit, ["feature"], 2)
  } else {
    mark(lit, ["procedures"], 2)
    if (procedure.fromCommit) mark(lit, ["port", "workspace"], 2)
  }
  return lit
}

export const prefixOf = (type: string) => type.split("/")[0]!
export const nameOf = (type: string) => type.split("/").slice(1).join("/")

export const groupedActions = (): [string, UiAction[]][] => {
  const groups = new Map<string, UiAction[]>()
  for (const action of lens.actions)
    groups.set(action.prefix, [...(groups.get(action.prefix) ?? []), action])
  return [...groups]
}

export const groupedProcedures = (kind: UiProcedure["kind"]): [string, UiProcedure[]][] => {
  const groups = new Map<string, UiProcedure[]>()
  for (const procedure of lens.procedures)
    if (procedure.kind === kind) {
      const ns = procedure.id.split(".")[0]!
      groups.set(ns, [...(groups.get(ns) ?? []), procedure])
    }
  return [...groups]
}

export const untracedStreams = (): UiStream[] => lens.streams.filter((stream) => !stream.feeds)
