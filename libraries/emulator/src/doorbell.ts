import type {
  IBuffer,
  IBufferLine,
  IDecoration,
  IDisposable,
  IMarker,
  ITheme,
  Terminal,
} from "@xterm/xterm"

import { badgeOf, dimmed, legible } from "./doorbell-colour.js"
import {
  blockFits,
  hidesWords,
  layoutBlock,
  layoutFull,
  layoutRing,
  type RingPart,
  type Run,
  type Tone,
} from "./doorbell-layout.js"
import { cells } from "./width.js"

// Draws a doorbell's ring row, and a hook's turn-end delivery block, over the cells the harness
// drew them in, with xterm's public decorations API only (no patch). A row is drawn only where
// its text holds a nonce (or message id) the view was told; every write checks that the covered
// cells are still what they were, and drops the drawing when they aren't.

// What a ring's line is, as a harness draws it, read with its whitespace taken out (a wrapped
// line breaks anywhere): the doorbell tag with `from` and `ring` in either order (the runner types
// `from` first; sessions recorded before have `ring` first), or the person's Inbox reply: their
// words in an element, then a tag naming the ring. `whole` reads a finished tag from its start and
// captures its nonce (either quote, as a task's start prompt quotes with `'`); `start` tells whether what a row holds so far could be the start of one.
type Token = string | { readonly any: string }
const forms: readonly {
  readonly whole: RegExp
  readonly tokens: readonly Token[]
}[] = [
  {
    whole: /^<novadeck-doorbellfrom=["'][^"']*["']ring=["']([A-Za-z0-9]+)["']\/>/,
    tokens: [
      "<novadeck-doorbell",
      'from="',
      { any: "[^\"']" },
      '"ring="',
      { any: "[A-Za-z0-9]" },
      '"/>',
    ],
  },
  {
    whole: /^<novadeck-doorbellring=["']([A-Za-z0-9]+)["']from=["'][^"']*["']\/>/,
    tokens: [
      "<novadeck-doorbell",
      'ring="',
      { any: "[A-Za-z0-9]" },
      '"from="',
      { any: "[^\"']" },
      '"/>',
    ],
  },
  {
    whole: /^<novadeck-reply>[^<]*<\/novadeck-reply><endring=["']([A-Za-z0-9]+)["']\/>/,
    tokens: [
      "<novadeck-reply>",
      { any: "[^<]" },
      '</novadeck-reply><endring="',
      { any: "[A-Za-z0-9]" },
      '"/>',
    ],
  },
]

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`)

// The regular expression of every start of a form, from its first character to its last.
const startsOf = (tokens: readonly Token[]): string => {
  const [token, ...rest] = tokens
  if (token === undefined) return ""
  const after = startsOf(rest)
  if (typeof token !== "string") return `${token.any}*${after === "" ? "" : `(?:${after})?`}`
  let out = after
  for (const char of [...token].toReversed())
    out = `${char === '"' ? `["']` : escaped(char)}${out === "" ? "" : `(?:${out})?`}`
  return out
}

const starts = forms.map(({ tokens }) => new RegExp(`^(?:${startsOf(tokens)})$`))
const startsRing = (rest: string): boolean => starts.some((form) => form.test(rest))
const tagOf = (joined: string): { readonly nonce: string; readonly length: number } | undefined => {
  for (const { whole } of forms) {
    const found = whole.exec(joined)
    if (found) return { nonce: found[1]!, length: found[0].length }
  }
  return undefined
}

const blockOpen = "<novadeck-messages"
const blockClose = "</novadeck-messages>"
const maxTagRows = 16
const maxBlockRows = 160
const borders = "│┃║|"
// What a ring's row may hold besides its tag: before it, the harness's prompt mark, a border and
// blanks; after it, a border and blanks. Anything else is prose that quotes the tag, or a program's
// screen, which is no ring.
const beforeTag = /^[\s❯›>│┃║|▌▐]*$/
const afterTag = /^[\s│┃║|]*$/
// What a delivery block's first row may hold before it: Claude Code's "⎿  Stop hook says:" (or
// "feedback:"), Codex's "└", a border and blanks.
const beforeBlock = /^[\s│┃║|⎿└]*(?:Stop hook (?:says|feedback):\s*)?$/
// The most rows below a tag the person's own multi-line box may hold, to the cursor.
const maxBoxRows = 12

const strip = (text: string): string => text.replace(/\s+/g, "")

// A row's characters with the column each one starts in (a wide character takes two columns).
const mapRow = (line: IBufferLine, cols: number): { text: string; col: number[] } => {
  const cell = line.getCell(0)
  let text = ""
  const col: number[] = []
  if (!cell) return { text, col }
  for (let x = 0; x < cols; x += 1) {
    const at = line.getCell(x, cell)
    if (!at) break
    if (at.getWidth() === 0) continue
    const chars = at.getChars() || " "
    for (let unit = 0; unit < chars.length; unit += 1) col.push(x)
    text += chars
  }
  return { text, col }
}

// Whether the row could start a ring's tag or a delivery block: what is cheap to ask of its text.
// What is before it must be what a harness puts there (`beforeTag`, `beforeBlock`), so a tag quoted
// in output, as a search of this code prints it, costs no more than any other row.
const couldStart = (text: string): boolean => {
  for (let at = text.indexOf("<"); at >= 0; at = text.indexOf("<", at + 1)) {
    const before = text.slice(0, at)
    const rest = strip(text.slice(at).replace(/[\s│┃║|]+$/, ""))
    if (beforeTag.test(before) && (startsRing(rest) || tagOf(rest) !== undefined)) return true
    if (beforeBlock.test(before) && (rest.startsWith(blockOpen) || blockOpen.startsWith(rest)))
      return true
  }
  return false
}

/** A piece of what the overlay covers: a run of cells on one row. */
type Piece = {
  readonly marker: IMarker
  /** The tag's own ink, as the harness drew it; undefined where it drew it in the default. */
  readonly ink: string | undefined
  readonly x: number
  readonly width: number
  /** The covered cells' text when found; a change means the harness drew there again. */
  readonly sig: string
  readonly bg: string | undefined
  /** Blank cells before what it draws: a block's rows are drawn from the first row's column. */
  readonly pad: number
  /** What it draws; null leaves it blank. */
  readonly runs: readonly Run[] | null
  decoration: IDecoration | undefined
  /**
   * Where xterm draws no decorations (the alternate screen), the overlay's own element, laid over
   * the screen at the row's place.
   */
  alt: HTMLElement | undefined
}

type Entry = {
  readonly key: string
  readonly kind: "ring" | "block"
  /** The nonce or message id whose content it draws, which drops it when that goes. */
  readonly source: string
  readonly pieces: Piece[]
  /** What it says in full, which a click opens where its rows don't show all its words. */
  readonly parts: readonly RingPart[]
  readonly more: number
  /** The cells the opened drawing takes: from the first row's column, as wide as its lines. */
  readonly x: number
  readonly width: number
  readonly opens: boolean
}

// A drawing opened on a click: its messages in full, laid over the rows from its first one down
// (up, at the screen's foot), until a click or a key closes it.
type Opened = {
  readonly entry: Entry
  readonly element: HTMLElement
  lines: Run[][]
}

type Hit = {
  readonly key: string
  readonly source: string
  readonly rows: { y: number; x: number; width: number; bg: string | undefined }[]
  readonly parts: readonly RingPart[]
  readonly more: number
  readonly ink: string | undefined
  readonly kind: "ring" | "block"
}

/** What the view is told of the rings and deliveries it may draw. */
export type DoorbellContent = {
  /** What each ring says, by its nonce. */
  readonly rings: ReadonlyMap<string, RingEntry>
  /** What each delivery says; a block is matched to the one whose ids are the block's. */
  readonly deliveries: readonly DeliveryEntry[]
}

/** What a ring says: its parts, and how many messages it held beyond them. */
export type RingEntry = { readonly parts: readonly RingPart[]; readonly more?: number | undefined }

/** What a delivery says, with the ids of all its messages. */
export type DeliveryEntry = RingEntry & { readonly ids: readonly string[] }

export type DoorbellOptions = {
  /**
   * The colour of an agent's hue (1 to 8) or the person's ("you"), where the theme gives one
   * apart from its ANSI colours, as Messages' `--avatar-hue-N-fg` does; read each time it draws.
   */
  readonly hueColour?: (hue: number | "you") => string | undefined
  /**
   * Whether the alternate screen may hold rings (default no): a pager or an editor's screen is no
   * ring's, but an agent's own TUI may draw on it (Claude Code's fullscreen mode), which the owner,
   * knowing an agent runs there, says.
   */
  readonly alternate?: () => boolean
  /** How long after a ring arrives live a scan looks for new rows (default 60 s). */
  readonly recentMs?: number
  readonly now?: () => number
}

export type DoorbellStats = {
  scans: number
  rowsScanned: number
  scanMs: number
  verifies: number
  verifyMs: number
  drawn: number
  dropped: number
  paints: number
  paintMs: number
}

export type Doorbell = {
  /** Tells the view what the rings and deliveries say; entries drawn for what went are dropped. */
  readonly setContent: (content: DoorbellContent) => void
  /** A ring arrived live: looks at the viewport now, and at each write for the next while. */
  readonly arm: () => void
  /** Looks through the whole buffer for known rings (after a restore, or old rings arriving). */
  readonly rescan: () => void
  /** Draws again, as after a change of theme, font or scale. */
  readonly refresh: () => void
  readonly drawn: () => number
  /**
   * Opens the drawing over the cell at buffer row `row`, column `col`, as a click there does, where
   * its rows don't show all its words (or closes the one open); whether one opened.
   */
  readonly openAt: (row: number, col: number) => boolean
  /** Closes the opened drawing. */
  readonly close: () => void
  /** The opened drawing's lines, as they read. */
  readonly opened: () => string[] | undefined
  /** What each drawn entry covers now: the cells under it as the buffer holds them. */
  readonly audit: () => {
    key: string
    /** Whether a click opens it in full. */
    opens: boolean
    pieces: {
      row: number
      x: number
      width: number
      text: string
      sig: string
      /** What the drawing says over the row, its pad as blanks. */
      says: string
    }[]
  }[]
  readonly stats: DoorbellStats
  readonly dispose: () => void
}

const hueKeys = [
  "magenta",
  "red",
  "yellow",
  "blue",
  "brightMagenta",
  "green",
  "brightRed",
  "cyan",
] as const satisfies readonly (keyof ITheme)[]
const paletteKeys = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies readonly (keyof ITheme)[]

const hex = (n: number): string => n.toString(16).padStart(2, "0")

/** The colour of a palette index, the theme's for the first sixteen. */
const paletteColour = (index: number, theme: ITheme): string | undefined => {
  if (index < 16) return theme[paletteKeys[index]!]
  if (index < 232) {
    const n = index - 16
    const level = (step: number): string => hex(step === 0 ? 0 : 55 + step * 40)
    return `#${level(Math.floor(n / 36))}${level(Math.floor(n / 6) % 6)}${level(n % 6)}`
  }
  const grey = 8 + (index - 232) * 10
  return `#${hex(grey)}${hex(grey)}${hex(grey)}`
}

export const attachDoorbell = (terminal: Terminal, options: DoorbellOptions): Doorbell => {
  const now = options.now ?? ((): number => performance.now())
  const recentMs = options.recentMs ?? 60_000
  // How long a scan goes on after a drawing was dropped: the harness may have moved its row.
  const hotMs = 1500
  let content: DoorbellContent = { rings: new Map(), deliveries: [] }
  // The deliveries by the id of each message in them.
  let byId = new Map<string, DeliveryEntry[]>()
  const entries = new Map<string, Entry>()
  const stats: DoorbellStats = {
    scans: 0,
    rowsScanned: 0,
    scanMs: 0,
    verifies: 0,
    verifyMs: 0,
    drawn: 0,
    dropped: 0,
    paints: 0,
    paintMs: 0,
  }
  let armedUntil = 0
  let forceScan = false
  // A row this drew over was just invalidated: it may have moved (a TUI that redraws its screen
  // over itself moves its history by rewriting rows), so look again for a while.
  let hotUntil = 0
  let selection: { start: [number, number]; end: [number, number] } | undefined

  const buffer = (): IBuffer => terminal.buffer.active
  const theme = (): ITheme => terminal.options.theme ?? {}

  // --- Finding ---------------------------------------------------------------------------------

  const bgOf = (line: IBufferLine, x: number): string | undefined => {
    const cell = line.getCell(Math.max(0, x))
    if (!cell || cell.isBgDefault()) return undefined
    if (cell.isBgRGB()) return `#${cell.getBgColor().toString(16).padStart(6, "0")}`
    if (cell.isBgPalette()) return paletteColour(cell.getBgColor(), theme())
    return undefined
  }

  // The tag's ink: the foreground of the cell at `x`, as the harness drew it.
  const inkOf = (line: IBufferLine, x: number): string | undefined => {
    const cell = line.getCell(Math.max(0, x))
    if (!cell || cell.isFgDefault()) return undefined
    if (cell.isFgRGB()) return `#${cell.getFgColor().toString(16).padStart(6, "0")}`
    if (cell.isFgPalette()) return paletteColour(cell.getFgColor(), theme())
    return undefined
  }

  type Span = { y: number; from: number; end: number; text: string; col: number[] }

  // A row of text beside a tag's first: from past its border and blanks to before its trailing ones.
  const continuation = (y: number, line: IBufferLine): Span => {
    const { text, col } = mapRow(line, terminal.cols)
    const lead = text.search(/[^\s│┃║|]/)
    return {
      y,
      from: lead < 0 ? text.length : lead,
      end: text.replace(/[\s│┃║|]+$/, "").length,
      text,
      col,
    }
  }

  // The cells of a tag the stripped text of `rows` holds from its start, row by row: from the tag's
  // first character in a row to its last, then the blank cells to the right of it (up to what isn't
  // blank: a border). Nothing but a border and blanks may follow the tag's last character.
  const coverTag = (
    rows: Span[],
    length: number,
  ): { rows: Hit["rows"]; clean: boolean } | undefined => {
    const buf = buffer()
    let left = length
    const covered: Hit["rows"] = []
    for (const row of rows) {
      const lastRow = left <= strip(row.text.slice(row.from, row.end)).length
      let consumed = 0
      let lastIndex = row.from
      for (let index = row.from; index < row.end && consumed < left; index += 1) {
        if (!/\s/.test(row.text[index]!)) {
          consumed += 1
          lastIndex = index
        }
      }
      left -= consumed
      let stop = row.text.length
      for (let index = lastIndex + 1; index < row.text.length; index += 1) {
        if (!/\s/.test(row.text[index]!)) {
          stop = index
          break
        }
      }
      const x = row.col[row.from] ?? 0
      const limit = stop < row.col.length ? row.col[stop]! : terminal.cols
      if (limit > x)
        covered.push({ y: row.y, x, width: limit - x, bg: bgOf(buf.getLine(row.y)!, limit - 1) })
      if (lastRow) return { rows: covered, clean: afterTag.test(row.text.slice(lastIndex + 1)) }
    }
    return undefined
  }

  // A ring's tag starting at `y`, over as many rows as it takes, that fills its rows.
  const findRing = (y: number): Hit | undefined => {
    const buf = buffer()
    const first = buf.getLine(y)
    if (!first) return undefined
    const mapped = mapRow(first, terminal.cols)
    for (let at = mapped.text.indexOf("<"); at >= 0; at = mapped.text.indexOf("<", at + 1)) {
      // Nothing before it but the harness's prompt mark.
      if (!beforeTag.test(mapped.text.slice(0, at))) continue
      const end = mapped.text.replace(/[\s│┃║|]+$/, "").length
      const rest = strip(mapped.text.slice(at, end))
      // Whatever of the tag this row holds must be a start of it.
      if (!startsRing(rest) && tagOf(rest) === undefined) continue
      const rows: Span[] = [{ y, from: at, end, text: mapped.text, col: mapped.col }]
      let joined = rest
      while (tagOf(joined) === undefined && rows.length < maxTagRows) {
        const next = buf.getLine(y + rows.length)
        if (!next) break
        const row = continuation(y + rows.length, next)
        rows.push(row)
        joined += strip(row.text.slice(row.from, row.end))
        if (!startsRing(joined) && tagOf(joined) === undefined) break
      }
      const tag = tagOf(joined)
      const entry = tag && content.rings.get(tag.nonce)
      if (!tag || !entry) continue
      const covered = coverTag(rows, tag.length)
      if (!covered?.clean) continue
      return {
        key: `ring:${tag.nonce}:${y}`,
        source: tag.nonce,
        rows: covered.rows,
        parts: entry.parts,
        more: entry.more ?? 0,
        ink: inkOf(first, mapped.col[at] ?? 0),
        kind: "ring",
      }
    }
    return undefined
  }

  // The delivery a block's message ids are: the one whose ids are the same, else the one sharing
  // the most.
  const deliveryOf = (ids: readonly string[]): DeliveryEntry | undefined => {
    const set = new Set(ids)
    let best: DeliveryEntry | undefined
    let bestShared = 0
    for (const id of set)
      for (const delivery of byId.get(id) ?? []) {
        const shared = delivery.ids.filter((each) => set.has(each)).length
        const same = shared === set.size && delivery.ids.length === set.size
        if (same) return delivery
        if (shared > bestShared) {
          best = delivery
          bestShared = shared
        }
      }
    return best
  }

  // A turn-end delivery block whose `<novadeck-messages` starts on `y`, holding known message ids.
  const findBlock = (y: number): Hit | undefined => {
    const buf = buffer()
    const first = buf.getLine(y)
    if (!first) return undefined
    const mapped = mapRow(first, terminal.cols)
    const at = mapped.text.indexOf("<")
    if (at < 0 || !strip(mapped.text.slice(at)).startsWith(blockOpen)) return undefined
    const rows: { y: number; text: string; col: number[]; from: number }[] = [
      { y, text: mapped.text, col: mapped.col, from: at },
    ]
    let joined = strip(mapped.text.slice(at))
    while (!joined.includes(blockClose) && rows.length < maxBlockRows) {
      const next = buf.getLine(y + rows.length)
      if (!next) return undefined
      const row = mapRow(next, terminal.cols)
      const lead = row.text.length - row.text.trimStart().length
      rows.push({ y: y + rows.length, text: row.text, col: row.col, from: lead })
      joined += strip(row.text)
    }
    if (!joined.includes(blockClose)) return undefined
    const ids = [...joined.matchAll(/<messageid="([^"]*)"/g)].map((found) => found[1]!)
    const delivery = deliveryOf(ids)
    if (delivery === undefined) return undefined
    const covered: Hit["rows"] = []
    // Claude Code prints "Stop hook says:" on the block's first row before the tag, which the
    // drawing takes the place of; Codex's "Blocked by hook" and its "└" stay, on rows of their own.
    const says = /Stop hook (?:says|feedback):\s*$/.exec(mapped.text.slice(0, at))
    if (says) rows[0]!.from = says.index
    for (const row of rows) {
      const x = row.col[row.from] ?? 0
      const trimmed = row.text.trimEnd()
      const last = trimmed[trimmed.length - 1]
      const stop =
        last && borders.includes(last)
          ? (row.col[trimmed.length - 1] ?? terminal.cols)
          : terminal.cols
      if (stop > x)
        covered.push({ y: row.y, x, width: stop - x, bg: bgOf(buf.getLine(row.y)!, stop - 1) })
    }
    return {
      key: `block:${delivery.ids[0] ?? y}:${y}`,
      source: delivery.ids[0] ?? String(y),
      rows: covered,
      parts: delivery.parts,
      more: delivery.more ?? 0,
      ink: inkOf(first, mapped.col[at] ?? 0),
      kind: "block",
    }
  }

  // --- Drawing ---------------------------------------------------------------------------------

  const hueColour = (hue: number | "you"): string | undefined => {
    const t = theme()
    const given = options.hueColour?.(hue)
    if (given) return given
    return hue === "you" ? (t.brightBlue ?? t.blue) : t[hueKeys[(hue - 1) % 8]!]
  }

  // What a tone draws in over `bg`, the row's own ground: the tag's own ink (the terminal's where
  // the harness drew it in the default), dimmed toward that ground, and each hue brought to read on it.
  const colourOf = (tone: Tone, bg: string, ink: string): string => {
    const text = legible(ink, bg)
    if ("ink" in tone) return text
    if (!("hue" in tone)) return dimmed(text, bg)
    const base = legible(hueColour(tone.hue) ?? ink, bg)
    return tone.dim ? dimmed(base, bg) : base
  }

  const cellSize = (): { w: number; h: number } | undefined => {
    const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen")
    if (!screen || !screen.offsetWidth || !terminal.cols || !terminal.rows) return undefined
    return { w: screen.offsetWidth / terminal.cols, h: screen.offsetHeight / terminal.rows }
  }

  const isSelected = (piece: Piece): boolean => {
    if (!selection) return false
    const y = piece.marker.line
    const [sx, sy] = selection.start
    const [ex, ey] = selection.end
    if (y < sy || y > ey) return false
    const from = y === sy ? sx : 0
    const to = y === ey ? ex : terminal.cols
    return from < piece.x + piece.width && to > piece.x
  }

  const paint = (element: HTMLElement, piece: Piece): void => {
    const size = cellSize()
    if (!size) return
    const t = theme()
    const bg = piece.bg ?? t.background ?? "#000000"
    const ink = piece.ink ?? t.foreground ?? "#cccccc"
    const selected = isSelected(piece)
    // xterm renders a decoration's element on every scroll: draw again only when this changed.
    const signature = [
      size.w,
      size.h,
      terminal.options.fontFamily,
      terminal.options.fontSize,
      terminal.options.fontWeightBold,
      bg,
      ink,
      selected,
      JSON.stringify(t),
      [1, 2, 3, 4, 5, 6, 7, 8, "you" as const].map(hueColour).join(),
    ].join("|")
    if (element.dataset["novadeckDoorbell"] === signature) return
    const t0 = performance.now()
    element.style.cssText += ";pointer-events:none;"
    element.dataset["novadeckDoorbell"] = signature
    fill(element, { runs: piece.runs ?? [], pad: piece.pad, bg, ink, selected, size })
    stats.paints += 1
    stats.paintMs += performance.now() - t0
  }

  // Writes a row's runs into `element`, a cell's width to each character, on the row's ground.
  const fill = (
    element: HTMLElement,
    row: {
      readonly runs: readonly Run[]
      readonly pad: number
      readonly bg: string
      readonly ink: string
      readonly selected: boolean
      readonly size: { readonly w: number; readonly h: number }
    },
  ): void => {
    const { runs, pad, bg, ink, selected, size } = row
    const t = theme()
    element.replaceChildren()
    element.style.cssText += `;background:${bg};overflow:hidden;white-space:pre;`
    element.style.fontFamily = terminal.options.fontFamily ?? "monospace"
    element.style.fontSize = `${terminal.options.fontSize ?? 15}px`
    element.style.lineHeight = `${size.h}px`
    element.style.fontVariantLigatures = "none"
    element.style.backgroundImage =
      selected && t.selectionBackground
        ? `linear-gradient(${t.selectionBackground}, ${t.selectionBackground})`
        : ""
    if (pad > 0) {
      const spacer = document.createElement("span")
      spacer.style.cssText = `display:inline-block;width:${pad * size.w}px`
      element.append(spacer)
    }
    for (const run of runs) {
      const color = run.badge ? badgeOf(ink, bg).text : colourOf(run.tone, bg, ink)
      // The badge's tint, under the selection's colour where the row is selected: the row's own
      // selection gradient sits on the element, which the badge's spans would cover.
      const tint = run.badge
        ? `background:${
            selected && t.selectionBackground
              ? `linear-gradient(${t.selectionBackground}, ${t.selectionBackground}), `
              : ""
          }${badgeOf(ink, bg).tint};`
        : ""
      const slant = run.italic ? "font-style:italic;" : ""
      for (const char of run.text) {
        const span = document.createElement("span")
        span.textContent = char
        span.style.cssText = `display:inline-block;width:${cells(char) * size.w}px;color:${color};${tint}${slant}${run.bold ? `font-weight:${terminal.options.fontWeightBold ?? "bold"};` : ""}`
        element.append(span)
      }
    }
  }

  // Puts an alternate screen piece's element over its row, as xterm's decorations are over theirs.
  const place = (piece: Piece): void => {
    const size = cellSize()
    const element = piece.alt
    if (!size || !element) return
    const row = piece.marker.line - buffer().viewportY
    element.style.display = row >= 0 && row < terminal.rows ? "" : "none"
    element.style.left = `${piece.x * size.w}px`
    element.style.top = `${row * size.h}px`
    element.style.width = `${piece.width * size.w}px`
    element.style.height = `${size.h}px`
  }

  const remove = (entry: Entry): void => {
    if (opened?.entry === entry) close()
    for (const piece of entry.pieces) {
      piece.alt?.remove()
      piece.decoration?.dispose()
      piece.marker.dispose()
    }
    entries.delete(entry.key)
    stats.dropped += 1
  }

  const create = (hit: Hit): void => {
    const buf = buffer()
    const base = buf.baseY + buf.cursorY
    const left = hit.rows[0]!.x
    const pads = hit.rows.map((row) => Math.max(0, left - row.x))
    const widest = Math.min(...hit.rows.map((row, index) => row.width - pads[index]!))
    // A ring's tag a narrow terminal wrapped takes several rows, which its messages wrap over as a
    // block's do (with no rules to say), rather than one row cut short over rows left blank. Rows
    // fewer than its messages (and their "+N more") say them on one row, as a ring row does.
    const wraps = hit.rows.length > 1 && blockFits(hit.parts, hit.rows.length, hit.more)
    const width = hit.kind === "ring" && !wraps ? hit.rows[0]!.width : widest
    const lines =
      hit.kind === "block"
        ? layoutBlock(hit.parts, widest, hit.rows.length, { extra: hit.more })
        : wraps
          ? layoutBlock(hit.parts, widest, hit.rows.length, { rules: false, extra: hit.more })
          : [layoutRing(hit.parts, hit.rows[0]!.width, hit.more)]
    const pieces: Piece[] = []
    hit.rows.forEach((row, index) => {
      const marker = terminal.registerMarker(row.y - base)
      if (!marker) return
      const piece: Piece = {
        marker,
        ink: hit.ink,
        x: row.x,
        width: row.width,
        sig: buf.getLine(row.y)!.translateToString(false, row.x, row.x + row.width),
        bg: row.bg,
        pad: pads[index]!,
        runs: lines[index] ?? null,
        decoration: undefined,
        alt: undefined,
      }
      // xterm draws no decoration over the alternate screen: the overlay lays its own element.
      if (buf.type === "alternate") {
        const host = terminal.element?.querySelector<HTMLElement>(".xterm-screen")
        if (!host) {
          marker.dispose()
          return
        }
        piece.alt = document.createElement("div")
        piece.alt.style.cssText = "position:absolute;z-index:6;pointer-events:none;"
        host.append(piece.alt)
        place(piece)
        paint(piece.alt, piece)
        pieces.push(piece)
        return
      }
      const decoration = terminal.registerDecoration({
        marker,
        x: row.x,
        width: row.width,
        height: 1,
      })
      if (!decoration) {
        marker.dispose()
        return
      }
      piece.decoration = decoration
      decoration.onRender((element) => paint(element, piece))
      pieces.push(piece)
    })
    entries.set(hit.key, {
      key: hit.key,
      kind: hit.kind,
      source: hit.source,
      pieces,
      parts: hit.parts,
      more: hit.more,
      x: left,
      width,
      opens: pieces.length > 0 && hidesWords(lines, hit.parts, width),
    })
    stats.drawn += 1
    bind()
  }

  // --- Opening ---------------------------------------------------------------------------------

  let opened: Opened | undefined

  const screenOf = (): HTMLElement | null | undefined =>
    terminal.element?.querySelector<HTMLElement>(".xterm-screen")

  // The opened drawing over its rows: from its first row down, or up from the screen's foot where
  // the rows below are fewer than its lines. Closed once its first row leaves the screen.
  const placeOpened = (): void => {
    if (!opened) return
    const size = cellSize()
    const row = opened.entry.pieces[0]!.marker.line - buffer().viewportY
    if (row < 0 || row >= terminal.rows) {
      close()
      return
    }
    if (!size) return
    const { element, entry } = opened
    const top = Math.max(0, Math.min(row, terminal.rows - opened.lines.length))
    element.style.left = `${entry.x * size.w}px`
    element.style.top = `${top * size.h}px`
    element.style.width = `${entry.width * size.w}px`
  }

  const paintOpened = (): void => {
    if (!opened) return
    const size = cellSize()
    if (!size) return
    const { element, entry } = opened
    const t = theme()
    const first = entry.pieces[0]!
    const bg = first.bg ?? t.background ?? "#000000"
    const ink = first.ink ?? t.foreground ?? "#cccccc"
    element.style.boxShadow = `0 0 0 1px ${dimmed(legible(ink, bg), bg)}, 0 6px 16px rgba(0,0,0,0.35)`
    element.style.background = bg
    element.replaceChildren(
      ...opened.lines.map((runs) => {
        const line = document.createElement("div")
        line.style.height = `${size.h}px`
        fill(line, { runs, pad: 0, bg, ink, selected: false, size })
        return line
      }),
    )
    placeOpened()
  }

  const open = (entry: Entry): void => {
    close()
    const host = screenOf()
    if (!host) return
    const element = document.createElement("div")
    // Above xterm's decorations; it takes its own clicks, so none reaches the program below it.
    element.style.cssText =
      "position:absolute;z-index:8;pointer-events:auto;cursor:pointer;user-select:none;"
    element.dataset["novadeckDoorbellOpen"] = entry.key
    element.addEventListener("mousedown", (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    element.addEventListener("click", (event) => {
      event.stopPropagation()
      close()
    })
    host.append(element)
    opened = {
      entry,
      element,
      lines: layoutFull(entry.parts, entry.width, { extra: entry.more, most: terminal.rows }),
    }
    paintOpened()
  }

  const close = (): void => {
    opened?.element.remove()
    opened = undefined
  }

  // The drawing a click on the cell at buffer row `row`, column `col` would open.
  const entryAt = (row: number, col: number): Entry | undefined => {
    for (const entry of entries.values())
      if (
        entry.opens &&
        entry.pieces.some(
          (piece) => piece.marker.line === row && col >= piece.x && col < piece.x + piece.width,
        )
      )
        return entry
    return undefined
  }

  const openAt = (row: number, col: number): boolean => {
    if (opened) {
      close()
      return false
    }
    const entry = entryAt(row, col)
    if (!entry) return false
    open(entry)
    return true
  }

  // The buffer cell under a pointer, by the screen's box as drawn (a zoomed view's included).
  const cellAt = (event: MouseEvent): { row: number; col: number } | undefined => {
    const screen = screenOf()
    if (!screen || !terminal.cols || !terminal.rows) return undefined
    const box = screen.getBoundingClientRect()
    if (!box.width || !box.height) return undefined
    const col = Math.floor(((event.clientX - box.left) / box.width) * terminal.cols)
    const row = Math.floor(((event.clientY - box.top) / box.height) * terminal.rows)
    if (col < 0 || col >= terminal.cols || row < 0 || row >= terminal.rows) return undefined
    return { row: buffer().viewportY + row, col }
  }

  // A plain click on a drawing that doesn't show all its words opens it; a click anywhere closes
  // the one open. A drag that selects, a double click and other buttons are the terminal's own.
  let pointing = false
  const onClick = (event: MouseEvent): void => {
    if (event.button !== 0 || event.detail > 1) return
    if (opened) {
      close()
      return
    }
    if (terminal.hasSelection()) return
    const cell = cellAt(event)
    if (cell) openAt(cell.row, cell.col)
  }
  const onMove = (event: MouseEvent): void => {
    const screen = screenOf()
    if (!screen) return
    const cell = cellAt(event)
    const over = cell !== undefined && entryAt(cell.row, cell.col) !== undefined
    if (over === pointing) return
    pointing = over
    screen.style.cursor = over ? "pointer" : ""
  }
  const onLeave = (): void => {
    if (!pointing) return
    pointing = false
    const screen = screenOf()
    if (screen) screen.style.cursor = ""
  }

  // Listens on the terminal's element once it has one: a terminal opened after the overlay was
  // attached has none until then.
  let bound: HTMLElement | undefined
  const bind = (): void => {
    const element = terminal.element
    if (bound || !element) return
    bound = element
    element.addEventListener("click", onClick)
    element.addEventListener("mousemove", onMove)
    element.addEventListener("mouseleave", onLeave)
  }

  // --- Keeping honest --------------------------------------------------------------------------

  // Whether the person's own box holds the tag: the cursor is on its rows, or below them in the
  // rows of one multi-line input (blank, indented, or shaded as the tag's row), not past
  // `maxBoxRows`. A tag the harness has moved on from to its history has output below it, which
  // starts at the margin, and the cursor sits at a box further down.
  const inBox = (first: number, last: number, x: number, bg: string | undefined): boolean => {
    const buf = buffer()
    const cursor = buf.baseY + buf.cursorY
    if (cursor < first || cursor - last > maxBoxRows) return false
    if (cursor <= last) return cursor > first || buf.cursorX >= x
    for (let y = last + 1; y <= cursor; y += 1) {
      const line = buf.getLine(y)
      if (!line) return false
      const text = line.translateToString(true)
      if (text.trim() === "") continue
      if (/^\s{2,}\S/.test(text) || /^[│┃║|]\s/.test(text)) continue
      if (bg !== undefined && bgOf(line, 0) === bg) continue
      return false
    }
    return true
  }

  // The first and last row an entry covers.
  const spanOf = (entry: Entry): { first: number; last: number } => ({
    first: entry.pieces[0]!.marker.line,
    last: entry.pieces.at(-1)!.marker.line,
  })

  // Every piece's cells must read as when they were found, or the harness drew there again. A
  // piece in the scrollback only changes as its row is trimmed (its marker goes) or the screen
  // is resized (all are dropped), so only the rows of the screen are read.
  const verify = (): void => {
    if (entries.size === 0) return
    const t0 = performance.now()
    const buf = buffer()
    for (const entry of entries.values()) {
      let intact = entry.pieces.every((piece) => {
        const y = piece.marker.line
        if (piece.marker.isDisposed || y < 0) return false
        // Above the screen, nothing draws there any more.
        if (y < buf.baseY) return true
        const line = buf.getLine(y)
        return (
          line !== undefined &&
          line.translateToString(false, piece.x, piece.x + piece.width) === piece.sig
        )
      })
      if (intact && entry.kind === "ring" && entry.pieces.length > 0) {
        // The cursor is where the person types: a tag still in the box is left as typed.
        const { first, last } = spanOf(entry)
        if (last >= buf.baseY) {
          const piece = entry.pieces[0]!
          intact = !inBox(first, last, piece.x, piece.bg)
        }
      }
      if (!intact) {
        remove(entry)
        hotUntil = now() + hotMs
      }
    }
    stats.verifies += 1
    stats.verifyMs += performance.now() - t0
  }

  // The most rows a scan of the screen's rows reads in full, as it runs at every write while armed:
  // output dense with "<" (markup, diffs) costs no more. A scan of the whole buffer, after a
  // restore, a resize or a return from the alternate screen, reads every row that could start
  // one: a long session holds more rings than this, and its newest are the ones on screen.
  const maxCandidates = 24

  const scan = (from: number, to: number, budget: number): void => {
    if (content.rings.size === 0 && content.deliveries.length === 0) return
    // A pager or an editor on the alternate screen: nothing of it is a ring.
    if (buffer().type === "alternate" && !options.alternate?.()) return
    const t0 = performance.now()
    const buf = buffer()
    const last = buf.length - 1
    const a = Math.max(0, Math.min(from, last))
    const b = Math.max(a, Math.min(to, last))
    stats.scans += 1
    const claimed = new Set<number>()
    const drawn = new Set<string>()
    for (const entry of entries.values()) {
      if (entry.kind === "ring") drawn.add(entry.source)
      for (const piece of entry.pieces) claimed.add(piece.marker.line)
    }
    let candidates = 0
    for (let y = a; y <= b && candidates < budget; y += 1) {
      stats.rowsScanned += 1
      if (claimed.has(y)) continue
      const line = buf.getLine(y)
      // The cheap test first: a row with no "<" starts neither a tag nor a block.
      const text = line?.translateToString(true)
      if (!text || !text.includes("<") || !couldStart(text)) continue
      candidates += 1
      const hit =
        (content.rings.size > 0 ? findRing(y) : undefined) ??
        (content.deliveries.length > 0 ? findBlock(y) : undefined)
      if (!hit || entries.has(hit.key) || hit.rows.length === 0) continue
      if (hit.rows.some((row) => claimed.has(row.y))) continue
      // One row per ring: a later copy is somebody's quotation.
      if (hit.kind === "ring" && drawn.has(hit.source)) continue
      if (
        hit.kind === "ring" &&
        inBox(hit.rows[0]!.y, hit.rows.at(-1)!.y, hit.rows[0]!.x, hit.rows[0]!.bg)
      )
        continue
      create(hit)
      if (hit.kind === "ring") drawn.add(hit.source)
      for (const row of hit.rows) claimed.add(row.y)
    }
    stats.scanMs += performance.now() - t0
  }

  const scanViewport = (): void => {
    const buf = buffer()
    scan(buf.viewportY, buf.viewportY + terminal.rows - 1, maxCandidates)
  }

  const scanAll = (): void => scan(0, buffer().length - 1, Infinity)

  const dropAll = (): void => {
    for (const entry of entries.values()) remove(entry)
  }

  // An agent's TUI on the alternate screen (Claude Code's fullscreen mode) scrolls its own history:
  // any write may bring back the row of a ring long gone from the screen, so every write looks.
  const ownScroll = (): boolean => buffer().type === "alternate" && options.alternate?.() === true
  const armed = (): boolean => now() < armedUntil || now() < hotUntil || forceScan || ownScroll()

  const subscriptions: IDisposable[] = [
    terminal.onWriteParsed(() => {
      // A synchronized update (DECSET 2026, which Codex wraps each redraw in) isn't painted until
      // it ends: what is half-drawn now is never seen, so the drawing stays until the end.
      if (terminal.modes.synchronizedOutputMode) return
      verify()
      if (!armed()) return
      scanViewport()
      forceScan = false
    }),
    terminal.buffer.onBufferChange(() => {
      dropAll()
      forceScan = true
      // Back from the alternate screen, the history it covered is as it was: find its rows again.
      scanAll()
    }),
    // Where a cell's size changed (a font, a zoom), the alternate screen's own elements follow.
    terminal.onRender(() => {
      placeOpened()
      if (buffer().type !== "alternate") return
      for (const entry of entries.values())
        for (const piece of entry.pieces) {
          place(piece)
          if (piece.alt) paint(piece.alt, piece)
        }
    }),
    terminal.onResize(() => {
      // A resize rewraps what it can and the harness redraws the rest: look at everything again.
      dropAll()
      scanAll()
      forceScan = true
    }),
    // A key typed closes the opened drawing: the person is back at the box.
    terminal.onKey(() => close()),
    terminal.onScroll(() => placeOpened()),
    terminal.onSelectionChange(() => {
      const position = terminal.getSelectionPosition()
      selection = position
        ? { start: [position.start.x, position.start.y], end: [position.end.x, position.end.y] }
        : undefined
      doorbell.refresh()
    }),
  ]

  bind()

  const doorbell: Doorbell = {
    setContent: (next) => {
      content = next
      byId = new Map()
      for (const delivery of next.deliveries)
        for (const id of delivery.ids) byId.set(id, [...(byId.get(id) ?? []), delivery])
      for (const entry of entries.values())
        if (!(entry.kind === "ring" ? next.rings.has(entry.source) : byId.has(entry.source)))
          remove(entry)
    },
    arm: () => {
      armedUntil = now() + recentMs
      scanViewport()
    },
    rescan: scanAll,
    refresh: () => {
      for (const entry of entries.values())
        for (const piece of entry.pieces) {
          place(piece)
          const element = piece.alt ?? piece.decoration?.element
          if (element) paint(element, piece)
        }
      paintOpened()
    },
    drawn: () => entries.size,
    openAt,
    close,
    opened: () => opened?.lines.map((runs) => runs.map((run) => run.text).join("")),
    audit: () =>
      [...entries.values()].map((entry) => ({
        key: entry.key,
        opens: entry.opens,
        pieces: entry.pieces.map((piece) => ({
          row: piece.marker.line,
          x: piece.x,
          width: piece.width,
          text:
            buffer()
              .getLine(piece.marker.line)
              ?.translateToString(false, piece.x, piece.x + piece.width) ?? "",
          sig: piece.sig,
          says: piece.runs
            ? " ".repeat(piece.pad) + piece.runs.map((run) => run.text).join("")
            : "",
        })),
      })),
    stats,
    dispose: () => {
      subscriptions.forEach((subscription) => subscription.dispose())
      dropAll()
      close()
      bound?.removeEventListener("click", onClick)
      bound?.removeEventListener("mousemove", onMove)
      bound?.removeEventListener("mouseleave", onLeave)
      onLeave()
    },
  }
  return doorbell
}
