import { withWords } from "./agent-input"

// The command line of a demo terminal drawn as terminal output: what the emulator sends
// for the person's keys, read as the line a shell's readline keeps. Pure, so the terminal
// only routes what comes of it. Enter submits a line with
// something in it, and Escape is left to the terminal, which interrupts a working agent. A
// locked or ended terminal is the views' to hold: their emulator sends no keys while locked,
// and takes Enter itself once ended.

export type Line = {
  readonly draft: string
  // Where the next key lands, in UTF-16 units from the start of the draft.
  readonly cursor: number
  // The lines submitted, oldest first, and which one ↑/↓ shows; null while editing a draft.
  readonly history: readonly string[]
  readonly recalled: number | null
  // The draft as it was when ↑ first left it, which ↓ past the newest brings back.
  readonly stashed: string
}

type LineEvent =
  // A line with something in it; the draft is cleared and the line kept in the history.
  | { readonly type: "submit"; readonly line: string }
  // A lone Escape, which the emulator sends as a chunk of its own.
  | { readonly type: "escape" }

// How many submitted lines ↑ walks back through.
const historyLength = 100

export const emptyLine = (history: readonly string[] = []): Line => ({
  draft: "",
  cursor: 0,
  history: history.slice(-historyLength),
  recalled: null,
  stashed: "",
})

const pasteStart = "\x1b[200~"
const pasteEnd = "\x1b[201~"

// What a paste or dictation puts in the line: one line, as a form's input keeps it, with no
// control characters.
const asText = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- Control characters are what it drops.
  text.replace(/\r\n?|\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "")

const edited = (line: Line, draft: string, cursor: number): Line => ({
  ...line,
  draft,
  cursor,
  recalled: null,
})

const insert = (line: Line, text: string): Line =>
  text
    ? edited(
        line,
        line.draft.slice(0, line.cursor) + text + line.draft.slice(line.cursor),
        line.cursor + text.length,
      )
    : line

// Where the word before the cursor starts, past the spaces right before it.
const wordStart = (draft: string, cursor: number): number => {
  let at = cursor
  while (at > 0 && draft[at - 1] === " ") at -= 1
  while (at > 0 && draft[at - 1] !== " ") at -= 1
  return at
}

// Where the word after the cursor ends, past the spaces right after it.
const wordEnd = (draft: string, cursor: number): number => {
  let at = cursor
  while (at < draft.length && draft[at] === " ") at += 1
  while (at < draft.length && draft[at] !== " ") at += 1
  return at
}

// Where each character the person sees starts, so a cursor never parts an accent from its
// letter, an emoji from its skin tone, or a surrogate pair.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const starts = (draft: string): number[] => [
  ...Array.from(graphemes.segment(draft), (each) => each.index),
  draft.length,
]

// One character back or on.
const back = (draft: string, cursor: number): number =>
  starts(draft).findLast((at) => at < cursor) ?? 0
const on = (draft: string, cursor: number): number =>
  starts(draft).find((at) => at > cursor) ?? draft.length

const moved = (line: Line, cursor: number): Line => ({ ...line, cursor })

// ↑ and ↓ through the history. A recalled line once edited is a draft of its own: ↑ from it
// keeps it in place of the draft left at first, a simpler rule than readline's.
const recall = (line: Line, step: -1 | 1): Line => {
  const { history, recalled } = line
  if (step < 0) {
    if (history.length === 0 || recalled === 0) return line
    const at = recalled === null ? history.length - 1 : recalled - 1
    const draft = history[at]!
    return {
      ...line,
      draft,
      cursor: draft.length,
      recalled: at,
      stashed: recalled === null ? line.draft : line.stashed,
    }
  }
  if (recalled === null) return line
  if (recalled === history.length - 1)
    return {
      ...line,
      draft: line.stashed,
      cursor: line.stashed.length,
      recalled: null,
      stashed: "",
    }
  const draft = history[recalled + 1]!
  return { ...line, draft, cursor: draft.length, recalled: recalled + 1 }
}

const submitted = (line: Line): Line => {
  const { draft, history } = line
  const kept = history.at(-1) === draft ? history : [...history, draft].slice(-historyLength)
  return { ...line, draft: "", cursor: 0, history: kept, recalled: null, stashed: "" }
}

// A control sequence: CSI with its parameters, intermediates and final byte, or SS3's one
// letter. The emulator's own replies (device attributes, mode reports, the mouse) are CSI
// too, and come to nothing.
// eslint-disable-next-line no-control-regex -- A sequence starts with ESC.
const sequence = /^\x1b(?:\[([0-?]*)[ -/]*([@-~])|O([A-Za-z]))/
// A string the emulator sends whole, as an OSC colour reply, up to BEL or ST.
// eslint-disable-next-line no-control-regex -- It starts with ESC and ends with BEL or ESC \.
const string = /^\x1b[\]P_^][^\x07\x1b]*(?:\x07|\x1b\\)?/

