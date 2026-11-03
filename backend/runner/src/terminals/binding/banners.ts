import type { AgentName } from "@novadeck/protocol"
import type { Pty } from "@novadeck/terminal/pty"

import { harnesses } from "../../harnesses/registry.js"
import type { Record } from "../record.js"

/*
 * The version some harnesses draw on their screen as they start (`Harness.screenVersion`:
 * Codex's banner). A resumed session replays its conversation over it, and Codex binds only
 * once its first hook fires, so by then the banner is gone (probed 2026-11-03, 0.166.0,
 * 40 rows: drawn about 350 ms after the start, covered about 150 ms later, the session bound
 * about 800 ms after the start). So the banner is looked for in the draw handler itself,
 * synchronously, in the rows the emulator holds at that moment: a read queued behind the
 * output (`screenOf`) could land after the replay.
 *
 * While no session is bound every draw is scanned and the nearest-the-bottom banner found
 * replaces what was kept; a scan that finds none (the banner covered) keeps it. So a banner
 * an earlier process left on screen (inline mode, a transcript replayed after a restart, a
 * Codex killed on the alternate screen) gives way to the next process's, drawn later and
 * lower. What was kept stays with the pty's process: a session switch inside it binds again
 * with it; it goes as the bound agent's session ends (`bannerForgotten`), and does not
 * apply to another pty.
 */

type Seen = { readonly agent: AgentName; readonly version: string; readonly child: Pty }

const seen = new WeakMap<Record, Seen>()

// The harnesses that draw a version, once; a row is handed over alone, in one array.
const drawing = Object.entries(harnesses).flatMap(([agent, harness]) =>
  harness.screenVersion && harness.screenMarker
    ? [{ agent: agent as AgentName, read: harness.screenVersion, marker: harness.screenMarker }]
    : [],
)
const row: string[] = [""]

/**
 * The terminal drew: while no session is bound, scans the visible rows of the active buffer
 * (the alternate screen of a TUI, or the normal one where a terminal passes no switch, as
 * Windows' may), from the bottom up. A row becomes a string whole only if its first columns
 * hold the harness's marker.
 */
export const bannerDrawn = (record: Record): void => {
  if (record.bound !== null || drawing.length === 0) return
  const { screen } = record.terminal
  const { active } = screen.buffer
  for (let y = screen.rows - 1; y >= 0; y--) {
    const line = active.getLine(active.baseY + y)
    if (!line) continue
    for (const { agent, read, marker } of drawing) {
      if (!line.translateToString(false, 0, marker.columns).includes(marker.text)) continue
      row[0] = line.translateToString(true)
      const version = read(row)
      if (version !== undefined) {
        seen.set(record, { agent, version, child: record.terminal.pty })
        return
      }
    }
  }
}

/** The version a banner showed as `agent` started in the terminal's process, if it has. */
export const bannerSeen = (record: Record, agent: AgentName): string | undefined => {
  const found = seen.get(record)
  return found?.agent === agent && found.child === record.terminal.pty ? found.version : undefined
}

/** Forgets what was seen: the agent's session ended, and with it, its process. */
export const bannerForgotten = (record: Record): void => {
  seen.delete(record)
}
