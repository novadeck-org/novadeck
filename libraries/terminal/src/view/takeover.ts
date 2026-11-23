// What a terminal's input is, for a screen that only observes: whether it asks for the keyboard.
// Pure: it imports nothing.

// How the input of an observed terminal is told apart:
// - `text`: typed characters, or a paste, which take control and are delivered.
// - `key`: Enter, Esc, Tab, Backspace, arrows and other navigation, Ctrl and Alt chords, which
//   take control but are not delivered, so a key meant for the other window's program never
//   lands in this one's by surprise.
// - `report`: what the emulator sends on its own, such as mouse and focus reports and answers
//   to the program's queries. They take nothing and go nowhere while observing.
export type InputClass = "text" | "key" | "report"

// How long the controller must have been quiet for a typed key or a paste to take control.
export const takeIdleMs = 2_000

const bracketedPaste = "\u001b[200~"

// What the emulator sends on its own, which a key never is: mouse (`CSI < … M/m`, `CSI M …`) and
// focus (`CSI I/O`) reports, device attribute and mode answers (`CSI ? …`, `CSI > …`), a cursor
// position answer (`CSI r;c R`), and complete OSC and DCS answers (ending in BEL or ST). A lone
// `ESC ]` or `ESC P` is Alt+] or Alt+Shift+P, so those count only when complete. Shift/Ctrl+F3
// (`CSI 1;2 R`) is the same bytes as a cursor position answer, which can't be told apart here:
// it is taken for the answer, so it asks for nothing.
/* oxlint-disable no-control-regex -- Escape sequences are what this reads. */
const reports =
  /^\u001b(?:\[(?:<|M|I$|O$|\?|>|\d+;\d+R$)|\][^\u0007\u001b]*(?:\u0007|\u001b\\)$|P[\s\S]*\u001b\\$)/
// One key's escape sequence: a CSI or SS3 sequence (arrows, navigation, function and modified
// keys), or Escape with one character after it (Alt chords, a held Escape's repeat).
const keySequence = /^\u001b(?:\[[\d;:]*[~A-Za-z]|O[\dA-Za-z]|\u001b|[\s\S])?$/u
const control = /^[\u0000-\u001f\u007f-\u009f]$/
/* oxlint-enable no-control-regex */

export const classifyInput = (data: string): InputClass => {
  if (data.startsWith(bracketedPaste)) return "text"
  if (reports.test(data)) return "report"
  if (data.startsWith("\u001b")) return keySequence.test(data) ? "key" : "text"
  // One control character is Enter, Tab, Backspace or a Ctrl chord. Any longer run is a paste or
  // an input method's commit outside bracketed mode, whatever it starts with.
  return control.test(data) ? "key" : "text"
}
