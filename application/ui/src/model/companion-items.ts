import type { ArtifactRef } from "./companion"
import type { TerminalMetadata } from "./types"

// Where a terminal's companion items show besides its own taskbar: undocked into windows
// of their own, or placed on another terminal's taskbar. Both stay within the session,
// and both stay the terminal's: a plan's edits still save to its agent.

// Part of a terminal's companion that can show away from its terminal: one of its plans,
// or something its agent showed, by its id there. Its messages are its agent's
// conversation and stay with it, so they never move.
export type MovableItem =
  | { readonly kind: "plan"; readonly ref: string }
  | { readonly kind: "artifact"; readonly id: string }

export const sameItem = (a: MovableItem, b: MovableItem): boolean =>
  a.kind === "plan" ? b.kind === "plan" && a.ref === b.ref : b.kind === "artifact" && a.id === b.id

// A terminal's item undocked into a window of its own, `from` naming the terminal it
// belongs to, which it loads from and docks back in. The window lives in the session's
// roster beside the terminals, so the sidebar and every view treat it as one, but no
// backend runs anything for it. `artifact` is what the agent showed as it was undocked:
// the window's icon, and what it shows once its terminal has it no longer.
// TODO: connect to the backends, which neither keep nor restore these windows yet.
export type CompanionWindow = {
  readonly from: string
  readonly item: MovableItem
  readonly artifact?: ArtifactRef
}

export const isCompanionWindow = (
  terminal: TerminalMetadata,
): terminal is TerminalMetadata & { readonly companion: CompanionWindow } =>
  terminal.companion !== undefined

// The session's terminals that run a shell, apart from the windows undocked from them.
export const shellTerminals = (terminals: readonly TerminalMetadata[]): TerminalMetadata[] =>
  terminals.filter((terminal) => !isCompanionWindow(terminal))

// The window showing terminal `from`'s item, if it's undocked.
export const windowOf = (
  terminals: readonly TerminalMetadata[],
  from: string,
  item: MovableItem,
): TerminalMetadata | undefined =>
  terminals.find(
    (terminal) => terminal.companion?.from === from && sameItem(terminal.companion.item, item),
  )

// A terminal's item shown on another terminal's taskbar, `from` and `to` naming them.
// TODO: connect to the backends, which neither keep nor restore placements yet.
export type Placement = {
  readonly from: string
  readonly item: MovableItem
  readonly to: string
}

const isOf = (placement: Placement, from: string, item: MovableItem): boolean =>
  placement.from === from && sameItem(placement.item, item)

// The item goes home, as when it's undocked or closed. The same list when it wasn't placed.
export const unplace = (
  placements: readonly Placement[],
  from: string,
  item: MovableItem,
): readonly Placement[] =>
  placements.some((placement) => isOf(placement, from, item))
    ? placements.filter((placement) => !isOf(placement, from, item))
    : placements

// Terminal `from`'s item shows on `to`'s taskbar from now on, after whatever is there; on
// `from`'s own, it goes home. An item shows in one place at a time.
export const place = (
  placements: readonly Placement[],
  { from, item, to }: Placement,
): readonly Placement[] => {
  const rest = unplace(placements, from, item)
  return from === to ? rest : [...rest, { from, item, to }]
}

// A terminal closed: what came from it is gone, and what was on its taskbar goes home.
export const forgetTerminal = (
  placements: readonly Placement[],
  terminalId: string,
): readonly Placement[] =>
  placements.some((placement) => placement.from === terminalId || placement.to === terminalId)
    ? placements.filter((placement) => placement.from !== terminalId && placement.to !== terminalId)
    : placements
