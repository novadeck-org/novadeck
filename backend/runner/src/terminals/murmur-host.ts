import { readScreen, type ScreenText } from "@novadeck/emulator/headless"

import type { MurmurHost, MurmurSubject } from "./descriptions.js"
import type { Names } from "./names.js"
import { peerOf } from "./peers-host.js"
import type { Record } from "./record.js"
import { shellAtPrompt } from "./sampling.js"
import type { Saves } from "./saving.js"
import type { Streams } from "./streams.js"
import { savedSummaryOf } from "./summary.js"
import { murmured } from "./titles.js"

/** What murmur reads of a running terminal's record. */
const murmurSubject = (record: Record): MurmurSubject => ({
  ...peerOf(record),
  agent: record.bound?.binding.agent ?? null,
  program: record.summary.process,
  atPrompt: shellAtPrompt(record),
  expecting: record.bound === null ? record.expecting : null,
})

/**
 * The screen row the shell's last command was typed on, from the prompt markers: at the
 * prompt, the line of the prompt before the current one; while a program runs, or a line
 * was entered and its prompt has not been reported yet, the line of the latest, which the
 * command was started from. A marker marks the first line of its prompt, which is the
 * command's line for a one-line prompt. Undefined with no such marker, when its line has
 * left the screen or the buffer, when a full-screen program draws, or when the line is now
 * blank (cleared in place): never another line's row. A prompt no command was entered at
 * keeps no marker, so the row is the last command's, not an empty Enter's. On Windows,
 * ConPTY may desync OSC 9;9 from the frames it renders and repaint on resize, so the row
 * there is best-effort.
 */
const commandRowOf = (record: Record): number | undefined => {
  const buffer = record.terminal.screen.buffer.active
  if (buffer.type === "alternate") return undefined
  const running = !shellAtPrompt(record) || record.lineEntered
  const marker = running ? record.prompts.at(-1) : record.prompts.at(-2)
  if (!marker || marker.isDisposed || marker.line < 0) return undefined
  const row = marker.line - buffer.viewportY
  if (row < 0 || row >= record.terminal.screen.rows) return undefined
  const line = buffer.getLine(marker.line)
  return line && line.translateToString(true).trim() !== "" ? row : undefined
}

/**
 * Keeps the line of the prompt just reported (the parser runs this with the cursor where
 * it is drawn). The prompt before it is kept if a command was entered there, else
 * dropped: it names no command.
 */
export const markPrompt = (
  record: Pick<Record, "prompts" | "terminal">,
  entered: boolean,
): void => {
  if (!entered) record.prompts.pop()?.dispose()
  const marker = record.terminal.screen.registerMarker(0)
  if (!marker) return
  record.prompts.push(marker)
  while (record.prompts.length > 2) record.prompts.shift()?.dispose()
}

/** Disposes the prompt markers, as when the shell ends or is replaced. */
export const forgetPrompts = (record: Pick<Record, "prompts">): void => {
  for (const marker of record.prompts) marker.dispose()
  record.prompts = []
}

export type DescribingHost = {
  /** The record of a terminal that is running, if it is. */
  readonly live: (terminalId: string) => Record | undefined
  /** Every terminal the runner holds. */
  readonly records: () => Iterable<Record>
  /** Whether the runner holds the terminal, running or retained. */
  readonly holds: (terminalId: string) => boolean
  readonly projectFolder: (sessionId: string) => string | undefined
  readonly names: () => Names<Record>
  readonly saves: () => Saves
  readonly streams: () => Streams<Record>
}

/**
 * A plain shell's screen as murmur is shown it: the screen, and the row the last command
 * was typed on (see `commandRowOf`), read together once the screen has drawn.
 */
const shellScreenOf = async (
  host: DescribingHost,
  terminalId: string,
): Promise<{ text: ScreenText; commandRow?: number } | undefined> => {
  const record = host.live(terminalId)
  if (!record) return undefined
  const child = record.terminal.pty
  const shown = await record.terminal.readScreen((screen) => {
    const commandRow = commandRowOf(record)
    return { text: readScreen(screen), ...(commandRow !== undefined && { commandRow }) }
  })
  return record.terminal.pty === child && host.live(terminalId) ? shown : undefined
}

/** What murmur reads of the terminals and writes to them. */
export const murmurHost = (host: DescribingHost): MurmurHost => ({
  subject: (terminalId) => {
    const record = host.live(terminalId)
    return record && murmurSubject(record)
  },
  subjects: () =>
    [...host.records()].flatMap((record) =>
      host.live(record.summary.id) ? [murmurSubject(record)] : [],
    ),
  screen: async (terminalId) => {
    const shown = await shellScreenOf(host, terminalId)
    const screen = shown?.text
    return (
      screen && {
        rows: screen.rows,
        alternate: screen.alternate,
        ...(shown.commandRow !== undefined && { commandRow: shown.commandRow }),
        ...(screen.wrapped && { wrapped: screen.wrapped }),
        ...(screen.continues && { continues: screen.continues }),
      }
    )
  },
  projectFolder: (sessionId) => host.projectFolder(sessionId),
  described: (terminalId, description) => {
    const record = host.live(terminalId)
    if (!record) return
    record.naming = murmured(record.naming, description.title)
    host.names().retitle(record)
    host.saves().save(record, false)
  },
  cleared: () => {
    // Murmur is off or gone: its titles go, running terminals' and saved ones'.
    for (const record of host.records()) {
      if (record.naming.murmur === null) continue
      record.naming = { ...record.naming, murmur: null }
      host.names().retitle(record)
      host.saves().save(record, false)
    }
    // Kept terminals no longer running still show to clients as saved summaries.
    for (const id of host.saves().clearMurmurTitles()) {
      const saved = host.holds(id) ? undefined : host.saves().saved(id)
      if (saved) host.streams().changed(() => savedSummaryOf(saved))
    }
  },
})
