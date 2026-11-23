import { existsSync } from "node:fs"
import { posix, win32 } from "node:path"

import type { ScreenText } from "@novadeck/emulator/headless"
import { cmdJoined } from "@novadeck/harness-core/cmd-lines"
import type { SliceProfile } from "@novadeck/harness-core/slices"
import {
  compact,
  isEmpty,
  pause,
  type BoxProfile,
  type InputBox,
  type ProfileImages,
} from "@novadeck/tui-input/box"

/**
 * opencode's input box (probed 2026-11-22, 1.19.6, 120x40 and 60x20; fixtures/input-box.probe.json).
 * It has no rules: a left gutter of `┃` rows, a closing edge `╹▀▀▀…` under them, and nothing
 * else marks it. From the top: a bare `┃` row, the text rows (`┃  text`), a bare `┃` row,
 * the footer (`┃  Build · Fake Sonnet Fake`: agent, model, provider; `┃  Shell` in its shell
 * mode), the edge. On its home screen, before any session, the box is centred (its gutter in a
 * column of its own), in a session it starts at column 2; the rows below the edge are its
 * status row (`■■■⬝⬝  esc interrupt` while a turn runs, the path and hints otherwise).
 * The history above echoes the person's turns in the same gutter, with no edge, and its menus
 * draw their rows right above the box, in the same gutter and closed with another `┃` at
 * their right end, so the box is read upwards from its edge and stops at a menu row.
 */

const edge = /^ *╹▀+(?: |$)/

/**
 * The rows cut at the box's right end, where its edge ends: on a wide screen a session draws its
 * sidebar (its context, MCP servers, LSPs and folder) right of the box and the history, on the
 * same rows (CI's Windows runners, 2026-11-23, 1.19.6, at 170x30: `┃` then the folder at column
 * 131 on the box's bare row).
 */
const clipped = (rows: readonly string[]): readonly string[] => {
  const at = rows.findLastIndex((row) => edge.test(row))
  if (at < 0) return rows
  const end = rows[at]!.lastIndexOf("▀") + 1
  return rows.map((row) => row.slice(0, end))
}

/** The gutter, and the two spaces before the text of a row of the box. */
const gutter = "┃"
const indent = `${gutter}  `

/** A row of a menu open above the box: `┃ /compact   Compact session   ┃`, one space after its gutter. */
const menuRow = (row: string | undefined): boolean => /^ *┃ \S.*┃ *$/.test(row ?? "")

/**
 * What its empty box shows on the home screen: `Ask anything… "Fix broken tests"`, and in its
 * shell mode `Run a command… "pwd"`, drawn in grey, not dim, so the bright cells keep it
 * (probed 2026-11-22, 1.19.6): the cursor at the text's start says it is the placeholder, not
 * a draft that says the same words. On a narrow screen it wraps over rows, read joined by spaces
 * (probed 2026-11-22, 1.19.6, 52 columns: `Ask anything… "What is the tech stack of` and
 * `this project?"`), and for a frame after the first draws only its first row (a read of the e2e
 * run's 52 columns: `Ask anything… "What is the` alone, the cursor at home), so only its opening
 * is matched.
 */
const placeholder = /^(?:Ask anything|Run a command)… "/

type Frame = {
  /** The column its gutter is in. */
  readonly column: number
  /** The screen rows: the bare row on top, the text's first and last, the footer, the edge. */
  readonly top: number
  readonly first: number
  readonly last: number
  readonly footer: number
  readonly edge: number
}

/** Where the box is on `rows`, from its edge upwards; undefined where there is none or the rows aren't a box's. */
const frameOf = (drawn: readonly string[]): Frame | undefined => {
  const rows = clipped(drawn)
  const at = rows.findLastIndex((row) => edge.test(row))
  if (at < 4) return undefined
  const column = rows[at]!.indexOf("╹")
  const led = (row: string | undefined): boolean =>
    row !== undefined && row.startsWith(gutter, column) && row.slice(0, column).trim() === ""
  let top = at
  while (top > 0 && led(rows[top - 1]) && !menuRow(rows[top - 1])) top -= 1
  // A bare row, one or more of text, a bare row and the footer.
  if (at - top < 4 || rows[top]!.trim() !== gutter || rows[at - 2]!.trim() !== gutter)
    return undefined
  if (!rows[at - 1]!.startsWith(indent, column) || rows[at - 1]!.trim() === gutter) return undefined
  return { column, top, first: top + 1, last: at - 3, footer: at - 1, edge: at }
}

