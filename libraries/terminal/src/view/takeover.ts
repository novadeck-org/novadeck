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

// Mouse (`CSI < … M/m`, `CSI M …`), focus (`CSI I/O`), device and colour answers
// (`CSI ? …`, `OSC …`, `DCS …`) and a cursor position answer (`CSI r;c R`).
// oxlint-disable-next-line no-control-regex -- Escape sequences are what this reads.
const reports = /^\u001b(?:\[(?:<|M|I$|O$|\?|\d+;\d+R$|[>=])|\]|P)/

export const classifyInput = (data: string): InputClass => {
  if (data.startsWith(bracketedPaste)) return "text"
  if (reports.test(data)) return "report"
  if (data.startsWith("\u001b")) return "key"
  // One control character is Enter, Tab, Backspace or a Ctrl chord; longer data that starts with
  // text is a paste outside bracketed mode, its line breaks included.
  if (data.length === 1) {
    const code = data.codePointAt(0)!
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "key" : "text"
  }
  // oxlint-disable-next-line no-control-regex -- Control characters are what this reads.
  return /^[\u0000-\u001f\u007f-\u009f]/.test(data) ? "key" : "text"
}
