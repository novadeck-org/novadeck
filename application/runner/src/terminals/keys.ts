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
// Left, Right, Home and End, and the keypad's: they move within the box without typing.
// Up and Down recall history in a prompt, so they are content.
// eslint-disable-next-line no-control-regex -- As above.
const moves = /^\x1b(?:\[[\d;]*[CDFH]|O[CDFH]|\[[1478]~)$/

/**
 * The keys in one write. A bracketed paste is one key, whatever it holds, so its carriage
 * returns never submit.
 */
export const keysOf = (data: string, queueKey?: string): readonly Key[] => {
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
