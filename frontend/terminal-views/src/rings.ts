import type { DeliveryContent, RingContent, RingNote } from "@novadeck/core/messages"
import { noticeOneLine } from "@novadeck/core/notices"
import type { ThemeSource } from "@novadeck/core/port"
import {
  attachDoorbell,
  type DoorbellContent,
  type RingPart,
  type View,
} from "@novadeck/emulator/browser"

// What the owner knows of a terminal's rings: what each said, and the handles of the agents the
// session has (a notice's `@handle` takes an agent's hue only where an agent has it).
export type RingFeed = {
  readonly get: () => {
    readonly rings: readonly RingContent[]
    readonly deliveries: readonly DeliveryContent[]
    readonly handles: ReadonlySet<string>
    // Whether an agent runs in the terminal, whose TUI may draw on the alternate screen.
    readonly agent: boolean
  }
  // Calls `listener` whenever any of it changes, until the returned stop.
  readonly subscribe: (listener: () => void) => () => void
}

// How long after a ring was typed the view looks for its row at every write.
const recentMs = 60_000

const hues = [1, 2, 3, 4, 5, 6, 7, 8] as const
// The tokens Messages colours handles by (see `items/src/messages.css`): the hues, and the
// person's, which is their strong ink mixed with their muted one unless a theme sets it.
const tokens = [
  ...hues.map((hue) => `--avatar-hue-${hue}-fg`),
  "--avatar-you-fg",
  "--color-strong",
  "--color-muted",
]

const channels = (colour: string): [number, number, number] | undefined => {
  const found = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(colour)
  return found
    ? [parseInt(found[1]!, 16), parseInt(found[2]!, 16), parseInt(found[3]!, 16)]
    : undefined
}

