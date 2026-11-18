/**
 * Which of Claude Code's `thinking` blocks its terminal shows the person.
 *
 * A thinking block holds the model's text and a `signature`, an opaque base64 protobuf that
 * Claude Code itself reads for the block's kind: field 2 holds a message whose field 1 holds
 * another, whose field 8 is the kind, a string. Two kinds were seen in 19,000 blocks of 2.1.322
 * to 2.1.327 (read in the 2.1.327 binary and in the person's own transcripts):
 * - `thinking`, with no text at all (the text is withheld; `thinkingDisplay` says `updates` or
 *   `omitted`): nothing to show;
 * - `narration`, with text, which the model writes for the person between its tool calls
 *   (`thinkingDisplay: "updates"`). The terminal draws it as the assistant's own message, in
 *   every view, and tags it with a dim "summary" (the block is always drawn, where any other
 *   thinking shows only in the transcript view and with `--verbose`, and a
 *   `redacted_thinking` block likewise).
 * The terminal's own test is the kind, with text, so the decoder's is too: `thinkingDisplay`
 * is the request's setting and says nothing of a block.
 */

// A protobuf varint at `at`, and where the next field starts; undefined where it runs past the end.
const varint = (
  bytes: Uint8Array,
  at: number,
): { readonly value: number; readonly next: number } | undefined => {
  let value = 0
  for (let shift = 0, next = at; next < bytes.length && shift < 35; shift += 7, next += 1) {
    const byte = bytes[next]!
    value += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) return { value, next: next + 1 }
  }
  return undefined
}

// The first length-delimited field numbered `wanted` of a protobuf message; undefined where
// there is none or the bytes are no message.
const lengthDelimited = (bytes: Uint8Array, wanted: number): Uint8Array | undefined => {
  for (let at = 0; at < bytes.length;) {
    const key = varint(bytes, at)
    if (!key) return undefined
    const [field, wire] = [Math.floor(key.value / 8), key.value % 8]
    if (wire === 0) {
      const skipped = varint(bytes, key.next)
      if (!skipped) return undefined
      at = skipped.next
    } else if (wire === 1) at = key.next + 8
    else if (wire === 5) at = key.next + 4
    else if (wire === 2) {
      const size = varint(bytes, key.next)
      if (!size || size.next + size.value > bytes.length) return undefined
      if (field === wanted) return bytes.subarray(size.next, size.next + size.value)
      at = size.next + size.value
    } else return undefined
  }
  return undefined
}

/** The kind a thinking block's signature names (`thinking`, `narration`); undefined where it names none. */
export const thinkingKind = (signature: unknown): string | undefined => {
  if (typeof signature !== "string" || !signature) return undefined
  const bytes = new Uint8Array(Buffer.from(signature, "base64"))
  const outer = lengthDelimited(bytes, 2)
  const inner = outer && lengthDelimited(outer, 1)
  const kind = inner && lengthDelimited(inner, 8)
  return kind ? Buffer.from(kind).toString("utf8") : undefined
}

/**
 * The text of a `thinking` block the terminal shows the person (a `narration` with words), as
 * the model wrote it; undefined for a block it doesn't show.
 */
export const shownThinking = (block: {
  readonly thinking?: unknown
  readonly signature?: unknown
}): string | undefined => {
  const text = typeof block.thinking === "string" ? block.thinking.trim() : ""
  return text && thinkingKind(block.signature) === "narration" ? text : undefined
}
