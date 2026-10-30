// A secret is first marked in place: each of its characters becomes a sentinel, so the text
// keeps its length and everything around the secret. Marking a screen's continued rows as one
// text and as separate rows then lines up character for character, and the union of the two
// is what is masked. Marks are rendered as `[redacted]`, or the caller's placeholder, only at
// the end.

/** What a secret becomes, unless the caller names its own placeholder. */
export const redacted = "[redacted]"

// Stands for a secret's character. A private-use character is no letter, digit or space, so
// patterns treat it as the boundary it is.
export const sentinel = ""

// A text that holds the sentinel itself could not be told from a mark.
export const unmarked = (text: string): string => text.replaceAll(sentinel, "?")

// The same length, with a sentinel for each character but the newlines.
export const hide = (text: string): string => text.replaceAll(/[^\n]/g, sentinel)

// A quoted value with its quotes (and a JSON string's escaped quotes) kept, and what is inside hidden.
export const hideValue = (value: string): string => {
  let open = 0
  let close = 0
  if (value.startsWith('\\"')) {
    open = 2
    if (value.length >= 4 && value.endsWith('\\"')) close = 2
  } else if (value[0] === '"' || value[0] === "'") {
    open = 1
    if (value.length >= 2 && value.endsWith(value[0] ?? "")) close = 1
  }
  return (
    value.slice(0, open) +
    hide(value.slice(open, value.length - close)) +
    value.slice(value.length - close)
  )
}

// A run of marks, with the newlines between marks it spans: one mask.
export const masks = new RegExp(`${sentinel}(?:\\n*${sentinel})*`, "g")

// Each mask written as `placeholder`.
export const render = (marked: string, placeholder = redacted): string =>
  marked.replaceAll(masks, placeholder)
