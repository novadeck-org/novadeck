import type { TerminalEvent, TerminalSummary } from "@novadeck/protocol"
import type { SerializeAddon } from "@xterm/addon-serialize"
import type { Terminal } from "@xterm/headless"

import { DomainError } from "../errors.js"
import { type MouseEncoding, restoreMouseEncoding } from "./mouse.js"

type Snapshot = Extract<TerminalEvent, { type: "snapshot" }>

/**
 * Recovery preserves the viewport; older scrollback is intentionally bounded by wire size.
 * The serializer leaves out the mouse's encoding, so it follows the screen: a client
 * restored without it would report the mouse to an SGR TUI as X10.
 */
export const snapshot = (
  screen: Terminal,
  serializer: SerializeAddon,
  summary: TerminalSummary,
  sequence: number,
  budget: number,
  mouse: MouseEncoding,
): Snapshot => {
  let scrollback = screen.buffer.normal.baseY
  while (true) {
    const event: Snapshot = {
      terminalId: summary.id,
      sequence,
      type: "snapshot",
      data: serializer.serialize({ scrollback }) + restoreMouseEncoding(mouse),
      cols: summary.cols,
      rows: summary.rows,
      exit: summary.exit,
    }
    if (Buffer.byteLength(JSON.stringify(event)) <= budget) return event
    if (scrollback === 0)
      throw new DomainError(
        "SNAPSHOT_TOO_LARGE",
        "Visible terminal screen exceeds the configured snapshot allowance.",
      )
    scrollback = Math.floor(scrollback / 2)
  }
}
