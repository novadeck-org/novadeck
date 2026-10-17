import { snapshot as serialize, type MouseEncoding, type Screen } from "@novadeck/emulator/headless"
import type { TerminalEvent, TerminalSummary } from "@novadeck/protocol"

import { DomainError } from "../errors.js"

type Snapshot = Extract<TerminalEvent, { type: "snapshot" }>

/**
 * Recovery preserves the viewport; older scrollback is intentionally bounded by wire size:
 * the screen is serialized with as much of it as keeps the event within `budget`.
 */
export const snapshot = (
  screen: Screen,
  summary: TerminalSummary,
  sequence: number,
  budget: number,
  mouse: MouseEncoding,
): Snapshot => {
  const eventOf = (data: string): Snapshot => ({
    terminalId: summary.id,
    sequence,
    type: "snapshot",
    data,
    cols: summary.cols,
    rows: summary.rows,
    exit: summary.exit,
  })
  const data = serialize(screen, {
    fits: (candidate) => Buffer.byteLength(JSON.stringify(eventOf(candidate))) <= budget,
    mouse,
  })
  if (data === undefined)
    throw new DomainError(
      "SNAPSHOT_TOO_LARGE",
      "Visible terminal screen exceeds the configured snapshot allowance.",
    )
  return eventOf(data)
}
