import type { Store } from "#core/store"

import type { BackendConnectionState, TerminalKey } from "../port"

// What the demo's terminals read beyond its engine, shared by the plain demo, the
// visitor's and the debug layer that drives it.

// What a terminal's screen is doing that its metadata doesn't say: its output still on
// the way, as after a reconnection.
export type DemoScreenState = {
  readonly attaching?: true
}

// The demo's screens, by `terminalKeyId`; a terminal without an entry shows its output.
export type DemoScreenStates = Store<ReadonlyMap<string, DemoScreenState>>

// What the demo's terminals read beyond its engine: whether the far side is there to type
// into, what each screen is doing, how to start a fresh shell after one ended, and whether
// the debug panel asked for a paste to fail.
export type DemoTerminalRuntime = {
  readonly connection: Store<BackendConnectionState>
  readonly screens: DemoScreenStates
  // Restart, or Enter, on an ended terminal.
  readonly restart: (key: TerminalKey) => void
  // Whether this paste is to fail, once each time the panel asks.
  readonly failPaste?: (key: TerminalKey) => boolean
}
