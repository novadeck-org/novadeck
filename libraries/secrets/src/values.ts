// Whether a value is worth hiding: a field's value, a long run of key material, or a quote that
// only closes a literal.
import { redacted, sentinel } from "./marks.js"

// Values that say nothing: a setting, not a secret.
const plain = new Set([
  "true",
  "false",
  "null",
  "none",
  "nil",
  "undefined",
  "yes",
  "no",
  "on",
  "off",
  "required",
  "optional",
  "id",
  "name",
  "default",
  "auto",
  "string",
  "number",
  "bpe",
])
// Code that goes on to get the value from somewhere: bare values, in code's own case.
const codeWords = new Set([
  "await",
  "async",
  "new",
  "function",
  "require",
  "import",
  "return",
  "this",
  "self",
])

// Whether `value` is worth hiding: not a path, a short number or a word like `true`.
export const worthHiding = (value: string, code = false): boolean => {
  if (code && codeWords.has(value)) return false
  const bare = value.replace(/^\\?["']|\\?["']$/g, "").trim()
  if (bare === "" || bare.includes(sentinel) || bare.includes(redacted)) return false
  if (/^[/~]|^\.\.?\//.test(bare)) return false
  if (/^\d{1,7}$/.test(bare)) return false
  // A reference, a placeholder or code that reads a secret from elsewhere is not one.
  if (/^(\$|<|\{\{|%[A-Za-z_]+%)/.test(bare)) return false
  if (/process\.env|os\.environ|import\.meta|getenv|secrets\./.test(bare)) return false
  if (/^[A-Za-z_][\w.]*\(/.test(bare)) return false
  if (/^[A-Za-z_]+(?:\.[A-Za-z_]+)+[,;)]?$/.test(bare)) return false
  return !plain.has(bare.toLowerCase())
}

// Whether a short stretch of a run looks like key material: both cases of letter, and no word.
const keyLike = (piece: string): boolean =>
  /[a-z]/.test(piece) && /[A-Z]/.test(piece) && !/[a-z]{7}/.test(piece)

// Whether a run is a path: a fifth of what is between its slashes are words (random base64 has
// a slash every 64 characters or so, and sometimes a few lowercase letters between two of them).
const pathLike = (text: string): boolean => {
  if (!text.includes("/")) return false
  const parts = text.split("/")
  const words = parts.filter((part) => /^[a-z]{4,}$/.test(part)).length
  return words / parts.length >= 0.2
}

// A run is judged by what most of it looks like, in pieces of this many characters: a word
// anywhere in a key's thousands of characters (random base64 has a run of 7 lowercase letters
// about every 550 characters) must not leave it visible. A run of four pieces or more may have
// a third of them fail, if digits are a good share of it, as they are in base64 (one in six)
// and not in identifiers.
const piece = 20

// Whether a long base64 run is key material rather than a word, an identifier or a path.
export const keyLikeRun = (text: string): boolean => {
  if (text.length < 40 || !/[a-z]/.test(text) || !/[A-Z]/.test(text) || pathLike(text)) return false
  const digits = text.replaceAll(/\D/g, "").length
  // Standard base64 has `+`, `/` and `=`, which words and identifiers don't.
  const marked = /[+/]|=$/.test(text)
  if (marked ? digits < 1 : digits < 3) return false
  if (!/[a-z]{7}/.test(text)) return true
  // A mangled C++ or Rust name is long, mixed in case and full of words, and no key; it never
  // holds base64's `-`, `+`, `/` or `=`, which a key of this length almost always does.
  // A stack frame's offset may be glued on (`_ZN…E+0x1a2`, `+0x4b/0x90`).
  if (
    /^_{1,2}(?:Z[A-Za-z0-9]|R[A-Z])/.test(text) &&
    !/[-+/=]/.test(text.replace(/\+0x[0-9a-f]+(?:\/0x[0-9a-f]+)?$/, ""))
  )
    return false
  const pieces = Math.floor(text.length / piece)
  if (pieces < 4 || digits < text.length / 20) return false
  let failing = 0
  for (let i = 0; i < pieces; i += 1)
    if (!keyLike(text.slice(i * piece, i === pieces - 1 ? text.length : (i + 1) * piece)))
      failing += 1
  return failing <= Math.floor(pieces / 3)
}

// Whether `value`, found at `offset` in `text`, opens a quote it never closes while the name
// before it sits inside an open string literal of the same kind: `print("password: " +
// user.password)`. There the quote closes the literal, and opens no value.
export const closesLiteral = (value: string, offset: number, text: string): boolean => {
  const quote = value[0]
  if (quote !== '"' && quote !== "'") return false
  if (value.length > 1 && value.endsWith(quote)) return false
  const before = text.slice(0, offset)
  let count = 0
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== quote) continue
    // An apostrophe inside a word (can't, user's) opens and closes nothing.
    if (quote === "'" && /\p{L}/u.test(before[i - 1] ?? "") && /\p{L}/u.test(text[i + 1] ?? ""))
      continue
    count += 1
  }
  return count % 2 === 1
}
