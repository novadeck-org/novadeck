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
 * output (`screenOf`) could land after the replay. It is kept until the session binds.
 */

type Seen = {
  readonly agent: AgentName
  readonly version: string
  readonly child: Pty
  // The shell prompt it was drawn after: a later prompt means the process ended.
  readonly prompted: number | null
}

const seen = new WeakMap<Record, Seen>()

// The harnesses that draw a version, once; a row is handed over alone, in one array.
const drawing = Object.entries(harnesses).flatMap(([agent, harness]) =>
  harness.screenVersion ? [{ agent: agent as AgentName, read: harness.screenVersion }] : [],
)
const row: string[] = [""]

// Whether what was seen belongs to the process now in the terminal.
const current = (record: Record, found: Seen): boolean =>
  found.child === record.terminal.pty && found.prompted === record.promptedAt

/**
 * The terminal drew: while no session is bound, and until a banner is seen for this process,
 * scans the visible rows of the active buffer (the alternate screen of a TUI, or the normal
 * one where a terminal passes no switch, as Windows' may), from the bottom up, so where an
 * earlier process's banner stands above, the nearest the bottom is the one running. Only
 * rows that may hold the banner become strings.
 */
export const bannerDrawn = (record: Record): void => {
  if (record.bound !== null || drawing.length === 0) return
  const known = seen.get(record)
  if (known) {
    if (current(record, known)) return
    seen.delete(record)
  }
  const { screen } = record.terminal
  const { active } = screen.buffer
  for (let y = screen.rows - 1; y >= 0; y--) {
    const text = active.getLine(active.baseY + y)?.translateToString(true)
    if (!text?.includes(">_")) continue
    row[0] = text
    for (const { agent, read } of drawing) {
      const version = read(row)
      if (version !== undefined) {
        seen.set(record, {
          agent,
          version,
          child: record.terminal.pty,
          prompted: record.promptedAt,
        })
        return
      }
    }
  }
}

/**
 * Takes the version a banner showed as `agent` started in the terminal, and forgets it: it
 * belongs to the session now binding, not to a process that later starts there.
 */
export const bannerTaken = (record: Record, agent: AgentName): string | undefined => {
  const found = seen.get(record)
  if (found?.agent !== agent) return undefined
  seen.delete(record)
  return current(record, found) ? found.version : undefined
}

/** Forgets what was seen: its agent ended, or the terminal's binding did. */
export const bannerForgotten = (record: Record): void => {
  seen.delete(record)
}
