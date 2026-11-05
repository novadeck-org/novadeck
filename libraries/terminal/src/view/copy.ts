import type { IDisposable, Terminal } from "@novadeck/emulator/browser"

// A selection made with the mouse goes on the clipboard as the person lets go, in every
// terminal and on every platform, as copy-on-select terminals do: a drag, a double-click's
// word or a triple-click's line, with no key after it. Only a selection this press made
// counts, so a click never copies one left from before, and only the main button: macOS
// selects a word on a right-click, for its menu, and that copies nothing. A program that
// takes the mouse for itself gets the plain drags, and its own selection reaches the
// clipboard through `takeClipboardWrites`. Returns the undo.
export const copyOnSelect = (
  xterm: Pick<Terminal, "hasSelection" | "getSelection" | "onSelectionChange">,
  container: HTMLElement,
  copy: (text: string) => void,
): (() => void) => {
  const page = container.ownerDocument.defaultView ?? window
  // From a press in the terminal until its release has been read.
  let pressed = false
  // Whether the selection changed since that press.
  let changed = false
  let pending: ReturnType<typeof setTimeout> | undefined
  const changes = xterm.onSelectionChange(() => {
    if (pressed) changed = true
  })
  const down = (event: MouseEvent): void => {
    if (event.button !== 0) return
    clearTimeout(pending)
    pressed = true
    changed = false
  }
  // The release may land outside the terminal, as a drag past its edge does, so the page
  // hears it. The emulator tells of the selection's change in its own handler of the same
  // release, which runs after this one, so the release is read once that has run.
  const up = (event: MouseEvent): void => {
    if (event.button !== 0 || !pressed) return
    clearTimeout(pending)
    pending = setTimeout(() => {
      pressed = false
      if (!changed || !xterm.hasSelection()) return
      const text = xterm.getSelection()
      if (text) copy(text)
    }, 0)
  }
  container.addEventListener("mousedown", down, true)
  page.addEventListener("mouseup", up, true)
  return () => {
    clearTimeout(pending)
    changes.dispose()
    container.removeEventListener("mousedown", down, true)
    page.removeEventListener("mouseup", up, true)
  }
}

// The text an OSC 52 write carries for the clipboard, or undefined for any other: a read
// (`?`), one only for another selection (primary, secondary or a cut buffer), or data that
// is not base64. An empty target list means the clipboard, as xterm's does.
export const clipboardWrite = (data: string): string | undefined => {
  const split = data.indexOf(";")
  if (split < 0) return undefined
  const targets = data.slice(0, split)
  const payload = data.slice(split + 1)
  if (targets !== "" && !targets.includes("c")) return undefined
  if (payload === "" || payload === "?") return undefined
  let binary: string
  try {
    binary = atob(payload)
  } catch {
    return undefined
  }
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

// Lets a program in the terminal put text on the clipboard with OSC 52, as Claude Code's
// own selection, tmux, vim, or a program over ssh does. Only while the person is in this
// terminal (`focused`), so a program out of sight never replaces what they copied, and a
// write only: a program never reads the clipboard.
export const takeClipboardWrites = (
  xterm: Pick<Terminal, "parser">,
  copy: (text: string) => void,
  focused: () => boolean,
): IDisposable =>
  xterm.parser.registerOscHandler(52, (data) => {
    const text = clipboardWrite(data)
    if (text !== undefined && focused()) copy(text)
    return true
  })