// What a CSI or SS3 key does to the line; an unknown one does nothing.
const keyed = (line: Line, parameters: string, final: string): Line => {
  // A key's parameters are numbers; a reply's private ones (`?`, `<`, `>`) are no key.
  if (!/^[\d;]*$/.test(parameters)) return line
  const { draft, cursor } = line
  // With Ctrl or Alt (`1;5`, `1;3` and their Shift forms), ←/→ move a word and Delete deletes
  // one; with Shift alone they move a character.
  const modifier = Number(parameters.split(";")[1] ?? 1)
  const byWord = modifier >= 3
  switch (final) {
    case "A":
      return recall(line, -1)
    case "B":
      return recall(line, 1)
    case "C":
      return moved(line, byWord ? wordEnd(draft, cursor) : on(draft, cursor))
    case "D":
      return moved(line, byWord ? wordStart(draft, cursor) : back(draft, cursor))
    case "H":
      return moved(line, 0)
    case "F":
      return moved(line, draft.length)
    case "~":
      if (parameters === "1" || parameters === "7") return moved(line, 0)
      if (parameters === "4" || parameters === "8") return moved(line, draft.length)
      if (parameters.split(";")[0] === "3" && cursor < draft.length) {
        const to = byWord ? wordEnd(draft, cursor) : on(draft, cursor)
        return edited(line, draft.slice(0, cursor) + draft.slice(to), cursor)
      }
      return line
    default:
      return line
  }
}

// Reads what the emulator sent for the person's keys into the line, in order. The terminal
// must run bracketed paste mode (`ESC [ ? 2004 h`, written again after anything that resets
// it), so a paste arrives whole between its markers and inserts as text: without it, the
// emulator sends a paste's line breaks as Enter, and each line would submit. A chunk that is
// exactly ESC is Escape, as the emulator sends each key's whole sequence in one chunk.
export const editLine = (
  start: Line,
  data: string,
): { readonly line: Line; readonly events: readonly LineEvent[] } => {
  if (data === "\x1b") return { line: start, events: [{ type: "escape" }] }
  let line = start
  const events: LineEvent[] = []
  let at = 0
  while (at < data.length) {
    const rest = data.slice(at)
    if (rest.startsWith(pasteStart)) {
      const end = rest.indexOf(pasteEnd)
      const text = rest.slice(pasteStart.length, end < 0 ? undefined : end)
      line = insert(line, asText(text))
      at += end < 0 ? rest.length : end + pasteEnd.length
      continue
    }
    const control = sequence.exec(rest)
    if (control) {
      line = keyed(line, control[1] ?? "", control[2] ?? control[3]!)
      at += control[0].length
      continue
    }
    const reply = string.exec(rest)
    if (reply) {
      at += reply[0].length
      continue
    }
    const { draft, cursor } = line
    const key = rest[0]!
    at += 1
    switch (key) {
      case "\r":
      case "\n":
        // A line break as CR LF is one Enter.
        if (key === "\r" && rest[1] === "\n") at += 1
        if (draft.trim()) {
          events.push({ type: "submit", line: draft })
          line = submitted(line)
        }
        break
      case "\x7f":
      case "\b":
        if (cursor > 0) {
          const from = back(draft, cursor)
          line = edited(line, draft.slice(0, from) + draft.slice(cursor), from)
        }
        break
      case "\x01":
        line = moved(line, 0)
        break
      case "\x05":
        line = moved(line, draft.length)
        break
      case "\x15":
        line = edited(line, draft.slice(cursor), 0)
        break
      case "\x0b":
        line = edited(line, draft.slice(0, cursor), cursor)
        break
      case "\x17": {
        const from = wordStart(draft, cursor)
        line = edited(line, draft.slice(0, from) + draft.slice(cursor), from)
        break
      }
      case "\x03":
        line = edited(line, "", 0)
        break
      case "\x1b": {
        // Alt with a key, as ESC then the key: Alt+Backspace (and Ctrl+Alt+Backspace) deletes
        // the word before the cursor, and any other is dropped with its key.
        const next = rest[1]
        if (next === "\x7f" || next === "\b") {
          const from = wordStart(draft, cursor)
          line = edited(line, draft.slice(0, from) + draft.slice(cursor), from)
        }
        if (next !== undefined) at += 1
        break
      }
      default:
        // Text inserts; any other control character, as Tab, does nothing.
        if (key >= " ") line = insert(line, key)
    }
  }
  return { line, events }
}

// A submitted line the terminal couldn't take, put back in front of what was typed since.
export const restoreLine = (line: Line, text: string): Line => ({
  ...line,
  draft: text + line.draft,
  cursor: text.length + line.cursor,
  recalled: null,
})

// The words an interrupted turn gives back, added to the draft after a space.
export const withReturnedWords = (line: Line, words: string): Line => {
  const draft = withWords(line.draft, words)
  return edited(line, draft, draft.length)
}
