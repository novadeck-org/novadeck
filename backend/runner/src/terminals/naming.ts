import { basename, win32 } from "node:path"

import type { TerminalSummary, TitleSource } from "@novadeck/protocol"

import { commandWords } from "./commands.js"

export type { TitleSource }

/**
 * What names a terminal (see docs/agent-messaging.md, "Naming"), each layer kept on its
 * own so the title follows their precedence: the person's title; murmur's latest title,
 * written by a local model; and the title the agent that opened the terminal gave through
 * `open_terminal`, with its terminal's handle. The default comes from the program the
 * terminal was opened to run, never from its handle. The summary is the terminal's own
 * agent's, through `summarize`, which `agents()` lists; it is no part of the title.
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
 * `claude` for `claude --resume`, else "Terminal". It is always a valid title: trimmed,
 * at most 200 characters, without control characters.
 */
export const defaultTitle = (command: string | null): string => {
  const first = command === null ? undefined : programWord(commandWords(command))
  if (first === undefined) return "Terminal"
  const base = process.platform === "win32" ? win32.basename(first) : basename(first)
  const title = [
    ...base
      .replace(/\.(?:exe|cmd)$/i, "")
      .replace(control, "")
      .trim(),
  ]
  return title.length >= 1 && title.length <= 200 ? title.join("") : "Terminal"
}

// Characters no summary keeps: C0 and C1 control characters, and DEL.
// eslint-disable-next-line no-control-regex -- These are the characters it removes.
const control = /[\x00-\x1f\x7f-\x9f]/g

/**
 * The terminal's title and who it is from, by precedence: the person, then murmur, then
 * the opening agent's, then the default.
 */
export const titleOf = (
  naming: Naming,
  terminal: { readonly command: string | null },
): { readonly title: string; readonly source: TitleSource } => {
  if (naming.person !== null) return { title: naming.person, source: { kind: "person" } }
  if (naming.murmur) return { title: naming.murmur.title, source: { kind: "murmur" } }
  if (naming.agent)
    return {
      title: naming.agent.title,
      source: { kind: "agent", by: naming.agent.by },
    }
  return { title: defaultTitle(terminal.command), source: { kind: "default" } }
}

/** A terminal's title, and who it is from, as its summary shows them (see `titleOf`). */
export const summaryTitle = (
  naming: Naming,
  terminal: { readonly command: string | null },
): Pick<TerminalSummary, "title" | "titleSource"> => {
  const { title, source } = titleOf(naming, terminal)
  return { title, titleSource: source }
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
