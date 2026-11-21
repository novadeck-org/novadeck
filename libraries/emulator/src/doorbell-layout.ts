import { cells } from "./width.js"

// What a ring row says, as runs of text in tones, laid out in cells. Pure: the overlay
// (doorbell.ts) paints what this returns over a row of the terminal.

/** What one message of a ring is, as the view is told of it. */
export type RingPart =
  | { readonly kind: "agent"; readonly handle: string; readonly hue: number; readonly text: string }
  | { readonly kind: "person"; readonly text: string }
  // Novadeck's own notice, as its facts and actions on one line (the caller took its header off).
  | { readonly kind: "notice"; readonly text: string }

/** `hue` 1 to 8 is an agent's (`hueOf`), "you" the person's. */
export type Tone =
  | { readonly ink: true }
  | { readonly dim: true }
  | { readonly hue: number | "you"; readonly dim?: boolean }

export type Run = { readonly text: string; readonly tone: Tone; readonly bold?: boolean }

/** How the view colours a handle named inside a notice: its hue, or null when it knows none. */
export type HueOf = (handle: string) => number | null

const ink: Tone = { ink: true }
const dim: Tone = { dim: true }
const gap = "  ·  "
const ellipsis = "…"
/** The least a message gets of a row, in cells, before the rest become "+N more". */
export const leastShare = 30

export const flatten = (text: string): string => text.replace(/\s+/g, " ").trim()

/** The first `max` cells of the text, ending in "…" where it was cut. */
export const cut = (text: string, max: number): string => {
  if (max <= 0) return ""
  if (cells(text) <= max) return text
  let out = ""
  let used = 0
  for (const char of text) {
    const width = cells(char)
    if (used + width > max - 1) break
    out += char
    used += width
  }
  return out + ellipsis
}

// A notice's text as runs, each `@handle` in its hue (dimmed), the rest dim.
const noticeRuns = (text: string, hueOf: HueOf): Run[] => {
  const out: Run[] = []
  let last = 0
  for (const found of text.matchAll(/@([A-Za-z][\w-]*)/g)) {
    const hue = hueOf(found[1]!)
    if (hue === null) continue
    if (found.index > last) out.push({ text: text.slice(last, found.index), tone: dim })
    out.push({ text: found[0], tone: { hue, dim: true }, bold: true })
    last = found.index + found[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), tone: dim })
  return out
}

// The runs a part's text takes, cut to `max` cells; `whole` marks a ring with only notices.
const partRuns = (part: RingPart, max: number, hueOf: HueOf, whole: boolean): Run[] => {
  const head: Run[] =
    part.kind === "agent"
      ? [
          { text: `@${part.handle}`, tone: { hue: part.hue, dim: whole }, bold: true },
          { text: ": ", tone: dim },
        ]
      : part.kind === "person"
        ? [
            { text: "you", tone: { hue: "you" }, bold: true },
            { text: ": ", tone: dim },
          ]
        : []
  const used = head.reduce((sum, run) => sum + cells(run.text), 0)
  const body = flatten(part.text)
  const room = Math.max(0, max - used)
  const shown = cut(body, room)
  if (part.kind === "notice") return noticeRuns(shown, hueOf)
  const cutAt = shown.endsWith(ellipsis) && shown !== body
  const text = cutAt ? shown.slice(0, -1) : shown
  return [
    ...head,
    ...(text ? [{ text, tone: ink }] : []),
    ...(cutAt ? [{ text: ellipsis, tone: dim }] : []),
  ]
}

const natural = (part: RingPart, hueOf: HueOf, whole: boolean): number =>
  partRuns(part, Infinity, hueOf, whole).reduce((sum, run) => sum + cells(run.text), 0)

// Equal shares of `total` cells for the wanted lengths: a short message hands what it
// doesn't need to the longer ones.
export const shares = (wanted: readonly number[], total: number): number[] => {
  const out = wanted.map(() => 0)
  let open = wanted.map((_, index) => index)
  let left = total
  while (open.length > 0) {
    const each = Math.floor(left / open.length)
    const fit = open.filter((index) => wanted[index]! <= each)
    if (fit.length === 0) {
      open.forEach((index) => (out[index] = each))
      break
    }
    for (const index of fit) {
      out[index] = wanted[index]!
      left -= wanted[index]!
    }
    open = open.filter((index) => !fit.includes(index))
  }
  return out
}

const moreText = (count: number): string => `${gap}+${count} more`

/**
 * One row of `width` cells for the parts. With none known it says "doorbell". Messages share
 * the row equally, each at least `leastShare` cells; the ones that don't fit become "+N more".
 * A ring of notices alone is all dim. `extra` is how many messages the ring held beyond `parts`,
 * which the "+N more" counts too.
 */
export const layoutRing = (
  parts: readonly RingPart[],
  width: number,
  hueOf: HueOf,
  extra = 0,
): Run[] => {
  if (parts.length === 0) return [{ text: cut("doorbell", width), tone: dim }]
  const whole = parts.every((part) => part.kind === "notice")
  const gapWidth = cells(gap)
  const total = parts.length + extra
  const fits = (count: number): boolean =>
    count * leastShare +
      (count - 1) * gapWidth +
      (count < total ? cells(moreText(total - count)) : 0) <=
    width
  let shown = Math.min(
    parts.length,
    Math.max(1, Math.floor((width + gapWidth) / (leastShare + gapWidth))),
  )
  while (shown > 1 && !fits(shown)) shown -= 1
  const more = total - shown
  const room = width - (shown - 1) * gapWidth - (more > 0 ? cells(moreText(more)) : 0)
  const taken = shares(
    parts.slice(0, shown).map((part) => natural(part, hueOf, whole)),
    Math.max(room, 0),
  )
  const out: Run[] = []
  parts.slice(0, shown).forEach((part, index) => {
    if (index > 0) out.push({ text: gap, tone: dim })
    out.push(...partRuns(part, taken[index]!, hueOf, whole))
  })
  if (more > 0) out.push({ text: moreText(more), tone: dim })
  return out
}

/**
 * The rows of a delivery block drawn over `rows` rows of `width` cells: a row per message
 * (as a ring row says one), then a dim "rules for the agent" where the delivery has rules,
 * the rest left blank. Short of rows, the last one says how many more there are.
 */
export const layoutBlock = (
  parts: readonly RingPart[],
  width: number,
  rows: number,
  hueOf: HueOf,
  options: { readonly rules?: boolean; readonly extra?: number } = {},
): Run[][] => {
  const rules = options.rules !== false
  const lines: Run[][] = parts.map((part) => layoutRing([part], width, hueOf))
  if ((options.extra ?? 0) > 0)
    lines.push([{ text: cut(`+${options.extra} more`, width), tone: dim }])
  if (rules) lines.push([{ text: cut("rules for the agent", width), tone: dim }])
  if (lines.length <= rows) return lines
  const keep = Math.max(rows - 1, 0)
  const hidden = lines.length - keep
  return [...lines.slice(0, keep), [{ text: cut(`+${hidden} more`, width), tone: dim }]].slice(
    0,
    rows,
  )
}
