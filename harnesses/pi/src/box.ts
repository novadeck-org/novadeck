import type { ScreenText } from "@novadeck/emulator/headless"
import type { SliceProfile } from "@novadeck/harness-core/slices"
import {
  compact,
  imageCount,
  isEmpty,
  rule,
  type BoxProfile,
  type InputBox,
  type ProfileImages,
} from "@novadeck/tui-input/box"

import { signedOut } from "./startup.js"

/**
 * pi's input box (probed 2026-11-24, 1.6.0, 120x40, 60x20 and 80x12; fixtures/input-box.probe.json
 * and busy.probe.json). It runs fullscreen on the alternate screen (since 1.0.0), and its box is
 * the text between two full-width rules from the first column, with its footer under them (the
 * folder, `• <session name>` once named, then usage and `<model> • <thinking>`, and a third row
 * where an extension sets a status):
 *
 *     ──────────────────────────────   (top rule)
 *     hello there                      (the text from the first column: no marker, no indent)
 *     ──────────────────────────────   (bottom rule)
 *     ~/project
 *     0.0%/200k (auto)          fake-sonnet • medium
 *
 * An empty box is one blank row, with no placeholder. Lines and wrapped rows grow it upwards.
 * While a turn runs, the top rule carries a spinner and a word: `── ⠼ Working ───`, or
 * `── ⠇ Retrying (1/3) in 1s... (escape to cancel) ───` while a provider error is retried. A
 * draft taller than the box shows says so in its rules, as Claude Code's does: `─── ↑ 28 more
 * ───` over it, `─── ↓ 28 more ───` under it (the shared `rule` reads both). The `/` menu is
 * drawn under the bottom rule, between it and the footer, so the box is found by its rules, not
 * by its footer. Every dialog pi draws (an extension's select, confirm, input or editor, the
 * trust prompt, `/login`, its pickers) takes the box's place between the same rules, with a
 * line of key hints, which tells it apart: no box shows then.
 */

/** A box's top rule while a turn runs: a spinner (a braille cell) and what it does. */
const workingRule = /^── [⠀-⣿] (?<words>\S.*?) ─{3,}\s*$/u

/**
 * Whether a row is a rule of the box's frame: from the first column to the last of a screen
 * `width` wide, plain, scrolled or working. The box's own text never reaches the last column (a
 * word reaches `columns - 1`), so a row of `─` typed or pasted in it, wrapped at its end, is no
 * rule (an Inbox reply with a line of `─` in it, e2e inbox.e2e.ts).
 */
const frame = (row: string | undefined, width: number): boolean =>
  row !== undefined &&
  row.startsWith("─") &&
  row.trimEnd().length >= width &&
  (rule(row) || workingRule.test(row))

/** The screen's width, as its widest row shows it, for rows read with nothing else: a rule spans it. */
const widest = (rows: readonly string[]): number =>
  rows.reduce((most, row) => Math.max(most, row.trimEnd().length), 0)

/**
 * The key hints a dialog in the box's place ends with (probed 2026-11-24, 1.6.0,
 * fixtures/dialogs.probe.json): its selects and confirms (`select`, `confirm`, `trust`,
 * `login`), its text fields (`input`, `editor`), the model and thinking pickers (whose hint
 * wraps on a narrow screen), `/settings`, the question tool of pi's examples, `/resume` and
 * `/tree`, the count under a searchable list (`/login`'s providers), and any indented row
 * that offers Escape to cancel or close (`/mcp`'s panel; probed in e2e/probes/box-leftover).
 */
const dialogHints = [
  /^\s*↑↓ navigate\s+enter select\s+escape\/ctrl\+c cancel\s*$/,
  /^\s*enter submit\s+escape\/ctrl\+c cancel\s*$/,
  /^\s*enter submit\s+shift\+enter\/ctrl\+j newline\b/,
  /^\s*Enter to select · Ctrl\+S to set as default\b/,
  /^\s*Type to search · Enter\/Space to change · Esc to cancel\s*$/,
  /^\s*↑↓ navigate • Enter to select • Esc to cancel\s*$/,
  /^\s*tab scope · re:<pattern> regex\b/,
  /^\s*↑\/↓ move · ←\/→ page\b/,
  // A searchable list's count, under its rows, where it shows no hints (`/login`'s providers).
  /^\s*\(\d+\/\d+\)\s*$/,
  // Any other panel's hints that offer Escape (`/mcp`'s ` escape/ctrl+c close`): indented, as
  // the box's own text never is, which starts at the first column.
  /^\s+.*\b(?:escape|esc)(?:\/ctrl\+c)? (?:to )?(?:cancel|close)\b/i,
]

/** Whether a row is a dialog's line of key hints (`dialogHints`). */
export const dialogHint = (row: string): boolean => dialogHints.some((hint) => hint.test(row))

