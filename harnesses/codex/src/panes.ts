import type { ScreenText } from "@novadeck/emulator/headless"
import { cells } from "@novadeck/emulator/width"

const divider = "│"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The cells of `row` from column `from` up to `to`, each character as wide as it is drawn. */
const cellSlice = (row: string, from: number, to: number): string => {
  let at = 0
  let out = ""
  for (const { segment } of graphemes.segment(row)) {
    if (at >= to) break
    if (at >= from) out += segment
    at += cells(segment)
  }
  return out
}

/** The columns at which `row` draws the divider. */
const dividersOf = (row: string): number[] => {
  const found: number[] = []
  let at = 0
  for (const { segment } of graphemes.segment(row)) {
    if (segment === divider) found.push(at)
    at += cells(segment)
  }
  return found
}

/**
 * The column every row draws the divider at, the first where several do. Most screens have
 * none, told without segmenting a row: the first row lacks the divider, or a row does.
 */
const splitAt = (rows: readonly string[]): number | undefined => {
  if (rows.length === 0 || !rows.every((row) => row.includes(divider))) return undefined
  let shared = dividersOf(rows[0]!)
  for (const row of rows.slice(1)) {
    if (shared.length === 0) return undefined
    const own = dividersOf(row)
    shared = shared.filter((column) => own.includes(column))
  }
  return shared[0]
}

/** What one pane of a split screen shows, and whether it is the sidebar's. */
export type Pane = { readonly screen: ScreenText; readonly sidebar: boolean }

/**
 * The pane holding the cursor. From 0.171.0 Codex draws its workspace sidebar on a screen of
 * 100 columns or more: a `/side` conversation, a subagent's transcript or a preview, to the right
 * of the main conversation, a divider `│` on every row between them, the cursor in the box of the
 * one in focus (Ctrl-/ moves it). Narrower, the side conversation takes the whole screen, as
 * before (probed 0.170.0 and 0.171.0, 2026-11-20, fixtures/side.probe.json). Read as a screen of
 * its own, that pane's rows hold nothing of the other's; a screen with no divider down every
 * row is one pane, as it is.
 */
export const paneOf = (screen: ScreenText): Pane => {
  // One look at a screen asks several times (its overlay, its box, its width).
  const known = panes.get(screen)
  if (known) return known
  const pane = split(screen)
  panes.set(screen, pane)
  return pane
}

const panes = new WeakMap<ScreenText, Pane>()

const split = (screen: ScreenText): Pane => {
  const at = splitAt(screen.rows)
  if (at === undefined) return { screen, sidebar: false }
  const sidebar = screen.cursor.column > at
  const [from, to] = sidebar ? [at + 1, screen.columns] : [0, at]
  const crop = (rows: readonly string[]) => rows.map((row) => cellSlice(row, from, to))
  // Without the rows' wrapping, which the terminal's columns told, not the pane's.
  return {
    screen: {
      bracketedPaste: screen.bracketedPaste,
      alternate: screen.alternate,
      rows: crop(screen.rows),
      bright: crop(screen.bright),
      columns: to - from,
      cursor: { row: screen.cursor.row, column: screen.cursor.column - from },
    },
    sidebar,
  }
}

/**
 * The root's pane of `rows`, the left of a split screen, where Codex draws the root's dialogs;
 * the rows as they are where nothing is split. Its dialogs are read only there, for every row
 * of a split screen goes on past the divider into the sidebar (fixtures/side-dialog.probe.json).
 */
export const rootRows = (rows: readonly string[]): readonly string[] => {
  const at = splitAt(rows)
  return at === undefined ? rows : rows.map((row) => cellSlice(row, 0, at))
}

/**
 * What a side conversation shown over the whole screen says in its footer when the root waits
 * on the person: "Side from main thread · main needs approval · ^/ to switch · ^c to archive"
 * (0.170.0 and 0.171.0, probed 2026-11-20, fixtures/side-dialog.probe.json; "main needs input"
 * for a question, from its source).
 */
