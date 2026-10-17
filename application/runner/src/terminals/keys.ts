import { matchReport, type Reporting } from "@novadeck/emulator/headless"

/**
 * The person's input to a terminal as keys, for messaging to tell what reached the agent's
 * input box (see docs/agent-messaging.md, "What counts"). It errs toward a draft: only a
 * bare Enter submits, and only a few keys never change the box.
 */
export type Key =
  /** A bare Enter: a carriage return of its own, not Alt or Shift+Enter, nor in a paste. */
  | { readonly kind: "enter" }
  /** A harness's queue key, as Codex's Tab: a submission outside a request. */
  | { readonly kind: "queue" }
  /** Left, Home or End: they move, never typing in the box. */
  | { readonly kind: "neutral"; readonly text: string }
  /** Escape alone: it closes, never typing in the box, or interrupts the agent's turn. */
  | { readonly kind: "escape"; readonly text: string }
  /**
   * Right or Tab, which move too, but in an empty box take Claude Code's prompt suggestion
   * as typed text: inert in a request's dialog, content at the prompt.
   */
  | { readonly kind: "accept"; readonly text: string }
  /** Anything else, which may change the box: text typed or pasted, Up, Down, Backspace. */
  | { readonly kind: "content"; readonly text: string }

// A CSI or SS3 sequence's final byte, after its parameters.
// eslint-disable-next-line no-control-regex -- Escape sequences are what it reads.
const csi = /^\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O[\x40-\x7e])/
// Left, Right, Home and End, and the keypad's: they move within the box without typing.
// Up and Down recall history in a prompt, so they are content.
// eslint-disable-next-line no-control-regex -- As above.
const moves = /^\x1b(?:\[[\d;]*[CDFH]|O[CDFH]|\[[1478]~)$/
// Right, which also takes a prompt suggestion.
// eslint-disable-next-line no-control-regex -- As above.
const right = /^\x1b(?:\[[\d;]*C|OC)$/

/**
 * A write split into the terminal's own reports (answers to its queries, focus and wheel
 * reports the TUI asked for), which are never held back, and the rest, the person's keys
 * and pastes, in their order. With `holdMouse`, the mouse's wheel and motion reports come
 * apart as `mouse`, for the caller to drop: a TUI that tracks the mouse (Claude Code's and
 * Codex's do) would take them as the person's hand over a dialog being answered, and
 * replayed later, once tracking may be off, they would read as keys.
 */
export const splitReports = (
  data: string,
  reporting: Reporting,
  holdMouse = false,
): { readonly reports: string; readonly typed: string; readonly mouse: string } => {
  let reports = ""
  let mouse = ""
  let typed = ""
  let at = 0
  while (at < data.length) {
    const rest = data.slice(at)
    if (rest.startsWith("\x1b[200~")) {
      const end = rest.indexOf("\x1b[201~")
      const length = end < 0 ? rest.length : end + 6
      typed += rest.slice(0, length)
      at += length
      continue
    }
    const reported = matchReport(rest, reporting)
    if (reported?.kind === "none") {
      const text = rest.slice(0, reported.length)
      // The mouse's reports start with `ESC [ <` (SGR) or `ESC [ M` (X10).
      // eslint-disable-next-line no-control-regex -- As above.
      if (holdMouse && /^\x1b\[[<M]/.test(text)) mouse += text
      else reports += text
      at += reported.length
      continue
    }
    // One at a time: a report starts where a key sequence ended.
    typed += rest[0]
    at += 1
  }
  return { reports, typed, mouse }
}

/**
 * The keys in one write: everything but the terminal's own reports. A bracketed paste is
 * one key, whatever it holds, so its carriage returns never submit.
 */
export const keysOf = (
  data: string,
  queueKey: string | undefined,
  reporting: Reporting,
): readonly Key[] => {
  const keys: Key[] = []
  let at = 0
  while (at < data.length) {
    const rest = data.slice(at)
    if (rest.startsWith("\x1b[200~")) {
      const end = rest.indexOf("\x1b[201~")
      const length = end < 0 ? rest.length : end + 6
      keys.push({ kind: "content", text: rest.slice(0, length) })
      at += length
      continue
    }
    const reported = matchReport(rest, reporting)
    if (reported && reported.kind !== "keys") {
      if (reported.kind === "content")
        keys.push({ kind: "content", text: rest.slice(0, reported.length) })
      at += reported.length
      continue
    }
    const sequence = csi.exec(rest)?.[0]
    if (sequence) {
      const moved = right.test(sequence) ? "accept" : moves.test(sequence) ? "neutral" : "content"
      keys.push({ kind: moved, text: sequence })
      at += sequence.length
      continue
    }
    if (rest[0] === "\x1b") {
      // Escape alone; with the next key, Alt (or a TUI's Shift+Enter), which types.
      const length = rest.length > 1 && rest[1] !== "\x1b" ? 2 : 1
      keys.push({ kind: length === 1 ? "escape" : "content", text: rest.slice(0, length) })
      at += length
      continue
    }
    if (rest[0] === "\r") {
      keys.push({ kind: "enter" })
      at += 1
      continue
    }
    if (queueKey && rest.startsWith(queueKey)) {
      keys.push({ kind: "queue" })
      at += queueKey.length
      continue
    }
    if (rest[0] === "\t") {
      keys.push({ kind: "accept", text: "\t" })
      at += 1
      continue
    }
    keys.push({ kind: "content", text: rest[0]! })
    at += 1
  }
  return keys
}
