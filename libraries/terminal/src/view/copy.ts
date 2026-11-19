import type { IDisposable, Terminal } from "@novadeck/emulator/browser"

import { currentPlatform, type Platform } from "./paste.js"

// A selection made with the mouse goes on the clipboard as the person lets go, in every
// terminal and on every platform, as copy-on-select terminals do: a drag, a double-click's
// word or a triple-click's line, with no key after it. Only a selection this press made
// counts: one the emulator told of a change to, or one where there was none at the press,
// as a drag over the very cells of a cleared one is, which the emulator tells nothing of.
// A click never copies one left from before, and only the main button: macOS
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
  // Whether the selection changed since that press, and whether there was one at it.
  let changed = false
  let had = false
  let pending: ReturnType<typeof setTimeout> | undefined
  const changes = xterm.onSelectionChange(() => {
    if (pressed) changed = true
  })
  const down = (event: MouseEvent): void => {
    if (event.button !== 0) return
    clearTimeout(pending)
    pressed = true
    changed = false
    had = xterm.hasSelection()
  }
  // The release may land outside the terminal, as a drag past its edge does, so the page
  // hears it. The emulator tells of the selection's change in its own handler of the same
  // release, which runs after this one, so the release is read once that has run.
  const up = (event: MouseEvent): void => {
    if (event.button !== 0 || !pressed) return
    clearTimeout(pending)
    pending = setTimeout(() => {
      pressed = false
      if ((had && !changed) || !xterm.hasSelection()) return
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

// How long a program's OSC 52 write waits for the program's own copy to reach the
// clipboard before the page writes it there itself.
export const programCopyMs = 400

// The clipboard as a program's OSC 52 write reaches it.
export type ClipboardWrites = {
  // Whether the person is in this terminal.
  readonly focused: () => boolean
  // The clipboard's text as the page sees it, or undefined where the page may not read it.
  readonly read: () => Promise<string | undefined>
  // Puts text on the clipboard, and says so.
  readonly copy: (text: string) => void
  // Says the text is on the clipboard, where it already was.
  readonly copied: () => void
}

// Text without what a program's own copy may change in its OSC 52 one: line endings and a
// final line break.
const plain = (text: string): string => text.replace(/\r\n?/g, "\n").replace(/\n$/, "")

// Whether two copies hold the same text.
const sameText = (a: string, b: string): boolean => plain(a) === plain(b)

// Lets a program in the terminal put text on the clipboard with OSC 52, as Claude Code's
// own selection, tmux, vim, or a program over ssh does. Only while the person is in this
// terminal (`focused`), so a program out of sight never replaces what they copied, and a
// write only: a program never reads the clipboard.
//
// A program may copy twice, with OSC 52 and with the system's own tool, as Claude Code
// does on Linux with wl-copy. On GNOME's Wayland the page's second write of the same text
// comes after the tool's, under an older input of the person's, so the compositor drops
// it, while Chromium takes the clipboard for its own from then on: every paste in the app
// gives that text back, whatever is copied elsewhere, until the app copies again. So on
// Linux (`platform` "other") the write waits `programCopyMs` for such a copy, and leaves
// the clipboard be when it already holds the text. Of several writes in that time the
// last one counts, and one the person left the terminal during is dropped, so a copy of
// their own there isn't replaced; the page can't write the clipboard without focus anyway.
// macOS and Windows write at once, without reading the clipboard.
export const takeClipboardWrites = (
  xterm: Pick<Terminal, "parser">,
  clipboard: ClipboardWrites,
  { platform = currentPlatform() }: { platform?: Platform } = {},
): IDisposable => {
  let latest = 0
  // The text the waiting write puts on the clipboard, which a later write replaces.
  let waiting: string | undefined
  let pending: ReturnType<typeof setTimeout> | undefined
  const write = async (text: string, turn: number): Promise<void> => {
    const held = await clipboard.read().catch(() => undefined)
    if (turn !== latest || !clipboard.focused()) return
    if (held !== undefined && sameText(held, text)) clipboard.copied()
    else clipboard.copy(text)
  }
  const handler = xterm.parser.registerOscHandler(52, (data) => {
    const text = clipboardWrite(data)
    if (text === undefined || !clipboard.focused()) return true
    if (platform !== "other") {
      clipboard.copy(text)
      return true
    }
    latest += 1
    waiting = text
    // A write already waiting takes the new text, so a program that copies often still
    // gets its latest copy written in time.
    pending ??= setTimeout(() => {
      pending = undefined
      const next = waiting ?? ""
      waiting = undefined
      void write(next, latest)
    }, programCopyMs)
    return true
  })
  return {
    dispose: () => {
      clearTimeout(pending)
      pending = undefined
      latest += 1
      handler.dispose()
    },
  }
}

// The clipboard's text where the page may read it without asking the person, as the
// desktop app's page may; undefined elsewhere, as a browser that would prompt for it.
export const readClipboard = async (): Promise<string | undefined> => {
  try {
    const name = "clipboard-read" as PermissionName
    if ((await navigator.permissions.query({ name })).state !== "granted") return undefined
    return await navigator.clipboard.readText()
  } catch {
    return undefined
  }
}
