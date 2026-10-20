import type { ScreenText } from "@novadeck/emulator/headless"
import type { Log } from "@novadeck/log"

import { tracer } from "./doorbell.js"

export type DoorbellLogOptions = {
  readonly now?: () => number
  /** How many of a terminal's trace lines are kept, to be written when something goes wrong. */
  readonly keep?: number
  /** How long messages may wait, held or not, before the lines kept are written. */
  readonly escalateMs?: number
  /** How long the doorbell may say nothing of a terminal before its wait counts as over. */
  readonly quietMs?: number
  /** Whether the rows the doorbell read are written, as verbose lines. */
  readonly verbose?: boolean
}

/** What the doorbell's log is told of each terminal. */
export type DoorbellLog = {
  /** A line of the doorbell's trace, and the screen it read, where it read one. */
  trace(terminalId: string, line: string, screen?: ScreenText): void
  /** Why the doorbell can't ring the terminal now, whatever the reason's name; null once it can. */
  hold(terminalId: string, reason: string | null): void
  /** A ring began, for messages the oldest of which has waited `messageWaitedMs`, if known. */
  ring(terminalId: string, messageWaitedMs?: number | null): void
  /** A ring failed. */
  ringFailed(terminalId: string): void
  /** The terminal stopped running: what was kept of it goes, its timer with it. */
  forget(terminalId: string): void
  /** Stops its timers. */
  close(): void
}

type State = {
  /** The latest trace lines, oldest first, each with its time. */
  lines: string[]
  reason: string | undefined
  heldSince: number | undefined
  /** When the doorbell began to look at it since its last ring. */
  waitingSince: number | undefined
  lastTrace: number | undefined
  escalated: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

/** The bottom rows a verbose line keeps of a screen: the agent's box and what is just above it. */
const screenRows = 12

/**
 * The doorbell's log: each hold, with its reason and how long it held, each ring and each
 * failed ring, written at once; its raw trace kept in memory, the last `keep` lines of each
 * terminal, and written only when a ring fails or messages have waited longer than
 * `escalateMs`, so a long day of looks never pushes a crash out of the log.
 */
export const createDoorbellLog = (log: Log, options: DoorbellLogOptions = {}): DoorbellLog => {
  const now = options.now ?? Date.now
  const keep = options.keep ?? 100
  const escalateMs = options.escalateMs ?? 5 * 60_000
  const quietMs = options.quietMs ?? 60_000
  const states = new Map<string, State>()

  const state = (terminalId: string): State => {
    const known = states.get(terminalId)
    if (known) return known
    const fresh: State = {
      lines: [],
      reason: undefined,
      heldSince: undefined,
      waitingSince: undefined,
      lastTrace: undefined,
      escalated: false,
      timer: undefined,
    }
    states.set(terminalId, fresh)
    return fresh
  }

  // The lines kept, written in order, then let go.
  const dump = (terminalId: string, held: State): void => {
    for (const line of held.lines)
      log.info("doorbell.trace", line, { data: { terminal: terminalId } })
    held.lines = []
  }

  const escalate = (terminalId: string, held: State): void => {
    if (held.escalated) return
    held.escalated = true
    const since = held.heldSince ?? held.waitingSince ?? now()
    log.warn("doorbell.held-long", "Messages have waited long for a terminal.", {
      data: { terminal: terminalId, reason: held.reason ?? "waiting", waitedMs: now() - since },
    })
    dump(terminalId, held)
  }

  const release = (terminalId: string, held: State): void => {
    if (held.reason === undefined) return
    log.info("doorbell.release", "The doorbell may ring a terminal again.", {
      data: {
        terminal: terminalId,
        reason: held.reason,
        heldMs: now() - (held.heldSince ?? now()),
      },
    })
    clearTimeout(held.timer)
    held.timer = undefined
    held.reason = undefined
    held.heldSince = undefined
  }

  return {
    trace(terminalId, line, screen) {
      const held = state(terminalId)
      const at = now()
      // A doorbell quiet for a while had nothing waiting: this begins a new wait.
      if (held.lastTrace === undefined || at - held.lastTrace > quietMs) {
        held.waitingSince = at
        held.escalated = held.reason !== undefined && held.escalated
      }
      held.lastTrace = at
      held.waitingSince ??= at
      held.lines.push(`${new Date(at).toISOString()} ${line}`)
      if (held.lines.length > keep) held.lines.shift()
      log.debug("doorbell.trace", line, { data: { terminal: terminalId } })
      if (options.verbose && screen) {
        const rows = screen.rows.filter((row) => row.trim() !== "").slice(-screenRows)
        rows.forEach((row, index) =>
          log.info("doorbell.screen", row, {
            data: { terminal: terminalId, row: index - rows.length },
            verbose: true,
          }),
        )
      }
      if (at - held.waitingSince > escalateMs) escalate(terminalId, held)
    },
    hold(terminalId, reason) {
      const held = state(terminalId)
      if (reason === null) return release(terminalId, held)
      if (reason === held.reason) return
      const from = held.reason
      held.reason = reason
      held.heldSince ??= now()
      log.info("doorbell.hold", "The doorbell holds a terminal's messages.", {
        data: { terminal: terminalId, reason, ...(from !== undefined && { from }) },
      })
      if (held.timer === undefined) {
        held.timer = setTimeout(() => escalate(terminalId, held), escalateMs)
        held.timer.unref?.()
      }
    },
    ring(terminalId, messageWaitedMs) {
      const held = state(terminalId)
      release(terminalId, held)
      log.info("doorbell.ring", "The doorbell rang a terminal.", {
        data: {
          terminal: terminalId,
          waitedMs: held.waitingSince === undefined ? 0 : now() - held.waitingSince,
          ...(messageWaitedMs != null && { messageWaitedMs }),
        },
      })
      held.waitingSince = undefined
      held.escalated = false
    },
    ringFailed(terminalId) {
      const held = state(terminalId)
      log.warn("doorbell.ring-failed", "A ring of the doorbell failed.", {
        data: { terminal: terminalId },
      })
      dump(terminalId, held)
    },
    forget(terminalId) {
      clearTimeout(states.get(terminalId)?.timer)
      states.delete(terminalId)
    },
    close() {
      for (const held of states.values()) clearTimeout(held.timer)
      states.clear()
    },
  }
}

/** The doorbell's log, once the process running the runner keeps one (see `logDoorbell`). */
export const doorbellLog: { current?: DoorbellLog } = {}

/**
 * Logs the doorbell to `log` from now on: its trace, through `tracer.sink`, and the holds and
 * rings the terminals tell it of.
 */
export const logDoorbell = (log: Log, options: DoorbellLogOptions = {}): DoorbellLog => {
  doorbellLog.current?.close()
  const created = createDoorbellLog(log, options)
  doorbellLog.current = created
  tracer.sink = (terminalId, line, screen) => created.trace(terminalId, line, screen)
  tracer.forgotten = (terminalId) => created.forget(terminalId)
  return created
}