/**
 * Whether its footer says the box is in its shell mode (`!` typed in an empty box), where Enter
 * runs what it holds as a command: the row above the edge is `┃  Shell`, and a hint under it says
 * `esc exit shell mode` (probed 2026-11-22, 1.19.6, fixtures/input-box.probe.json).
 */
export const shellFooter = (rows: readonly string[]): boolean => {
  const found = frameOf(rows)
  return found !== undefined && /^┃\s+Shell$/.test(clipped(rows)[found.footer]!.trim())
}

/** The text of the box's rows, one line each, or undefined where a row isn't one of the box's. */
const linesOf = (drawn: readonly string[], found: Frame): string[] | undefined => {
  const lit = clipped(drawn)
  const lines: string[] = []
  for (let at = found.first; at <= found.last; at += 1) {
    const row = lit[at] ?? ""
    if (row.trim() === gutter || row.trim() === "") lines.push("")
    else if (row.startsWith(indent, found.column))
      lines.push(row.slice(found.column + indent.length).trimEnd())
    else return undefined
  }
  return lines
}

/** How its box reads off a screen. */
const read = (screen: ScreenText): InputBox | undefined => {
  const found = frameOf(screen.rows)
  if (!found) return undefined
  const shown = linesOf(screen.rows, found)
  const lit = linesOf(screen.bright, found)
  if (!shown || !lit) return undefined
  const mode = shellFooter(screen.rows) ? "shell" : "prompt"
  const { cursor } = screen
  const home = cursor.row === found.first && cursor.column <= found.column + indent.length
  const text = placeholder.test(shown.join(" ")) && home ? "" : lit.join("\n").trimEnd()
  const blanks = compact(text) === "" && found.last > found.first
  return {
    text,
    mode,
    first: found.first,
    last: found.last,
    ...(blanks && { blanks }),
  }
}

/**
 * A title row of one of its dialogs drawn over everything (the command palette Ctrl-P, the
 * session list, the model and agent pickers, `/connect`, `/status`, the help): the title, then
 * `esc` at the right edge (`esc/enter` on the help). On a tall screen the box still shows under
 * it, empty, with nothing else to say the dialog's search field has the keys instead; on a short
 * one the dialog covers it (probed 2026-11-22, 1.19.6, `models`, `help` and `palette` of
 * fixtures/input-box.probe.json, and their 60x20 states).
 */
export const modalTitle = /^ {2,}[A-Z][A-Za-z0-9 ]*[A-Za-z0-9] {3,}esc(?:\/enter)?\s*$/

/**
 * Whether the screen shows one of its dialogs over its conversation. A menu open over a draft
 * is no overlay: a `/` draft reads as a command, which the callers wait on, and an `@` one as
 * text, as on Claude Code and Codex, though Enter would pick the menu's row (the `@` menu's
 * rows are drawn right over the box's bare top row, `┃ @general   ┃`).
 */
const overlay = (screen: ScreenText): boolean => screen.rows.some((row) => modalTitle.test(row))

/**
 * The keys that empty a box that holds text: Ctrl-C (probed 2026-11-22, 1.19.6: it cleared a
 * draft of two logical lines, one wrapped over two rows, a pasted placeholder and an image at once,
 * where Ctrl-U took only a row's end: a wrapped line's second row stayed after Ctrl-U, Backspace,
 * Ctrl-U). On an empty box a first Ctrl-C only warns and a second ends opencode, so it goes over
 * text seen there only, once.
 */
const emptyBox = (): string => "\x03"

/**
 * How many images it shows attached: each is `[Image 1]` in the box's text, at the place it
 * was pasted, as a path to an image file pasted alone becomes (probed 2026-11-22, 1.19.6; a path
 * to a file that isn't there stays text). Enter sends a prompt of images alone, and Ctrl-U takes
 * a row's, chips and all, so erasing the rows empties it. A row may end between its two words,
 * as Claude Code's box wraps its own (`imageMark`).
 */
const images: ProfileImages = {
  attached: (screen) => read(screen)?.text.match(/\[Image\s+\d+\]/g)?.length ?? 0,
  alone: true,
  discard: (screen) => {
    const box = read(screen)
    return box && emptyBox()
  },
}

/** The kinds of shell opencode's shell mode may run a command in, as its command is written for. */
type ShellKind = "sh" | "powershell" | "cmd" | "other"

