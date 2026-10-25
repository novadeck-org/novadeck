import { formatSize } from "@novadeck/core/addon-format"
import { followFinishes } from "@novadeck/core/agent-finish"
import { murmurDownloadSize, type MurmurState } from "@novadeck/core/murmur"
import type { Store } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"

import type { WorkspaceServices } from "./controller/context"
import { currentContext, currentState } from "./selectors"

// The one-time offer of Murmur: a chip beside the title of the first terminal whose agent
// finished a turn, the moment naming terminals shows its worth. Nothing downloads before
// Turn on.

// How many sessions of the app the offer comes up in, answered or not.
export const offerSessions = 3

// Whether the offer stands now: Murmur has an engine here, is not on the computer, was not
// turned down, is not known to fail on this computer, and nothing is happening to it.
export const offerable = (state: MurmurState): boolean =>
  state.available &&
  !state.installed &&
  state.wanted &&
  state.unsupported === null &&
  state.installing === null &&
  state.failure === null

// Whether the offer may come up in this session: it stands, and has not used its sessions.
export const offerDue = (state: MurmurState): boolean =>
  offerable(state) && state.offers < offerSessions

// Whether a terminal's title is still the plain name of its agent or program, which Murmur
// would replace, and not one the person, an agent or Murmur gave.
export const plainTitle = (terminal: Pick<TerminalMetadata, "titleSource">): boolean =>
  terminal.titleSource === undefined || terminal.titleSource.kind === "default"

// Whether a terminal that just finished may carry the chip: it is in the session on screen,
// its title is still the plain name of its agent, and it is shown: the selected one in Focus,
// one not hidden in the other views. A finish
// that does not qualify is let go, and the next that does is the one.
export const canCarryChip = (
  workspace: Workspace,
  finished: { readonly context: string; readonly id: string },
): boolean => {
  if (finished.context !== currentContext(workspace)) return false
  const { view, selected, roster, layout } = currentState(workspace)
  const terminal = roster.terminals.find((each) => each.id === finished.id)
  if (!terminal || !plainTitle(terminal)) return false
  // Focus shows the selected terminal; the other views show every one not hidden from them.
  return view === "focus" ? selected === finished.id : !layout.hidden[finished.id]
}

export const offerText = {
  chip: "Name it for me",
  title: "Name terminals from what they do",
  body: (state: MurmurState): string =>
    `A small model on this computer reads the agent's work and names each terminal. ${formatSize(murmurDownloadSize(state))} once.`,
  quiet: "It stays in Preferences → Addons.",
  accept: "Turn on",
  decline: "No thanks",
} as const

// What to do when an agent's turn ends complete (the hook of `watchFinishes`): put the
// chip on that terminal if the offer is due, no other addon's offer has this run, and the
// terminal can carry it. A finish that does not qualify is let go, and the next that does is
// the one.
export const nameFinished =
  ({
    backend,
    workspace,
    ui,
    commands,
  }: Pick<WorkspaceServices, "backend" | "workspace" | "ui" | "commands">) =>
  (context: string, id: string): void => {
    const { murmur } = backend
    if (!murmur || ui.getSnapshot().addonOffer !== null) return
    if (!offerDue(murmur.state.getSnapshot())) return
    if (canCarryChip(workspace.getSnapshot(), { context, id }))
      commands.offerNameTo({ context, id })
  }

// Follows the workspace's agents finishing a turn on their own (not on an error), after the
// grace (see `followFinishes`), and tells `finished` each one by its session context and
// terminal id: the moment naming terminals shows its worth. Stops with the returned function.
export const watchFinishes = (
  workspace: Store<Workspace>,
  finished: (context: string, id: string) => void,
  { graceMs }: { graceMs?: number } = {},
): (() => void) =>
  followFinishes(
    workspace,
    ({ context, terminal, finish }) => {
      if (!finish.failed) finished(context, terminal.id)
    },
    graceMs === undefined ? {} : { graceMs },
  )
