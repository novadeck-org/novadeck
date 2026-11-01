// Rewriting cmd's AutoRun value so it prints nothing (approvals-design.md, Appendix F). Pure:
// the registry, the checks and the person's click are in autorun.ts.

/** The longest value Novadeck will read, rewrite or show. */
export const maxAutoRunChars = 4_000

/** What `silenced` made of a value: the rewrite, or the rule that refused it. */
export type Silenced = { readonly value: string } | { readonly refusal: string }

const suffix = " >nul 2>&1"

/**
 * `(<value>) >nul 2>&1`, unless some command in the value could have its end moved by the
 * wrapper's `)`: then the rule that refuses it, in a sentence the person can read.
 *
 * The scanner follows what cmd does with a command line after its percent expansion
 * (phase 2): outside quotes `^` escapes the next character, a quote included, and inside
 * quotes `^` is an ordinary character; a `"` that isn't escaped starts or ends a quote.
 * Only simple commands pass, as `&`, `&&`, `||` and `|` join them but a parenthesis would
 * open a block the wrapper's could close early. A value that holds a percent sign outside
 * quotes is refused too: cmd expands it before it reads any parenthesis, so a variable
 * holding `(x86)` would close the block. An expanded quote could still flip the quote
 * state, which is why the checks afterwards (autorun.ts) read what cmd prints.
 */
export const silenced = (value: string): Silenced => {
  if (/[\r\n\0]/.test(value)) return { refusal: "it holds a line break or a NUL character" }
  if (value.length > maxAutoRunChars)
    return { refusal: `it is over ${maxAutoRunChars} characters long` }
  // `::` starts a comment in a batch file and a label is no command: either would swallow the
  // wrapper's end, whatever surrounds it.
  if (value.includes("::")) return { refusal: "it holds `::`, which cmd reads as a comment" }
  // What is left outside quotes, with each escaped character reduced to a filler.
  let bare = ""
  let quoted = false
  let first = true
  for (let at = 0; at < value.length; at += 1) {
    const char = value[at] as string
    if (char === '"') {
      quoted = !quoted
      first = false
      continue
    }
    if (quoted) continue
    if (char === "^") {
      const next = value[at + 1]
      if (next === undefined) return { refusal: "it ends in a `^`" }
      // The percent sign is expanded before `^` is read, so an escape doesn't spare it.
      if (next === "%") return { refusal: "it holds a `%` outside quotes" }
      bare += "_"
      first = false
      at += 1
      continue
    }
    if (char === "(" || char === ")")
      return { refusal: "it holds a parenthesis outside quotes, which would open a block" }
    if (char === "%") return { refusal: "it holds a `%` outside quotes" }
    if (char === ">") return { refusal: "it holds a `>` outside quotes, a redirection of its own" }
    if (first && char === ":") return { refusal: "its first word is a label (it starts with `:`)" }
    if (!/\s/.test(char)) first = false
    // After a separator the next word starts a command again.
    if (char === "&" || char === "|") first = true
    bare += char
  }
  if (quoted) return { refusal: "it ends inside a quote that is still open" }
  if (/\brem\b/i.test(bare))
    return { refusal: "it holds `rem`, which comments out the rest of the line" }
  if (bare.trim() === "") return { refusal: "it is blank, so it prints nothing" }
  return { value: `(${value})${suffix}` }
}

/**
 * The value inside Novadeck's wrapper, `(<inner>) >nul 2>&1`, when `value` is exactly that
 * and `silenced` accepts the inner: what Undo puts back. Undefined for anything else, a
 * wrapper somebody else wrote around something `silenced` would refuse included.
 */
export const unwrapped = (value: string): string | undefined => {
  if (!value.startsWith("(") || !value.endsWith(`)${suffix}`)) return undefined
  const inner = value.slice(1, -(suffix.length + 1))
  const rewrite = silenced(inner)
  return "value" in rewrite && rewrite.value === value ? inner : undefined
}

/** A value's kind and its text, where the registry's bytes are in normal form. */
export type AutoRunValue = { readonly kind: "sz" | "expand"; readonly text: string }

/**
 * The value from the relay's `<kind> <base64>`, only in normal form: type `sz` or `expand`, and
 * the bytes exactly the text in UTF-16LE with one terminating NUL, valid UTF-16, no NUL
 * inside. Then the text alone gives the bytes back (`encodeValue`), which Undo relies on.
 */
export const decodeValue = (kind: string, encoded: string): AutoRunValue | undefined => {
  if (kind !== "sz" && kind !== "expand") return undefined
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.toString("base64") !== encoded) return undefined
  if (bytes.length < 2 || bytes.length % 2 !== 0) return undefined
  if (bytes[bytes.length - 1] !== 0 || bytes[bytes.length - 2] !== 0) return undefined
  try {
    const text = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, -2),
    )
    return text.includes("\0") ? undefined : { kind, text }
  } catch {
    return undefined
  }
}

/** The bytes the registry holds for `text` in normal form, in base64. */
export const encodeValue = (text: string): string =>
  Buffer.concat([Buffer.from(text, "utf16le"), Buffer.alloc(2)]).toString("base64")

/**
 * What the person is shown of a value that isn't in normal form: its bytes read as UTF-16
 * wherever they can be, else nothing. Display only; nothing is ever written from it.
 */
export const shown = (encoded: string): string => {
  const bytes = Buffer.from(encoded, "base64")
  const even = bytes.subarray(0, bytes.length - (bytes.length % 2))
  return new TextDecoder("utf-16le").decode(even).replace(/\0+$/, "").slice(0, maxAutoRunChars)
}
