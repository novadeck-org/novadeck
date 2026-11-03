import type { ScreenText } from "@novadeck/emulator/headless"
import type { AgentName } from "@novadeck/protocol"
import type { Pty } from "@novadeck/terminal/pty"

import { harnesses } from "../../harnesses/registry.js"
import type { Record } from "../record.js"

/*
 * The version some harnesses draw on their screen as they start (`Harness.screenVersion`:
 * Codex's banner). A resumed session replays its conversation over it, and Codex binds only
 * once its first hook fires, so by then the banner is gone: it is read as the process draws,
 * while the terminal's screen is the alternate one and no session is bound, and kept for
 * the binding (probed 2026-11-03, 0.166.0: shown from 350 to 500 ms after a resume began,
 * bound at 800 ms).
 */

type Seen = { readonly agent: AgentName; readonly version: string; readonly child: Pty }

const seen = new WeakMap<Record, Seen>()
const reading = new WeakMap<Record, { again: boolean }>()

// The version one screen shows, of the harness that shows one.
const read = (screen: ScreenText): { agent: AgentName; version: string } | undefined => {
  for (const [agent, harness] of Object.entries(harnesses)) {
    const version = harness.screenVersion?.(screen.rows)
    if (version !== undefined) return { agent: agent as AgentName, version }
  }
  return undefined
}

/**
 * The terminal drew: while no session is bound and its screen is the alternate one, as a
 * starting TUI's is, reads the screen for a banner. Reads follow one another and never
 * pile up. Leaving the alternate screen forgets what was seen.
 */
export const bannerDrawn = (
  record: Record,
  screenOf: () => Promise<ScreenText | undefined>,
): void => {
  const { buffer } = record.terminal.screen
  if (record.bound !== null || buffer.active !== buffer.alternate) {
    if (buffer.active !== buffer.alternate) seen.delete(record)
    return
  }
  const running = reading.get(record)
  if (running) {
    running.again = true
    return
  }
  const state = { again: false }
  reading.set(record, state)
  const child = record.terminal.pty
  void (async () => {
    try {
      do {
        state.again = false
        // eslint-disable-next-line no-await-in-loop -- Each read follows the draw before it.
        const screen = await screenOf()
        const found = screen && read(screen)
        if (found && record.terminal.pty === child && record.bound === null)
          seen.set(record, { ...found, child })
      } while (state.again)
    } catch {
      // A terminal that went meanwhile has no screen to read.
    } finally {
      reading.delete(record)
    }
  })()
}

/** The version a banner showed as `agent` started in the terminal, until it binds. */
export const bannerSeen = (record: Record, agent: AgentName): string | undefined => {
  const found = seen.get(record)
  return found && found.agent === agent && found.child === record.terminal.pty
    ? found.version
    : undefined
}
