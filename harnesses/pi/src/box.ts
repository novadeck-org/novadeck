import type { SliceProfile } from "@novadeck/harness-core/slices"
import type { BoxProfile } from "@novadeck/tui-input/box"

/**
 * pi's input box, as its screen draws it: between two full-width rules above its footer. A
 * skeleton: no box reads yet.
 */
export const box: BoxProfile = {
  read: () => undefined,
  collapsed: () => false,
  stands: () => false,
  shell: { expands: false, starts: false, footer: () => false },
  textWidth: (columns) => columns,
  overlay: () => false,
  queued: () => false,
  collapses: () => false,
  room: (rows) => Math.max(Math.floor(rows / 3), 1),
}

export const slice: SliceProfile = {
  agent: "pi",
  side: () => "above",
  secret: () => false,
}