// Whether `name` is a program on the PATH of `env`, as `which` finds one (`.exe` on Windows).
const onPath = (
  name: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | undefined => {
  const rules = platform === "win32" ? win32 : posix
  const file = platform === "win32" ? `${name}.exe` : name
  return (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter((folder) => folder !== "")
    .map((folder) => rules.join(folder, file))
    .find(exists)
}

/**
 * The shell opencode's shell mode runs in, as it picks one (core/src/shell.ts `preferred`, 1.19.6):
 * `$SHELL` where it names one that is there, else on Windows pwsh, then powershell, on the PATH,
 * then Git Bash (beside a `git` on the PATH), then cmd; elsewhere bash or sh (zsh on macOS). Its
 * `fish` and `nu` take no command of several lines as Novadeck writes one (probed on CI's
 * Windows runners, 2026-11-23: a sandbox PATH with no PowerShell gave opencode cmd).
 */
export const shellKindOf = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): ShellKind => {
  const named = env.SHELL
  const found =
    named === undefined || named === ""
      ? undefined
      : /[\\/]/.test(named)
        ? exists(named) || (platform === "win32" && exists(`${named}.exe`))
          ? named
          : undefined
        : (onPath(named, platform, env, exists) ?? (platform === "win32" ? undefined : named))
  if (found !== undefined) {
    const name = (platform === "win32" ? win32 : posix).parse(found).name.toLowerCase()
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(name)) return "sh"
    if (name === "pwsh" || name === "powershell") return "powershell"
    if (name === "cmd") return "cmd"
    return "other"
  }
  if (platform !== "win32") return "sh"
  if (onPath("pwsh", platform, env, exists) || onPath("powershell", platform, env, exists))
    return "powershell"
  const git = onPath("git", platform, env, exists)
  if (git && exists(win32.join(git, "..", "..", "bin", "bash.exe"))) return "sh"
  return "cmd"
}

/**
 * A shell command as its shell mode takes it. Its mode turns each line break of a command into a
 * literal `\n`, and a backslash may be dropped on the way (probed 2026-11-22, 1.19.6: `touch f1.txt`
 * and `touch f2.txt` on two lines made a file `f1.txtntouch`; the same lines inside `printf '%b'`
 * as `\n` did too), so a command of several lines goes as one line with no backslash in it: its
 * text in base64, which the shell decodes and runs whole, in its own language (`shellKindOf`):
 * `eval "$(printf %s '<base64>' | base64 -d)"` for sh and its kin, `Invoke-Expression` of the
 * decoded text for PowerShell, cmd's own joining (`cmdJoined`) for cmd, and none for any other.
 */