const rootWaits =
  /Side from main thread · (?:[^·]+ · )*main needs \w+ · (?:ctrl\+|\^|⌃)\/ to switch/

/** The marker that leads Codex's composer row, and each prompt it echoes. */
const marker = "›"

/**
 * The hint the pane in focus draws at the foot of its footer while its composer is empty: "←
 * for agents · ? for shortcuts", "· ^/ for side" after it on the root's beside a kept side
 * conversation. The other pane draws none (probed 0.171.0 on Linux, 2026-11-20,
 * fixtures/side.probe.json and side-dialog.probe.json; and on Windows, the screens of #1123's CI
 * runs), nor does a pane whose dialog is up.
 */
const focusHint = /← for agents/

/** Whether the rows of the pane from column `from` to `to` draw the focus hint. */
const hinted = (rows: readonly string[], from: number, to: number): boolean =>
  rows.some((row) => focusHint.test(cellSlice(row, from, to)))

/**
 * The keys of Ctrl-/, which moves the focus between the root and a side conversation: Codex
 * binds Ctrl-/ and Ctrl-7 to it (`toggle_side_conversation`, `tui/src/keymap.rs`, 0.171.0). A
 * terminal sends either as 0x1F, which Codex reads as Ctrl-7 on Linux and macOS. On Windows
 * ConPTY makes that byte a key event of its own (`VkKeyScan`: the `-` key with Ctrl and Shift on
 * a US layout), which Codex reads as neither (crossterm's `parse_key_event_record` takes a
 * control character's key from its virtual key), so it never switched there (#1123's Windows
 * runs). There the keys are a win32-input-mode record, which ConPTY passes on as the key event
 * it describes: the `7` key (`VK_7`, scan code 8) with Ctrl, down and up, read as Ctrl-7 on any
 * layout whose `7` key types a 7.
 */
export const sideToggle = (platform: NodeJS.Platform = process.platform): string =>
  platform === "win32" ? `${win32Key(true)}${win32Key(false)}` : "\x1f"

/** A win32-input-mode record (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`) of the `7` key with left Ctrl. */
const win32Key = (down: boolean): string => `\x1b[55;8;0;${down ? 1 : 0};8;1_`

/**
 * Whether a side conversation has the focus, so the root's dialog is held out of view: in the
 * sidebar, where the root's pane goes on showing what it did before its dialog came and nothing
 * says one waits; or over the whole screen, saying the root waits in its footer. Ctrl-/ moves the
 * focus to the root, which shows its dialog, and does nothing while one shows there (probed
 * 0.170.0 and 0.171.0, 2026-11-20, fixtures/side-dialog.probe.json).
 *
 * The sidebar has the focus where it draws the focus hint and the root's pane doesn't, or where
 * the cursor is in its composer: right of the divider, on the last of its rows that starts with
 * `›`, past the marker (a draft there takes the hint away). A cursor merely right of the divider
 * says nothing: Codex hides it while the root's dialog is up and leaves it after the last cell it
 * drew, on the sidebar's "Working" row while the side's turn runs (`sideBusyFrames`).
 */
export const sideFocused = (
  rows: readonly string[],
  cursor: { readonly row: number; readonly column: number } | undefined,
): boolean => {
  const at = splitAt(rows)
  if (at === undefined)
    return rows
      .filter((row) => row.trim() !== "")
      .slice(-3)
      .some((row) => rootWaits.test(row))
  // The hint, where the sidebar draws it and the root's pane doesn't, needs no cursor.
  if (hinted(rows, at + 1, Infinity) && !hinted(rows, 0, at)) return true
  if (cursor === undefined || cursor.column <= at + 1) return false
  const composer = rows.findLastIndex((row) => cellSlice(row, at + 1, Infinity).startsWith(marker))
  return composer === cursor.row
}
