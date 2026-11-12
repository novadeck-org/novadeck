import { basename, win32 } from "node:path"

import {
  asLine,
  maxTerminalTitle,
  terminalTitle,
  titleFrom,
  type TerminalSummary,
  type TitleSource,
} from "@novadeck/protocol"

import { commandWords } from "./commands.js"

export type { TitleSource }

/**
 * What names a terminal (see docs/agent-messaging.md, "Naming"), each layer kept on its
 * own so the title follows their precedence: the person's title; the title the agent that
 * opened the terminal gave through `open_terminal` or `open_agent`, which shows as that
 * terminal's (its `openedBy`, the opener's terminal id) and which murmur never replaces, as it
 * never replaces the
 * person's; murmur's latest title, written by a local model; and the title the terminal's
 * own agent gave through `describe`, which shows when nothing above it has named the
 * terminal. The default comes from the program the terminal was opened to run, never from
 * its handle. The summary is the same agent's, through `describe` too, which `agents()`
 * lists; it is no part of the title.
 */
export type Naming = {
  readonly person: string | null
  /**
   * The title and the opener's handle when it asked, for the title's source to name: its
   * terminal is `openedBy`, by id, and the handle is only what the source shows. Absent
   * where none is kept (a closed terminal's).
   */
  readonly opener: { readonly title?: string; readonly by?: string } | null
  readonly murmur: { readonly title: string } | null
  readonly own: { readonly title: string } | null
  readonly summary: string | null
}

/** A terminal nothing named yet. */
export const unnamed: Naming = {
  person: null,
  opener: null,
  murmur: null,
  own: null,
  summary: null,
}

/** The most a summary holds, in characters (code points), over at most `summaryLines` lines. */
export const summaryChars = 200
const summaryLines = 2

const separators = new Set(["&&", ";"])

/**
 * The words of a command that name its program: past leading `VAR=value` assignments
 * and `env`, and past `cd <dir>` followed by `&&` or `;`, which may repeat.
 */
const programWord = (words: readonly string[]): string | undefined => {
  let rest = words
  for (;;) {
    const [first, second, third] = rest
    if (first === "cd" && second !== undefined && second.length > 1 && second.endsWith(";")) {
      rest = rest.slice(2)
    } else if (first === "cd" && third !== undefined && separators.has(third)) {
      rest = rest.slice(3)
    } else if (first !== undefined && (first === "env" || /^[A-Za-z_]\w*=/.test(first))) {
      rest = rest.slice(1)
    } else return first
  }
}

/**
 * The default title of a terminal nothing named: the program it was opened to run, as
 * `claude` for `claude --resume`, else "Terminal". It is always a valid title: one line
 * (`asLine`) of at most `maxTerminalTitle` characters.
 */
export const defaultTitle = (command: string | null): string => {
  const first = command === null ? undefined : programWord(commandWords(command))
  if (first === undefined) return "Terminal"
  const base = process.platform === "win32" ? win32.basename(first) : basename(first)
  // A name too long for a title is no program's name worth showing: never half of one.
  const title = asLine(base.replace(/\.(?:exe|cmd)$/i, ""))
  return title !== "" && [...title].length <= maxTerminalTitle ? title : "Terminal"
}

// Characters no summary keeps: C0 and C1 control characters, and DEL.
// eslint-disable-next-line no-control-regex -- These are the characters it removes.
const control = /[\x00-\x1f\x7f-\x9f]/g

/**
 * Whether the terminal holds a title murmur never replaces: the person's, or the one the
 * agent that opened it gave. That an agent opened the terminal is the opener's handle in
 * `naming.opener`, not `openedBy`: the opener's terminal may have closed.
 */
export const titledByHand = (naming: Pick<Naming, "person" | "opener">): boolean =>
  naming.person !== null || (naming.opener?.title !== undefined && naming.opener.by !== undefined)

/**
 * The terminal's title and who it is from, by precedence: the person, then the opening
 * agent's, then murmur, then the terminal's own agent's, then the default. A lead names its
 * teammates so it and the person can tell them apart, so a local model's later title never
 * takes that away, nor does the teammate's own.
 */
export const titleOf = (
  naming: Naming,
  terminal: {
    readonly handle: string
    readonly command: string | null
  },
): { readonly title: string; readonly source: TitleSource } => {
  // Each kept title as a title may be now: one kept before the rule took in more holds
  // what it refuses, which would fail every summary it is in.
  const person = naming.person !== null ? titleFrom(naming.person) : undefined
  if (person !== undefined) return { title: person, source: { kind: "person" } }
  // An opener's title needs the terminal that opened it to say who it is from.
  const opener = naming.opener?.title !== undefined ? titleFrom(naming.opener.title) : undefined
  if (opener !== undefined && naming.opener?.by)
    return { title: opener, source: { kind: "agent", by: naming.opener.by } }
  const murmur = naming.murmur ? titleFrom(naming.murmur.title) : undefined
  if (murmur !== undefined) return { title: murmur, source: { kind: "murmur" } }
  // The agent's own, whose source is the terminal itself, by its handle.
  const own = naming.own ? titleFrom(naming.own.title) : undefined
  if (own !== undefined) return { title: own, source: { kind: "agent", by: terminal.handle } }
  return { title: defaultTitle(terminal.command), source: { kind: "default" } }
}

/** A terminal's title, and who it is from, as its summary shows them (see `titleOf`). */
export const summaryTitle = (
  naming: Naming,
  terminal: {
    readonly handle: string
    readonly command: string | null
  },
): Pick<TerminalSummary, "title" | "titleSource"> => {
  const { title, source } = titleOf(naming, terminal)
  return { title, titleSource: source }
}

/** The person's title given, or with null taken away, so the title is automatic again. */
export const renamed = (naming: Naming, title: string | null): Naming => ({
  ...naming,
  person: title,
})

/**
 * The title an agent asked for as it opened the terminal, if it did: the opener's, never the
 * person's, with the handle the agent's terminal had, which the title's source names. The
 * handle is kept for an agent that asked for no title too.
 */
export const openedWith = (naming: Naming, title: string | undefined, by: string): Naming => ({
  ...naming,
  opener: { ...(title !== undefined && { title }), by },
})

/** Murmur's latest title for the terminal. */
export const murmured = (naming: Naming, title: string): Naming => ({
  ...naming,
  murmur: { title },
})

/** The title and summary the terminal's own agent gave of its work. */
export const described = (naming: Naming, title: string, summary: string): Naming => ({
  ...naming,
  own: { title },
  summary,
})

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
  if (!summary) return "The summary is empty: say in one short line what the work here is about."
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

/** The most an agent's own title holds, in characters (code points). */
export const ownTitleChars = 80

/**
 * Why an agent's title can't be taken; undefined when it can: one line of up to
 * `ownTitleChars` characters, with words in it, and clean of what a person's title refuses
 * (`terminalTitle`: control characters, and marks that reorder text or hide in it).
 */
export const titleRefusal = (title: string): string | undefined => {
  if (!title) return "The title is empty: name the work here in a few words."
  // Its length first: a plain title over the person's limit is too long, not malformed.
  const chars = [...title].length
  if (chars > ownTitleChars) return `The title is ${chars} characters; keep it to ${ownTitleChars}.`
  if (!terminalTitle.safeParse(title).success)
    return "The title must be one line of plain text, with no control or direction marks."
  if (!/[\p{L}\p{N}]/u.test(title))
    return "The title needs words, not only symbols or invisible characters."
  return undefined
}