export const shellCommandOf = (
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined => {
  const lines = command.replaceAll("\r\n", "\n").replace(/\n+$/, "").split("\n")
  if (lines.length < 2) return command.trim()
  const encoded = Buffer.from(lines.join("\n")).toString("base64")
  const kind = shellKindOf(platform, env, exists)
  if (kind === "powershell")
    return `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`
  if (kind === "sh") return `eval "$(printf %s '${encoded}' | base64 -d)"`
  if (kind === "cmd") return cmdJoined(command)
  return undefined
}

/**
 * Opencode's input box: see `frameOf`. A paste of three lines or more, or of more than 150
 * characters, shows as `[Pasted ~3 lines]` (`~1 lines` for a long line), and 150 characters or two
 * lines show whole; Enter sends what it stands for (probed 2026-11-22, 1.19.6).
 */
export const box: BoxProfile = {
  read,
  images,
  // A command shown as a placeholder runs as the text it stands for (`!` and three pasted
  // lines, Enter: the three lines were the command). A first command on its home screen
  // opens a session (`starts`). One typed while a turn runs is dropped: the box empties and it
  // never runs nor queues (probed 2026-11-22, 1.19.6, `shellMid` of fixtures/input-box.probe.json);
  // Backspace in the empty box leaves the mode.
  shell: {
    expands: true,
    starts: true,
    footer: shellFooter,
    command: (command, platform, env) => shellCommandOf(command, platform, env),
    // A Backspace in the empty box leaves the mode; a command goes with Ctrl-C first.
    leave: (held) => (isEmpty(held) ? "\x7f" : `\x03${pause}\x7f`),
    midTurn: "drops",
  },
  // In a session a word reaches `columns - 9`; the centred box of its home screen holds 70.
  textWidth: (columns) => Math.min(columns - 9, 70),
  stands: (text) => /\[(?:Pasted ~\d+ lines?|Image \d+)\]/.test(text),
  collapsed: ({ text }) => /^\[Pasted ~\d+ lines?\]$/.test(text.trim()),
  // Ctrl-U takes the whole line the cursor is on, a wrapped one too, and Backspace joins
  // the line before it (probed 2026-11-22, 1.19.6, `typed3` states).
  clear: emptyBox,
  erase: emptyBox,
  // A text pasted over a draft keeps its blank line only as a paste of its own: a collapsed paste
  // drops the breaks leading it (probed 2026-11-22, 1.19.6: `Before it[Pasted ~4 lines]`).
  breakApart: true,
  overlay,
  // Keys typed in the first moments after Enter are lost (probed 2026-11-22, 1.19.6, in the e2e
  // sandbox: 14 keys typed as its prompt hook began never showed, those 311 ms on did): the prompt
  // is taken once its history shows one more row of its first line than before the paste (a
  // prompt sent twice has two), or, where that line wraps or is cut short on a narrow screen, one
  // more row of any prompt, with the assistant's row or the QUEUED badge after it.
  echoed: (screen, text, before) => {
    const first = text.split("\n")[0]!.trim().slice(0, 30)
    if (first === "") return true
    const prompts = (drawn: ScreenText | undefined) => {
      const rows = clipped(drawn?.rows ?? [])
      const found = drawn ? frameOf(rows) : undefined
      const above = found ? rows.slice(0, found.top) : rows
      const sent = above.flatMap((row, at) => (/^ *┃  \S/.test(row) ? [at] : []))
      const echoes = sent.filter((at) => above[at]!.trim().startsWith(`${gutter}  ${first}`))
      const taken = (at: number | undefined) =>
        at !== undefined && above.slice(at + 1).some((row) => /▣ |^ *┃\s+QUEUED\s*$/.test(row))
      return { sent: sent.length, echoes: echoes.length, taken: taken(sent.at(-1)) }
    }
    const now = prompts(screen)
    const was = prompts(before)
    return (now.echoes > was.echoes || now.sent > was.sent) && now.taken
  },
  // A first Escape arms the interrupt, the row under the box saying `esc again to interrupt`
  // for about 5 s, and only a second stops the turn (probed 2026-11-22, 1.19.6, `busyEsc1` of
  // fixtures/input-box.probe.json; the arm lapsed after 5 s with no second Escape).
  armed: (screen) => screen.rows.some((row) => /^ *[■⬝]+ +esc again to interrupt\b/.test(row)),
  // Its status row says a turn runs (`■■⬝⬝  esc interrupt`), or runs and is armed.
  working: (screen) =>
    screen.rows.some((row) => /^ *[■⬝]+ +esc (?:again to )?interrupt\b/.test(row)),
  queued: (screen) => clipped(screen.rows).some((row) => /^ *┃\s+QUEUED\s*$/.test(row)),
  // Counted as it counts, on the text trimmed and its breaks normalised, `a\nb\n` is two lines
  // and shows whole. A person may turn the summary off (the palette's saved toggle, or
  // `experimental.disable_paste_summary`): the text then shows whole, and a tall one only as its
  // tail in the box's viewport, which the checks that expect a placeholder read as a box that
  // `showsTail` (probed 2026-11-22, 1.19.6: 40 lines showed the last 13 of a 40-row screen).
  collapses: (text) => {
    const trimmed = text.replaceAll(/\r\n?/g, "\n").trim()
    return trimmed.split("\n").length >= 3 || trimmed.length > 150
  },
  // It shows at most a third of the screen's rows of its text, the tail of a taller one, without
  // a mark (probed 2026-11-22, 1.19.6: 4, 6, 8, 10, 13, 16 rows on 12, 20, 24, 30, 40, 50; 17 rows
  // showed 6, so a third rounded down is the least it shows).
  room: (rows) => Math.max(Math.floor(rows / 3), 1),
  viewport: (rows) => Math.max(Math.floor(rows / 3), 1),
}

/** Whether a row is the title of a dialog that takes a secret: `API key`, a token, a code. */
const secretTitle =
  /^ {2,}[A-Za-z ]*\b(?:API key|token|secret|password|code)\b[A-Za-z ]* {3,}esc\s*$/i

/**
 * Where it draws its own: menus right above the box, over the history, on its alternate screen;
 * its dialogs (`/models`, `/connect`, the palette) over the middle of the screen, where the box
 * reads empty under them or is covered (probed 2026-11-22, 1.19.6; fixtures/input-box.probe.json).
 * `/connect`'s key prompt shows what is typed, no mask: `API key`, the field, `enter submit`.
 */
export const slice: SliceProfile = {
  agent: "opencode",
  side: () => "above",
  secret: (rows) =>
    rows.some((row) => secretTitle.test(row)) &&
    rows.some((row) => /^\s+enter submit\s*$/.test(row)),
}