const linear = (value: number): number => {
  const unit = value / 255
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
}
const encode = (value: number): string => {
  const clamped = Math.min(1, Math.max(0, value))
  const out = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055
  return Math.round(out * 255)
    .toString(16)
    .padStart(2, "0")
}
const toLab = ([r, g, bl]: [number, number, number]): [number, number, number] => {
  const [lr, lg, lb] = [linear(r), linear(g), linear(bl)] as const
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
// `first` over `second` by `percent` of it, mixed in oklab as `color-mix(in oklab, …)` does in
// Messages' CSS, as sRGB hex.
const mixed = (first: string, second: string, percent: number): string | undefined => {
  const a = channels(first)
  const b = channels(second)
  if (!a || !b) return undefined
  const [x, y] = [toLab(a), toLab(b)] as const
  const at = (index: number): number => (x[index]! * percent + y[index]! * (100 - percent)) / 100
  const [lightness, ca, cb] = [at(0), at(1), at(2)] as const
  const l = (lightness + 0.3963377774 * ca + 0.2158037573 * cb) ** 3
  const m = (lightness - 0.1055613458 * ca - 0.0638541728 * cb) ** 3
  const s = (lightness - 0.0894841775 * ca - 1.291485548 * cb) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return `#${rgb.map(encode).join("")}`
}

/**
 * The colours Messages draws agents and the person in, from the theme's tokens: each hue's
 * own where the theme sets one, the person's by its token or by mixing their strong and muted
 * inks. A hue the theme sets none for is left out, and draws in the terminal's ANSI colour.
 */
export const hueColours = (
  found: Readonly<Partial<Record<string, string>>>,
): Map<number | "you", string> => {
  const out = new Map<number | "you", string>()
  for (const hue of hues) {
    const colour = found[`--avatar-hue-${hue}-fg`]
    if (colour) out.set(hue, colour)
  }
  const strong = found["--color-strong"]
  const muted = found["--color-muted"]
  const you = found["--avatar-you-fg"] ?? (strong && muted ? mixed(strong, muted, 62) : undefined)
  if (you) out.set("you", you)
  return out
}

// A message as the overlay draws it. A notice is its facts and its actions on one line, its
// `Novadeck · <Kind>` header off, by the one rule the chat reads notices by.
const partOf = (note: RingNote, hueOf: (handle: string) => number): RingPart =>
  note.kind === "agent"
    ? { kind: "agent", handle: note.handle, hue: hueOf(note.handle), text: note.text }
    : note.kind === "notice"
      ? { kind: "notice", text: noticeOneLine(note.text) }
      : { kind: "person", text: note.text }

/**
 * What the overlay is told: each ring by its nonce, and each delivery with the ids of its messages
 * (a block holds no nonce, only its messages' ids, which the overlay matches as a set).
 */
export const contentOf = (
  rings: readonly RingContent[],
  deliveries: readonly DeliveryContent[],
  hueOf: (handle: string) => number,
): DoorbellContent => ({
  rings: new Map(
    rings.map((ring) => [
      ring.nonce,
      { parts: ring.parts.map((note) => partOf(note, hueOf)), more: ring.more },
    ]),
  ),
  deliveries: deliveries.map((delivery) => ({
    ids: delivery.ids,
    parts: delivery.parts.map((note) => partOf(note, hueOf)),
    more: delivery.more,
  })),
})

/**
 * Draws a terminal's ring rows and turn-end blocks over what its harness shows, from what
 * `feed` knows of them. Hues and ink follow the page's theme as Messages does; `restored` says
 * a snapshot of the host's screen was drawn, which brings the rows of old rings back.
 */
export const ringRows = (
  view: View,
  { feed, theme }: { readonly feed: RingFeed; readonly theme: ThemeSource },
): {
  readonly restored: () => void
  readonly dispose: () => void
  // How many rows it draws over now, for tests.
  readonly drawn: () => number
} => {
  const { terminal } = view
  let colours: Map<number | "you", string> | undefined
  const read = (): Map<number | "you", string> => {
    const scope = terminal.element?.isConnected ? terminal.element : document.body
    return hueColours(theme.tokens(scope, tokens))
  }
  let handles: ReadonlySet<string> = new Set()
  const hueOf = (handle: string): number => theme.hueOf?.(handle) ?? 1
  let agent = false
  const doorbell = attachDoorbell(terminal, {
    alternate: () => agent,
    hueOf: (handle) => (handles.has(handle) ? hueOf(handle) : null),
    hueColour: (hue) => (colours ??= read()).get(hue),
  })
  let known = new Set<string>()
  let knownDeliveries = new Set<number>()
  // What the last application read, to skip the many changes of other terminals' messages.
  let stamp = ""
  let first = true
  // A snapshot was drawn before the rings it holds were told of.
  let waiting = false

  const apply = (): void => {
    const now = feed.get()
    const sign = [
      now.rings.length,
      now.rings.at(-1)?.nonce,
      now.deliveries.length,
      now.deliveries.at(-1)?.at,
      [...now.handles].toSorted().join(" "),
      now.agent,
    ].join("|")
    if (sign === stamp) return
    stamp = sign
    handles = now.handles
    const agentChanged = agent !== now.agent
    agent = now.agent
    const content = contentOf(now.rings, now.deliveries, hueOf)
    doorbell.setContent(content)
    const fresh = now.rings.filter((ring) => !known.has(ring.nonce))
    const delivered = now.deliveries.filter((delivery) => !knownDeliveries.has(delivery.at))
    known = new Set(content.rings.keys())
    knownDeliveries = new Set(now.deliveries.map((delivery) => delivery.at))
    const cutoff = Date.now() - recentMs
    // Rings long typed, as after a restore or a reattach, are found through the scrollback;
    // a ring just typed, in the rows being written.
    const old = fresh.some((ring) => ring.at < cutoff) || delivered.some((each) => each.at < cutoff)
    if (
      first ||
      old ||
      (agentChanged && agent) ||
      (waiting && (content.rings.size > 0 || content.deliveries.length > 0))
    ) {
      doorbell.rescan()
      waiting = false
    }
    first = false
    if (fresh.some((ring) => ring.at >= cutoff) || delivered.some((each) => each.at >= cutoff))
      doorbell.arm()
  }
  apply()
  const unfeed = feed.subscribe(apply)
  const unthemed = theme.onChange(() => {
    colours = undefined
    doorbell.refresh()
  })
  return {
    restored: () => {
      doorbell.rescan()
      waiting = known.size === 0
    },
    drawn: () => doorbell.drawn(),
    dispose: () => {
      unfeed()
      unthemed()
      doorbell.dispose()
    },
  }
}
