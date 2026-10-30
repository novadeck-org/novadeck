import type { KeyStep } from "@novadeck/harness-core/dialogs"

// What Antigravity's dialogs share: how its screen reads, and how a key's effect is awaited.

export const squash = (text: string): string => text.replaceAll(/\s+/g, "")

export const rule = (row: string): boolean => /^─+$/.test(row.trim())

// How long each wait for the screen to follow a key lasts.
export const timeoutMs = 3000

export type Option = {
  readonly number: number
  readonly label: string
  readonly marked: boolean
  readonly checked: boolean | undefined
}

// Numbered option rows from `from`: each `> 1. label` or `  2. label` (a multi-select's
// with its `[ ]` or `[x]`), the label's wrapped rest on rows of their own, until a blank
// row. They must run from 1 without a gap, and exactly one is marked.
export const optionsFrom = (rows: readonly string[], from: number): Option[] | undefined => {
  const options: { -readonly [Key in keyof Option]: Option[Key] }[] = []
  for (let index = from; index < rows.length; index += 1) {
    const row = rows[index]!.trimEnd()
    if (row.trim() === "") break
    const match = /^([> ]) (\d+)\. (?:\[( |x)\] )?(\S.*)$/.exec(row)
    if (match) {
      options.push({
        number: Number(match[2]),
        label: match[4]!.trim(),
        marked: match[1] === ">",
        checked: match[3] === undefined ? undefined : match[3] === "x",
      })
    } else {
      const last = options.at(-1)
      if (!last || rule(row)) return undefined
      last.label = `${last.label} ${row.trim()}`
    }
  }
  const sequential = options.every(({ number }, index) => number === index + 1)
  return options.length >= 2 && sequential && options.filter(({ marked }) => marked).length === 1
    ? options
    : undefined
}

// The footer after the options, which end at a blank row: its keys.
export const footerAfter = (rows: readonly string[], from: number): string | undefined => {
  let index = from
  while (index < rows.length && rows[index]!.trim() !== "") index += 1
  const footer = rows[index + 1]?.trim()
  return footer?.startsWith("↑/↓ Navigate") ? footer : undefined
}

export const only = <T>(found: readonly T[]): T | undefined =>
  found.length === 1 ? found[0] : undefined

export const rowsLike = (rows: readonly string[], pattern: RegExp): number[] =>
  rows.flatMap((row, index) => (pattern.test(row.trim()) ? [index] : []))

// Words typed into a one-line field: no line breaks or other control characters.
// eslint-disable-next-line no-control-regex -- These are the characters it refuses.
export const typeable = (text: string): boolean => /^[^\x00-\x1f\x7f]+$/.test(text)

// How much of typed words must show where they were typed.
const shownStart = 24

// A wait until `text`'s start shows in the row `where` finds: a row of the field it was
// typed into, never any other that happens to hold the same few letters.
export const shows = (
  text: string,
  where: (rows: readonly string[]) => string | undefined,
  why: string,
): KeyStep => {
  const start = squash(text).slice(0, shownStart)
  return {
    until: (rows) => start !== "" && squash(where(rows) ?? "").startsWith(start),
    timeoutMs,
    why,
  }
}
