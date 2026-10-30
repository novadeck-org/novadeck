import type { ItemId } from "@novadeck/core/items"
import type { BarKey } from "@novadeck/core/items/companion-bar"
import type { WindowPlace } from "@novadeck/core/layout/window-place"

// What the pane does with a terminal's bar and the items on it, as the host's commands do:
// undocking an item into a window of its own and docking it back, moving items onto
// another terminal's bar, closing one, and arranging a bar. The package declares them, and
// the host (the app's commands, which need its selection and its pulse) implements them,
// declaring that it `satisfies` this. Content actions stay on `ItemStore`. Each is one change to
// the workspace, which the backend makes so; items are named by id, terminals by id in the
// current session.
export type CompanionActions = {
  // Undocks the item into a window of its own beside its terminal, where it was dropped
  // when `place` says, or brings the window it's in forward, moving it there.
  readonly undock: (itemId: ItemId, place?: WindowPlace) => void
  // Docks a window's item back on the bar of the terminal it was shown from, open there.
  readonly dock: (windowId: string) => void
  // Moves the items onto terminal `terminalId`'s bar, each last.
  readonly place: (itemIds: readonly ItemId[], terminalId: string) => void
  // Closes the item: one `kindRules` says hides (a plan) on its own terminal's bar hides
  // until it's rewritten; anything else is gone, with the window it was in.
  readonly closeItem: (itemId: ItemId) => void
  // The person looked at items without opening them, in a peek: no longer new.
  readonly markSeen: (itemIds: readonly ItemId[]) => void
  // Opens what a bar holds on top of its pane, minimizes it from there, hides the pane,
  // hides what's on the bar, or moves an icon, which `slots` gives each by the keys it
  // stands for.
  readonly openBarTab: (terminalId: string, key: BarKey) => void
  readonly minimizeOnBar: (terminalId: string, key: BarKey) => void
  readonly closeBarPane: (terminalId: string) => void
  readonly hideOnBar: (terminalId: string, key: BarKey) => void
  readonly moveBarSlot: (
    terminalId: string,
    slots: readonly (readonly BarKey[])[],
    from: number,
    to: number,
  ) => void
}
