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
  /** Escape, Left, Right, Home, End or Tab: they move or close, never typing in the box. */
  | { readonly kind: "neutral"; readonly text: string }
  /** Anything else, which may change the box: text typed or pasted, Up, Down, Backspace. */
  | { readonly kind: "content"; readonly text: string }

// A CSI or SS3 sequence's final byte, after its parameters.
// eslint-disable-next-line no-control-regex -- Escape sequences are what it reads.
const csi = /^\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O[\x40-\x7e])/
// What the terminal itself sends. Its answers to queries: cursor-position and device-status
// reports, device attributes, and OSC answers such as a colour's. Mouse reports, SGR
// (`ESC [ < b;x;y M` or `m`) and X10 (`ESC [ M` and three bytes), and focus reports, which
// a fullscreen TUI asks for, so each scroll, move or click over it sends one. xterm's F3
// with a modifier (`CSI 1;5 R`) reads as a cursor-position report and is left out too;
// harmless, as F3 types nothing.
const report =
  // eslint-disable-next-line no-control-regex -- As above.
  /^\x1b(?:\[(?:<(?<sgr>\d+);\d+;\d+[Mm]|M(?<x10>[\s\S])[\s\S]{2}|(?<focus>[IO])|\??[\d;]*[Rcn]|>[\d;]*c)|\][^\x07\x1b]*(?:\x07|\x1b\\))/

/**
 * Which reports the TUI asked its terminal for, as the runner's own screen of it shows:
 * the mouse's, in the encoding it reads (null while it tracks no mouse), and the focus's.
 * Until it asks, what looks like one is the person's keys.
 */
export type Reporting = { readonly mouse: "sgr" | "x10" | null; readonly focus: boolean }

/**
 * What a report is to the box: none of the person's keys; content, as a click, which can
 * open a menu; or no report at all, so keys: one the TUI never asked for, one in another
 * encoding than it reads, or an X10 one it may not read whole.
 */
const reportOf = (match: RegExpExecArray, reporting: Reporting): "none" | "content" | "keys" => {
  const { sgr, x10, focus } = match.groups ?? {}
  if (focus !== undefined) return reporting.focus ? "none" : "keys"
  // Answers to queries, whatever the TUI asked for.
  if (sgr === undefined && x10 === undefined) return "none"
  if (reporting.mouse !== (sgr !== undefined ? "sgr" : "x10")) return "keys"
  // X10's bytes past ASCII come re-encoded as UTF-8 through the terminal's pty, so the TUI
  // may read a leftover byte as typing.
  if (x10 !== undefined && /[\u0080-\uffff]/.test(match[0])) return "keys"
  // The button code: SGR's as it is, X10's offset by 32, where a byte below is no button.
  const button = sgr !== undefined ? Number(sgr) : (x10?.charCodeAt(0) ?? 0) - 32
  if (button < 0) return "keys"
  // A wheel (64) or a motion (32) report.
  return (button & (64 | 32)) !== 0 ? "none" : "content"
}

// Left, Right, Home and End, and the keypad's: they move within the box without typing.
// Up and Down recall history in a prompt, so they are content.
// eslint-disable-next-line no-control-regex -- As above.
const moves = /^\x1b(?:\[[\d;]*[CDFH]|O[CDFH]|\[[1478]~)$/

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
    const reported = report.exec(rest)
    const kind = reported ? reportOf(reported, reporting) : "keys"
    if (reported && kind !== "keys") {
      if (kind === "content") keys.push({ kind, text: reported[0] })
      at += reported[0].length
      continue
    }
    const sequence = csi.exec(rest)?.[0]
    if (sequence) {
      keys.push({ kind: moves.test(sequence) ? "neutral" : "content", text: sequence })
      at += sequence.length
      continue
    }
    if (rest[0] === "\x1b") {
      // Escape alone; with the next key, Alt (or a TUI's Shift+Enter), which types.
      const length = rest.length > 1 && rest[1] !== "\x1b" ? 2 : 1
      keys.push({ kind: length === 1 ? "neutral" : "content", text: rest.slice(0, length) })
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
      keys.push({ kind: "neutral", text: "\t" })
      at += 1
      continue
    }
    keys.push({ kind: "content", text: rest[0]! })
    at += 1
  }
  return keys
}
