import type { Store } from "#core/store"

import type { BackendConnectionState, TerminalKey } from "../port"

// What the demo's terminal surface reads beyond its engine, shared by the plain demo, the
// visitor's and the debug layer that drives it.

// What a terminal's screen is doing that its metadata doesn't say: its output still on
// the way after a reconnection, or a notice for a moment, as a failed paste's.
export type DemoScreen = {
  readonly attaching?: true
  readonly notice?: string
}

// The demo's screens, by `terminalKeyId`; a terminal without an entry shows its output.
export type DemoScreens = Store<ReadonlyMap<string, DemoScreen>>

// What the demo's terminal surface reads beyond its engine: whether the far side is
// there to type into, what its screen is doing, and how to start a fresh shell after one
// ended.
export type DemoSurfaceRuntime = {
  readonly connection: Store<BackendConnectionState>
  readonly screens: DemoScreens
  // Restart, or Enter, on an ended terminal.
  readonly restart: (key: TerminalKey) => void
}
