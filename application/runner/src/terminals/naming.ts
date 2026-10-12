import type { TitleSource } from "@novadeck/protocol"

export type { TitleSource }

/**
 * What names a terminal (see docs/agent-messaging.md, "Naming"), each layer kept on its
 * own so the title follows their precedence: the person's title; murmur's latest title,
 * written by a local model; and the title the agent that opened the terminal gave through
 * `open_terminal`, with its terminal's handle. The default comes from the terminal's
 * handle. The summary is the terminal's own agent's, through `summarize`, which
 * `agents()` lists; it is no part of the title.
 */
export type Naming = {
  readonly person: string | null
  readonly agent: { readonly title: string; readonly by: string } | null
  readonly murmur: { readonly title: string } | null
  readonly summary: string | null
}

/** A terminal nothing named yet. */
export const unnamed: Naming = { person: null, agent: null, murmur: null, summary: null }

/** The most a summary holds, in characters (code points), over at most `summaryLines` lines. */
export const summaryChars = 200
export const summaryLines = 2

/** A session's default title for its terminal with this handle: `t3` is "Terminal 03". */
export const defaultTitle = (handle: string): string =>
  `Terminal ${handle.slice(1).padStart(2, "0")}`

// Characters no summary keeps: C0 and C1 control characters, and DEL.
// eslint-disable-next-line no-control-regex -- These are the characters it removes.
const control = /[\x00-\x1f\x7f-\x9f]/g

/**
 * The terminal's title and who it is from, by precedence: the person, then murmur, then
 * the opening agent's, then the default.
 */
export const titleOf = (
  naming: Naming,
  terminal: { readonly handle: string },
): { readonly title: string; readonly source: TitleSource } => {
  if (naming.person !== null) return { title: naming.person, source: { kind: "person" } }
  if (naming.murmur) return { title: naming.murmur.title, source: { kind: "murmur" } }
  if (naming.agent)
    return { title: naming.agent.title, source: { kind: "agent", by: naming.agent.by } }
  return { title: defaultTitle(terminal.handle), source: { kind: "default" } }
}

/** The person's title given, or with null taken away, so the title is automatic again. */
export const renamed = (naming: Naming, title: string | null): Naming => ({
  ...naming,
  person: title,
})

/** The title an agent asked for as it opened the terminal: the opener's, never the person's. */
export const openedWith = (naming: Naming, title: string, by: string): Naming => ({
  ...naming,
  agent: { title, by },
})

/** Murmur's latest title for the terminal. */
export const murmured = (naming: Naming, title: string): Naming => ({
  ...naming,
  murmur: { title },
})

/** The summary the terminal's own agent gave of its work. */
export const summarized = (naming: Naming, summary: string): Naming => ({ ...naming, summary })

/** A summary as kept: each line's spaces collapsed, blank lines dropped, control characters removed. */
export const cleanSummary = (summary: string): string =>
  summary
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(control, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")

/**
 * Why a summary can't be taken; undefined when it can: one or two lines of up to
 * `summaryChars` characters, with words in it.
 */
export const summaryRefusal = (summary: string): string | undefined => {
  if (!summary) return "The summary is empty: say in a line or two what you work on."
  if (!/[\p{L}\p{N}]/u.test(summary))
    return "The summary needs words, not only symbols or invisible characters."
  const lines = summary.split("\n").length
  const chars = [...summary].length
  if (lines > summaryLines || chars > summaryChars)
    return (
      `The summary is ${chars} characters over ${lines} lines; ` +
      `keep it to ${summaryLines} lines and ${summaryChars} characters.`
    )
  return undefined
}