/** The transcript's search, drawn over its top right corner: `│ Find in transcript │`. */
const search = /│ Find in transcript\s+│/

type Frame = { readonly top: number; readonly bottom: number }

/** How many rows over the top rule a picker's hints may be (`/tree`: three). */
const hintsOver = 4

/** The rules the box lies between: the lowest frame rule on the screen, and the nearest one above it. */
const rulesOf = (rows: readonly string[], width = widest(rows)): Frame | undefined => {
  const bottom = rows.findLastIndex((row) => frame(row, width))
  if (bottom < 1) return undefined
  const top = rows.slice(0, bottom).findLastIndex((row) => frame(row, width))
  return top < 0 || bottom - top < 2 ? undefined : { top, bottom }
}

/**
 * Whether a dialog stands in the box's place, between its rules: its hints sit inside its frame,
 * under an editor's own rules, or over a picker's list (`/tree` draws its title and hints, then a
 * rule, then the list); never under it, where the `/` menu counts its commands as a list does
 * (`(1/26)`).
 */
const dialogIn = (rows: readonly string[], { top, bottom }: Frame): boolean =>
  rows.slice(Math.max(top - hintsOver, 0), bottom).some(dialogHint)

/** The rules of the box, where a box shows between them and no dialog does. */
const frameOf = (rows: readonly string[], width = widest(rows)): Frame | undefined => {
  const found = rulesOf(rows, width)
  return found && !dialogIn(rows, found) ? found : undefined
}

/** Whether one of pi's dialogs or pickers shows where its box would be. */
export const dialogShown = (rows: readonly string[]): boolean => {
  const trimmed = rows.map((row) => row.trimEnd())
  const found = rulesOf(trimmed)
  return found !== undefined && dialogIn(trimmed, found)
}

/** The folder of one image Novadeck's runner saved: `uploads/<uuid>/`. */
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/**
 * Where Novadeck's runner saves an image it pastes, `<data>/uploads/<uuid>/<name>`, as it pastes
 * the path (`imagePaste`): a Windows path in double quotes where it holds a space or more than
 * plain characters, bare otherwise; elsewhere bare, a backslash before each character a shell
 * would read. pi wraps a path with a space at that space, which it drops: inside the quotes, or after
 * the backslash that escapes it, a line break stands for it.
 */
const upload = new RegExp(
  [
    String.raw`"[^"]*[\\/]uploads[\\/]${uuid}[\\/][^"]+"`,
    String.raw`[A-Za-z]:\\(?:[^\s\\"]+\\)*uploads\\${uuid}\\[^\s\\"]+`,
    String.raw`(?:/(?:\\[\s\S]|[^\s\\/])+)*/uploads/${uuid}/(?:\\[\s\S]|[^\s\\/])+`,
  ].join("|"),
  "g",
)

/**
 * The box's text with each image Novadeck pasted in it shown as `[Image #1]`, `[Image #2]`, …, as
 * other programs show one. pi takes no image in its box: a path pasted there stays text, and the
 * model reads the file itself (probed 2026-11-24, 1.6.0, `pathTyped` and `pathSent` of
 * fixtures/input-box.probe.json). So what stands for an image is its path, as the runner pasted
 * it (`imagePaste`): only a path into Novadeck's uploads folder counts, never one the person
 * typed. pi wraps a path with no space longer than a row at the row's end, so the rows of a line
 * are joined where a row is full (`width` columns) before the paths are looked for; one with a
 * space it wraps there, which `upload` reads across (probed 2026-11-24, 1.6.0: Windows CI's
 * `"C:\Users\runneradmin\AppData\Local\Temp\novadeck e2e-…\shot.png"`, 120 columns with its
 * quotes, broke after `novadeck`).
 */
const withImageMarks = (lines: readonly string[], width: number): string => {
  const joined: string[] = []
  for (const line of lines) {
    const previous = joined.at(-1)
    if (previous !== undefined && previous.length >= width && !/\s$/.test(previous))
      joined[joined.length - 1] = previous + line
    else joined.push(line)
  }
  let count = 0
  const marked = joined.join("\n").replace(upload, () => `[Image #${(count += 1)}]`)
  return count === 0 ? lines.join("\n") : marked
}

/** How many columns of a row pi's box fills with text: all but one, for its cursor. */
const textWidth = (columns: number): number => Math.max(columns - 1, 1)

/** A screen of nothing but rows, for what reads the box from its text alone. */
const textScreen = (rows: readonly string[]): ScreenText => ({
  rows,
  bright: rows,
  columns: widest(rows),
  cursor: { row: 0, column: 0 },
  bracketedPaste: true,
  alternate: true,
})

