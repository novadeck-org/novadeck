import type { TerminalEvent, TerminalSummary } from "@novadeck/protocol"
import type { SerializeAddon } from "@xterm/addon-serialize"
import type { Terminal } from "@xterm/headless"

import { DomainError } from "../errors.js"

type Snapshot = Extract<TerminalEvent, { type: "snapshot" }>

/** Recovery preserves the viewport; older scrollback is intentionally bounded by wire size. */
export const snapshot = (
  screen: Terminal,
  serializer: SerializeAddon,
  summary: TerminalSummary,
  sequence: number,
  budget: number,
): Snapshot => {
  let scrollback = screen.buffer.normal.baseY
  while (true) {
    const event: Snapshot = {
      terminalId: summary.id,
      sequence,
      type: "snapshot",
      data: serializer.serialize({ scrollback }),
      cols: summary.cols,
      rows: summary.rows,
      status: summary.status,
      exitCode: summary.exitCode,
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
