import { cells } from "./width.js"

// What a ring row says, as runs of text in tones, laid out in cells. Pure: the overlay
// (doorbell.ts) paints what this returns over a row of the terminal.

/** What one message of a ring is, as the view is told of it. */
export type RingPart =
  | { readonly kind: "agent"; readonly handle: string; readonly hue: number; readonly text: string }
  | { readonly kind: "person"; readonly text: string }
  // Novadeck's own notice, as the one line the person is told of it (`noticeSeen`).
  | { readonly kind: "notice"; readonly text: string }

/** `hue` 1 to 8 is an agent's (`hueOf`), "you" the person's. */
export type Tone =
  | { readonly ink: true }
  | { readonly dim: true }
  | { readonly hue: number | "you"; readonly dim?: boolean }

/**
 * `badge` draws the run on a tint of the ink, as the "novadeck" label that leads a notice's
 * lines; `italic` is a notice's line.
 */
export type Run = {
  readonly text: string
  readonly tone: Tone
  readonly bold?: boolean
  readonly italic?: boolean
  readonly badge?: boolean
}

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

const badgeText = " novadeck "
const badgeWidth = cells(badgeText)
const lineJoin = " · "

// What one share of the row holds: a message, or the notices that follow one another, which
// draw as one badge and their lines, each line once.
type Unit =
  | { readonly kind: "message"; readonly part: Exclude<RingPart, { kind: "notice" }> }
  | { readonly kind: "notices"; readonly lines: readonly string[] }

const unitsOf = (parts: readonly RingPart[]): Unit[] => {
  const out: Unit[] = []
  for (const part of parts) {
    const last = out.at(-1)
    if (part.kind !== "notice") out.push({ kind: "message", part })
    else if (last?.kind === "notices") {
      if (!last.lines.includes(part.text))
        out[out.length - 1] = { ...last, lines: [...last.lines, part.text] }
    } else out.push({ kind: "notices", lines: [part.text] })
  }
  return out
}

// The runs a unit takes, cut to `max` cells.
const unitRuns = (unit: Unit, max: number): Run[] => {
  if (unit.kind === "notices") {
    // The lines are cut before the badge is; the badge only where the row is narrower than it.
    if (max <= badgeWidth) return [{ text: badgeText.slice(0, max), tone: ink, badge: true }]
    const lines = cut(unit.lines.map(flatten).join(lineJoin), max - badgeWidth - 1)
    return [
      { text: badgeText, tone: ink, badge: true },
      { text: " ", tone: dim },
      ...(lines ? [{ text: lines, tone: dim, italic: true }] : []),
    ]
  }
  const { part } = unit
  const head: Run[] = [
    part.kind === "agent"
      ? { text: `@${part.handle}`, tone: { hue: part.hue }, bold: true }
      : { text: "you", tone: { hue: "you" }, bold: true },
    { text: ": ", tone: dim },
  ]
  const used = head.reduce((sum, run) => sum + cells(run.text), 0)
  const body = flatten(part.text)
  const shown = cut(body, Math.max(0, max - used))
  const cutAt = shown.endsWith(ellipsis) && shown !== body
  const text = cutAt ? shown.slice(0, -1) : shown
  return [
    ...head,
    ...(text ? [{ text, tone: ink }] : []),
    ...(cutAt ? [{ text: ellipsis, tone: dim }] : []),
  ]
}

const natural = (unit: Unit): number =>
  unitRuns(unit, Infinity).reduce((sum, run) => sum + cells(run.text), 0)

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
 * Notices that follow one another are one share: a "novadeck" badge, then their lines in italic dim.
 * `extra` is how many messages the ring held beyond `parts`,
 * which the "+N more" counts too.
 */
export const layoutRing = (parts: readonly RingPart[], width: number, extra = 0): Run[] => {
  if (parts.length === 0) return [{ text: cut("doorbell", width), tone: dim }]
  const units = unitsOf(parts)
  const gapWidth = cells(gap)
  const total = units.length + extra
  const fits = (count: number): boolean =>
    count * leastShare +
      (count - 1) * gapWidth +
      (count < total ? cells(moreText(total - count)) : 0) <=
    width
  let shown = Math.min(
    units.length,
    Math.max(1, Math.floor((width + gapWidth) / (leastShare + gapWidth))),
  )
  while (shown > 1 && !fits(shown)) shown -= 1
  const more = total - shown
  const room = width - (shown - 1) * gapWidth - (more > 0 ? cells(moreText(more)) : 0)
  const taken = shares(units.slice(0, shown).map(natural), Math.max(room, 0))
  const out: Run[] = []
  units.slice(0, shown).forEach((unit, index) => {
    if (index > 0) out.push({ text: gap, tone: dim })
    out.push(...unitRuns(unit, taken[index]!))
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
  options: { readonly rules?: boolean; readonly extra?: number } = {},
): Run[][] => {
  const rules = options.rules !== false
  const lines: Run[][] = parts.map((part) => layoutRing([part], width))
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
