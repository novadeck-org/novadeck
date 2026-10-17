import headless from "@xterm/headless"
import type { Terminal as HeadlessTerminal } from "@xterm/headless"

// The headless emulator and its serializer, from the one place that pins them.

/** xterm's emulator without a view, as Node runs it. Its package is CommonJS. */
export const Terminal = headless.Terminal
export type Terminal = HeadlessTerminal
export type { IMarker } from "@xterm/headless"
export { SerializeAddon } from "@xterm/addon-serialize"
export type { ScreenText } from "./screen.js"