/** How its box reads off a screen. */
const read = (screen: ScreenText): InputBox | undefined => {
  const rows = screen.rows.map((row) => row.trimEnd())
  const framed = frameOf(rows, screen.columns)
  if (!framed) return undefined
  const { top, bottom } = framed
  if (search.test(screen.rows.join("\n"))) return undefined
  const first = top + 1
  const last = bottom - 1
  const lines = rows.slice(first, last + 1)
  const written = withImageMarks(lines, textWidth(screen.columns)).trimEnd()
  // A leading `!` is its bash mode's marker (`!!` keeps its output from the model): what follows
  // it is the command, as other programs' markers lead their box.
  const shell = written.startsWith("!")
  const text = shell ? written.slice(1) : written
  const hidden = [top, bottom].reduce(
    (sum, at) => sum + Number(/ [↑↓] (\d+) more /.exec(rows[at]!)?.[1] ?? 0),
    0,
  )
  const blanks = compact(text) === "" && last > first
  const shown: InputBox = {
    text,
    mode: shell ? "shell" : "prompt",
    first,
    last,
    ...(hidden > 0 && { scrolled: true }),
    ...(blanks && { blanks: true }),
  }
  if (hidden > 0) outOfSight.set(shown, hidden)
  return shown
}

/** How many rows of the boxes read last are out of sight, as their rules say (`↑ 18 more`). */
const outOfSight = new WeakMap<InputBox, number>()

/**
 * How many rows a scrolled box's rules don't say: a box another reader rebuilt from one of
 * these (its text changed) has lost the count, and pi shows at most 30% of the screen.
 */
const unknownHidden = 400

/**
 * The keys that empty the box, the cursor on any of its rows: Down to its last line, as Down on
 * the last line does nothing (no history browsing over a draft), then, for each line, Ctrl-E to
 * its end and Ctrl-U twice, as Ctrl-U takes a line to its start and, on an empty line, the break
 * before it. Rows out of sight count too (probed 2026-11-24, 1.6.0: three lines with the cursor at
 * the end, in the middle of the first line or of the last, a paste placeholder among words, a
 * line wrapped over three rows, and 30 lines scrolled `↓ 18 more` all emptied; backups rig
 * `erase.mjs`). Ctrl-U leaves a menu the draft held open (`/he`) over the emptied box, where a
 * later Enter would pick from it, so a space and a Backspace close it (probed 2026-11-24, 1.6.0:
 * `/he`, `try /mod`, `!ls` and a `/th` under a line all emptied with no menu left; rig
 * `erase-menu.mjs`). Never Ctrl-C: it clears the box too, but two within about a second end pi, a
 * draft or not (`draftCleared`, `emptyOnce` of fixtures/input-box.probe.json), and a later clear
 * of Novadeck's could come that soon.
 */
const erase = (box: InputBox): string => {
  const hidden = box.scrolled ? (outOfSight.get(box) ?? unknownHidden) : 0
  const lines = box.last - box.first + 1 + hidden
  return `${"\x1b[B".repeat(lines - 1)}${"\x05\x15\x15".repeat(lines)} \x7f`
}

/**
 * The images it shows in its box: each one Novadeck pasted, as a path into its uploads folder
 * (`withImageMarks`). Enter sends a path alone as a prompt (it is text), and the box's keys take
 * them out with the rest.
 */
const images: ProfileImages = {
  attached: (screen) => imageCount(read(screen)?.text ?? ""),
  alone: true,
  // Two paths pasted one after the other would read as one word: a space keeps them apart.
  after: " ",
  discard: (screen) => {
    const box = read(screen)
    return box && erase(box)
  },
}

/**
 * Whether messages wait behind the turn: rows over the box, dim, `Steering: <text>` for one sent
 * with Enter while the turn runs, which pi gives the model at its next call, and `Follow-up:
 * <text>` for one sent with Alt+Enter, given once the turn ends, then `↳ Alt+Up to edit all
 * queued messages` (probed 2026-11-24, 1.6.0, `steerQueued`, `followQueued` of
 * fixtures/busy.probe.json).
 */
const queued = (screen: ScreenText): boolean => {
  const rows = screen.rows.map((row) => row.trimEnd())
  const found = frameOf(rows)
  const above = rows.slice(0, found?.top ?? rows.length)
  const at = above.findLastIndex((row) => row.trim() !== "")
  return at >= 0 && /^\s*↳ .* to edit all queued messages$/.test(above[at]!)
}

/**
 * Whether the row over the box says Escape stopped the turn: `Operation aborted`, in the
 * transcript, under which pi may say it put queued messages back in the box (`Restored 2 queued
 * messages to editor`) (probed 2026-11-24, 1.6.0, `escaped`, `escapedWithQueue` of
 * fixtures/busy.probe.json).
 */
