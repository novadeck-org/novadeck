/**
 * A rough account of the line the person is typing at a shell's prompt, kept from the keys
 * sent to it, so that an Enter on a line with nothing on it (after Ctrl+L, a line typed and
 * erased, a press on an empty prompt) is not taken for a command. The shell owns the line;
 * this only counts, and says "unknown" where keys may bring text in that it cannot see.
 */
export type Line = {
  /** How many characters are on the line, as far as the keys tell; never below 0. */
  readonly length: number
  /** The keys may have brought text in (history, search, completion, a paste): it counts as typed. */
  readonly unknown: boolean
}

export const emptyLine: Line = { length: 0, unknown: false }

// An escape sequence: CSI (arrows, function keys, bracketed paste marks, focus reports) or
// SS3 (application arrows, F1 to F4), whole, so none of its characters is counted as typed.
// eslint-disable-next-line no-control-regex -- Escape sequences, whole.
const escapes = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001bO[@-~]/y

// What moves the cursor or reports focus and changes no text: ← → and Home/End in CSI and
// SS3 forms (`ESC [ H`, `ESC [ 1 ~`, `ESC [ 4 ~`, `ESC O F`), and the focus reports.
// eslint-disable-next-line no-control-regex -- Escape sequences, whole.
const harmless = /^\u001b(?:\[(?:[0-9;]*[CDHF]|[1478]~|[IO])|O[CDHF])$/

// Ctrl+A, Ctrl+B, Ctrl+E, Ctrl+F (cursor moves) and Ctrl+L (redraw).
const calm = new Set(["\u0001", "\u0002", "\u0005", "\u0006", "\u000c"])

/**
 * The line after `data` was sent, and whether an Enter in it entered a line that had
 * something on it (the count above 0, or unknown). Characters (code points) add one;
 * Backspace and DEL remove one; Ctrl+U, Ctrl+C and Ctrl+W empty the line (Ctrl+W removes a
 * word, taken for all). Cursor moves, Ctrl+L and focus reports change nothing. Anything
 * else that is not a printable character (history with ↑, ↓, Ctrl+P, Ctrl+N, search,
 * completion, yank, F3 or F8 recalls, a paste, Alt keys) may bring text in that this cannot
 * see, so it makes the line unknown, which counts as typed.
 */
export const afterKeys = (line: Line, data: string): { line: Line; entered: boolean } => {
  let { length, unknown } = line
  let entered = false
  let at = 0
  while (at < data.length) {
    if (data[at] === "\u001b") {
      escapes.lastIndex = at
      const sequence = escapes.exec(data)?.[0]
      if (!sequence) {
        // A lone Escape, or Alt with a key: it may do anything.
        unknown = true
        at += 1
        continue
      }
      if (!harmless.test(sequence)) unknown = true
      at += sequence.length
      continue
    }
    const char = String.fromCodePoint(data.codePointAt(at)!)
    at += char.length
    if (char === "\r" || char === "\n") {
      if (length > 0 || unknown) entered = true
      length = 0
      unknown = false
    } else if (char === "\u007f" || char === "\b") length = Math.max(0, length - 1)
    else if (char === "\u0015" || char === "\u0003" || char === "\u0017") {
      length = 0
      unknown = false
    } else if (calm.has(char)) continue
    else if (char < " ") unknown = true
    else length += 1
  }
  return { line: { length, unknown }, entered }
}
