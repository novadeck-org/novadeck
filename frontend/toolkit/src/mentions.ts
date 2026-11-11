// Where an agent's text names another agent: `@handle`, drawn in that agent's hue where the
// app knows the handle. Pure, over the text alone; the hue comes from the caller's lookup.

// A hue (1 to 8) for a handle, or null where no agent answers to it.
export type Mention = (handle: string) => number | null

export type MentionPart =
  | { readonly t: "text"; readonly text: string }
  | { readonly t: "mention"; readonly text: string; readonly hue: number }

const handleChars = "[\\p{L}\\p{N}_-]"
// Not part of a longer word, an address (`me@host`), a URL (`/@user`, `?u=@user`) or a scoped
// package (`@fox/pkg`).
const inText = new RegExp(
  `(?<![\\p{L}\\p{N}_@./:+=?&#%~-])@(${handleChars}+)(?![\\p{L}\\p{N}_/-])`,
  "gu",
)
// Inline code that is a handle alone, or Novadeck's "handle · title".
const inCode = new RegExp(`^@(${handleChars}+)(?: · .*)?$`, "su")

// Handles are lowercase to the runner, whatever case the text writes them in.
const hueOfWord = (mention: Mention, word: string): number | null => mention(word.toLowerCase())

// The handle's word in the text, without a dash the sentence ended on.
const wordOf = (handle: string): string => handle.replace(/[-_]+$/, "")

// The text as runs of plain text and mentions, or null where it names nobody the app knows.
export const mentionsIn = (text: string, mention: Mention): readonly MentionPart[] | null => {
  const parts: MentionPart[] = []
  let at = 0
  for (const match of text.matchAll(inText)) {
    const word = wordOf(match[1]!)
    const hue = word ? hueOfWord(mention, word) : null
    if (hue === null) continue
    if (match.index > at) parts.push({ t: "text", text: text.slice(at, match.index) })
    parts.push({ t: "mention", text: `@${word}`, hue })
    at = match.index + 1 + word.length
  }
  if (parts.length === 0) return null
  if (at < text.length) parts.push({ t: "text", text: text.slice(at) })
  return parts
}

// Inline code that names an agent, as the handle's mention and the rest of the code after it.
export const mentionInCode = (
  text: string,
  mention: Mention,
): { readonly hue: number; readonly handle: string; readonly rest: string } | null => {
  const match = inCode.exec(text)
  if (!match) return null
  const hue = hueOfWord(mention, match[1]!)
  if (hue === null) return null
  const handle = `@${match[1]!}`
  return { hue, handle, rest: text.slice(handle.length) }
}
