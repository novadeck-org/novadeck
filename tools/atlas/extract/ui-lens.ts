import type { UiLens } from "../src/atlas.ts"
import type { Effect, UiAction, UiProcedure, UiStream } from "../src/ui-lens.ts"
import type { LensInput } from "./lens-input.ts"
import { readActionTypes, type ActionTypes } from "./ui-lens/actions.ts"
import { wiringBoxes } from "./ui-lens/boxes.ts"
import { findCommitSites, findSites, type CommitSite, type Site } from "./ui-lens/calls.ts"
import { readDispatchers, type Dispatchers } from "./ui-lens/dispatch.ts"
import { at, backendFile, stateFile, type UiScan, scanUi } from "./ui-lens/scan.ts"
import { readStreams } from "./ui-lens/streams.ts"

// The UI from the inside, read by scanning its source (no type checker): the actions the
// workspace reducer takes, who builds them, what the runner adapter does on a commit, and
// which runner streams feed the store back. Indentation is relied on (the code is
// formatted), and every leg the scan cannot follow is left empty or flagged in the data.
// Each section of the lens is read in `ui-lens/`; this file puts them together.

// What a commit changes in the workspace, by the trigger the reducer's case is read for.
const diffLinks: Record<string, (type: string, text: string) => boolean> = {
  "terminal appears": (_, text) => /\baddTerminal\(/.test(text),
  "terminal leaves": (type, text) =>
    /\b(closeTerminal|removeTerminal)\(/.test(text) || type === "project/remove",
  "project appears": (type) => type === "project/add",
  "session appears": (type, text) =>
    /history: \[|initialSession/.test(text) && type !== "project/remove",
}

// What the adapter does when a commit carries an action of `type`, or follows from it.
const effectsOf = (type: string, text: string, commitSites: CommitSite[]): Effect[] => {
  const effects: Effect[] = []
  for (const site of commitSites) {
    const label = site.label
    const direct = site.types.includes(type)
    const diff = label !== null && diffLinks[label]?.(type, text) === true
    if (!direct && !diff) continue
    // One effect per procedure: the first site that reaches it names the chain.
    const basis = direct ? "action" : "diff"
    const trigger = direct ? null : label
    if (
      effects.some(
        (effect) =>
          effect.basis === basis &&
          effect.trigger === trigger &&
          effect.procedures[0] === site.procedure,
      )
    )
      continue
    effects.push({
      basis,
      via: site.effectFn,
      trigger,
      anchor: at(site.file, site.line),
      procedures: [site.procedure],
    })
  }
  return effects
}

const readActions = (
  types: ActionTypes,
  dispatchers: Dispatchers,
  commitSites: CommitSite[],
  streams: UiStream[],
): UiAction[] =>
  [...types.declared.entries()].map(([type, line]) => {
    // Items and windows are tested by action type in the adapter; their procedures are
    // reached through the closure handed to `send`, so those are found as guarded.
    const fromUi = dispatchers.fromUi.get(type) ?? []
    const fromAdapter = dispatchers.fromAdapter.get(type) ?? []
    const reducer = types.caseLines.get(type)
    return {
      type,
      prefix: type.split("/")[0]!,
      declared: at(stateFile, line),
      reducer: reducer === undefined ? null : at(stateFile, reducer),
      fromUi,
      fromAdapter,
      returns: streams.filter((stream) => stream.dispatches.includes(type)).map((s) => s.procedure),
      effects: effectsOf(type, types.reducerText(type), commitSites),
      untraced:
        fromUi.length || fromAdapter.length
          ? null
          : "no dispatch site found: built by a helper the scan does not follow, or never dispatched",
    }
  })

// The effects every commit has, whatever the action.
const everyCommitEffects = (commitSites: CommitSite[], sites: Site[]): Effect[] => {
  const effects: Effect[] = commitSites
    .filter((site) => site.label === "any commit")
    .map((site) => ({
      basis: "diff",
      via: site.effectFn,
      trigger: "any commit",
      anchor: at(site.file, site.line),
      procedures: [site.procedure],
    }))
  // Session saves go through a callback the commit only marks, so name them from the wiring.
  const saveSite = sites.find((site) => site.procedure === "sessions.save")
  if (saveSite && !effects.some((effect) => effect.procedures.includes("sessions.save")))
    effects.push({
      basis: "diff",
      via: "commit > saves.note > save",
      trigger: "session state changed",
      anchor: at(saveSite.file, saveSite.line),
      procedures: ["sessions.save"],
    })
  return effects
}

const readProcedures = (
  scan: UiScan,
  sites: Site[],
  actions: UiAction[],
  everyCommit: Effect[],
): UiProcedure[] => {
  const kinds = new Map(scan.api.procedures.map((procedure) => [procedure.id, procedure.kind]))
  return [...new Set(sites.map((site) => site.procedure))].toSorted().map((id) => {
    const viaActions = actions
      .filter((action) => action.effects.some((effect) => effect.procedures.includes(id)))
      .map((action) => action.type)
    return {
      id,
      kind: kinds.get(id)!,
      sites: sites.filter((site) => site.procedure === id).map((site) => at(site.file, site.line)),
      actions: viaActions,
      fromCommit:
        viaActions.length > 0 || everyCommit.some((effect) => effect.procedures.includes(id)),
    }
  })
}

export const extractUiLens = (input: LensInput): UiLens => {
  const scan = scanUi(input)
  const types = readActionTypes(scan)
  const backend = scan.source(backendFile)
  const sites = findSites(scan, backend)
  const commitSites = findCommitSites(scan, backend, sites, types.known)
  const streams = readStreams(scan, sites, types.known)
  const actions = readActions(types, readDispatchers(scan, types.known), commitSites, streams)
  const everyCommit = everyCommitEffects(commitSites, sites)
  const procedures = readProcedures(scan, sites, actions, everyCommit)

  return {
    boxes: wiringBoxes(scan, { actions, procedures, sites, streams }),
    actions,
    procedures,
    streams,
    everyCommit,
    totals: {
      actions: actions.length,
      dispatchedFromUi: actions.filter((action) => action.fromUi.length).length,
      dispatchedFromAdapter: actions.filter((action) => action.fromAdapter.length).length,
      withoutDispatcher: actions.filter((action) => action.untraced).length,
      reachingBackend: actions.filter((action) => action.effects.length).length,
      byAction: actions.filter((action) => action.effects.some((e) => e.basis === "action")).length,
      byDiff: actions.filter((action) => action.effects.some((e) => e.basis === "diff")).length,
      procedures: procedures.length,
      streams: streams.length,
      streamsToStore: streams.filter((stream) => stream.feeds).length,
    },
  }
}