const interrupted = (screen: ScreenText): boolean | undefined => {
  const rows = screen.rows.map((row) => row.trimEnd())
  const found = frameOf(rows)
  if (!found) return undefined
  const above = rows
    .slice(0, found.top)
    .filter((row) => row.trim() !== "" && !/^\s*Restored \d+ queued messages? to editor$/.test(row))
  return above.at(-1)?.trim() === "Operation aborted"
}

/**
 * Whether a view of pi's stands over its box: the transcript's search (Ctrl+Shift+F), drawn at
 * the top right, whose field takes the keys while the box still shows (`searchCsiU120x40` of
 * fixtures/input-box.probe.json); or a dialog in the box's place.
 */
const overlay = (screen: ScreenText): boolean =>
  screen.rows.some((row) => search.test(row)) || dialogShown(screen.rows)

/** A paste of more than 10 lines or 1000 characters shows as `[paste #1 +40 lines]` or `[paste #2 1234 chars]`. */
const pasteMark = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/

/**
 * pi's input box: see the top of this file. A paste of more than 10 lines or 1000 characters
 * shows as a placeholder (pi-tui's editor, 1.6.0: `[paste #1 +40 lines]`, `[paste #2 1234
 * chars]`), and Enter sends what it stands for; a smaller one shows whole, its line breaks kept
 * (`pasteMulti`, `pasteLong`, `pasteLongSent` of fixtures/input-box.probe.json).
 */
export const box: BoxProfile = {
  read,
  images,
  // `!` in the box runs it in bash (Git Bash on Windows), `!!` too, without sending what it
  // printed to the model. Its lines run as written, a placeholder's text in full (`bangTwoLines`
  // of fixtures/input-box.probe.json). There is a session from the start, so a command starts
  // none, and one given mid-turn runs at once (`bangMidTurn` of fixtures/bash.probe.json). Its
  // footer says nothing of the mode, which only the `!` and the rule's colour mark: the box's text
  // read off the rows alone tells it.
  shell: {
    expands: true,
    starts: false,
    footer: (rows) => read(textScreen(rows))?.mode === "shell",
    leave: erase,
    midTurn: "runs",
  },
  textWidth,
  stands: (text) => pasteMark.test(text) || imageCount(text) > 0,
  collapsed: ({ text }) => new RegExp(`^${pasteMark.source}$`).test(text.trim()),
  // What pi puts back after an Escape (the messages queued behind the turn) goes as a draft does.
  clear: erase,
  erase,
  // A prompt sent while a turn runs shows as `Steering:` only once a person's extensions are
  // through with it (their `input` handlers), which may take a while, and runs as a turn of its
  // own if Escape comes first; Novadeck's extension then hands it back to the box. Until then the
  // screen shows nothing queued, so the host's account of it counts (probed 2026-11-24, 1.6.0, a
  // 1.3 s handler; rig `slow-queue.mjs`).
  unseenQueue: true,
  // A paste over a draft keeps its line breaks, a placeholder's in what it stands for
  // (`pasteOverDraft120x40`, `bigPasteOverDraft120x40` of fixtures/input-box.probe.json).
  interrupted,
  overlay,
  queued,
  collapses: (text) => {
    const normal = text.replaceAll(/\r\n?/g, "\n")
    return normal.split("\n").length > 10 || normal.length > 1000
  },
  // It shows at most 30% of the screen's rows of its text, and at least 5, with the rest out of
  // sight behind `↑ N more` (pi-tui's editor, 1.6.0: `Math.max(5, Math.floor(rows * 0.3))`;
  // probed 5, 6, 7, 9, 12 and 15 rows on 12, 20, 24, 30, 40 and 50, `tall*` of
  // fixtures/input-box.probe.json). Its rules, the footer and a row over it stay.
  room: (rows) => Math.max(5, Math.floor(rows * 0.3)),
  viewport: (rows) => Math.max(5, Math.floor(rows * 0.3)),
}

/** Whether the box reads empty: no draft for a delivery to wait on. */
export const emptyBox = (screen: ScreenText): boolean => {
  const found = read(screen)
  return found !== undefined && isEmpty(found)
}

/** A dialog's title that asks for a secret: an API key, a token, a password. */
const secretTitle = /^\s*.*\b(?:API key|token|secret|password)\b.*$/i

/**
 * Where it draws its own: the `/` and `@` menus under the box, over the footer
 * (`slash` of fixtures/input-box.probe.json); its dialogs and pickers in the box's place. `/login`
 * asks for an API key in an input field (`> `, then `enter submit  escape/ctrl+c cancel`).
 */
export const slice: SliceProfile = {
  agent: "pi",
  side: () => "below",
  // With no provider it can reach, its footer names no model: a prompt there fails, so the box
  // waiting empty is no idle (see `signedOut`).
  notice: signedOut,
  secret: (rows) =>
    rows.some((row) => secretTitle.test(row)) &&
    rows.some((row) => /^\s*enter submit\s+escape\/ctrl\+c cancel\s*$/.test(row)),
}
