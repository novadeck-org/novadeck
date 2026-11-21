// The colours of what the overlay draws over a row: its ink is the tag's own, and what it
// draws must read on the row's ground, whatever the harness shaded it (Claude Code's history
// prompts sit on a dark band in any theme, Novadeck's light one too).

type Rgb = readonly [number, number, number]

/** A `#rrggbb` colour's channels; undefined for any other notation. */
export const parseHex = (colour: string): Rgb | undefined => {
  const found = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i.exec(colour.trim())
  return found
    ? [parseInt(found[1]!, 16), parseInt(found[2]!, 16), parseInt(found[3]!, 16)]
    : undefined
}

const toHex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b]
    .map((n) =>
      Math.round(Math.min(255, Math.max(0, n)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`

const linear = (channel: number): number => {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

/** WCAG's contrast ratio of two colours, 1 to 21. */
export const contrast = (first: Rgb, second: Rgb): number => {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const mixRgb = (from: Rgb, to: Rgb, toward: number): Rgb => [
  from[0] + (to[0] - from[0]) * toward,
  from[1] + (to[1] - from[1]) * toward,
  from[2] + (to[2] - from[2]) * toward,
]

/**
 * The colour, lightened or darkened (whichever the ground calls for) until it reads on `ground`
 * at `ratio`; the colour itself where it already does, or where either is no `#rrggbb`.
 */
export const legible = (colour: string, ground: string, ratio = 4.5): string => {
  const fg = parseHex(colour)
  const bg = parseHex(ground)
  if (!fg || !bg || contrast(fg, bg) >= ratio) return colour
  // Toward white on a dark ground, toward black on a light one.
  const end: Rgb = luminance(bg) < 0.18 ? [255, 255, 255] : [0, 0, 0]
  for (let step = 1; step <= 20; step += 1) {
    const next = mixRgb(fg, end, step / 20)
    if (contrast(next, bg) >= ratio) return toHex(next)
  }
  return toHex(end)
}

/**
 * The colour dimmed: `share` of it over the ground, kept at `floor` contrast at least so dim
 * text stays readable. Where either is no `#rrggbb`, the browser mixes them.
 */
export const dimmed = (colour: string, ground: string, share = 0.55, floor = 3): string => {
  const fg = parseHex(colour)
  const bg = parseHex(ground)
  if (!fg || !bg) return `color-mix(in srgb, ${colour} ${share * 100}%, ${ground})`
  let at = share
  let out = mixRgb(bg, fg, at)
  while (contrast(out, bg) < floor && at < 1) {
    at = Math.min(1, at + 0.05)
    out = mixRgb(bg, fg, at)
  }
  return toHex(out)
}

/** The badge that leads a notice: the ink at 20% over the ground behind the ink at 85% (both brought to read). */
export const badgeOf = (ink: string, ground: string): { tint: string; text: string } => {
  const text = legible(ink, ground)
  return { tint: dimmed(text, ground, 0.2, 1), text: dimmed(text, ground, 0.85, 1) }
}
