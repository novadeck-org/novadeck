import { maxUploadBytes } from "@novadeck/protocol"
import { hasCode, RunnerError } from "@novadeck/protocol/client"
import type { Terminal } from "@xterm/xterm"

import { currentPlatform, type Platform } from "./platform"

// Files pasted into a terminal reach its programs as paths: the runner saves each one on
// its machine, and the terminal gets their paths as pasted text, as a native terminal
// does for a dropped file. Claude Code and Codex take a pasted image's path as the image.

// The extension for clipboard bytes of a type, which come without a name.
const extensions: Partial<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "application/pdf": "pdf",
  "text/plain": "txt",
}

// The files a paste carries: files copied in a file manager, or bytes such as an image
// copied from a page.
export const pastedFiles = (
  data: {
    readonly files: ArrayLike<File>
    readonly items: ArrayLike<Pick<DataTransferItem, "kind" | "getAsFile">>
  } | null,
): File[] => {
  if (!data) return []
  const files = Array.from(data.files)
  if (files.length > 0) return files
  return Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file) => file !== null)
}

// Whether a paste carries text, which is the emulator's to paste.
export const pastedText = (data: Pick<DataTransfer, "getData"> | null): boolean =>
  Boolean(data?.getData("text/plain"))

// The name a file is saved under: its own, or `pasted-<time>.<extension>` for bytes
// without one.
export const uploadName = (file: { readonly name: string; readonly type: string }, now: Date) => {
  if (file.name) return file.name
  const extension = extensions[file.type] ?? (file.type.split("/")[1] || "bin")
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")
  return `pasted-${stamp}.${extension}`
}

// Whether a path is a Windows one: on a drive, or a share.
const windowsPath = (path: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)

// What a Windows path may hold to go in as itself: letters, marks and digits, spaces, and
// `.`, `_`, `-`, `\`, `:`, which mean nothing to cmd or PowerShell wherever the quotes
// end up: PowerShell drops them around a word without a space as it runs a `.cmd`, and
// a paste into a quote already open pairs them wrongly. Not the spacing modifier letters
// (U+02B0 to U+02FF) or the combining diacritics (U+0300 to U+036F), some of which a
// conversion to the system's code page turns into a quote.
const windowsSafe = /^(?:(?![\u02b0-\u036f])[\p{L}\p{M}\p{N} ._\-\\:])+$/u

// A path as a shell reads it as one word: backslashes before its special characters,
// `^` among them for zsh's extended globs, or on Windows, where a backslash separates
// folders, in double quotes when it has a space or anything `windowsSafe` leaves out, as
// an upload's under a user folder such as `C:\R&D` has. Quotes keep cmd and PowerShell
// from acting on `&` and the like, though not every shell from expanding `%`, `!`, `$`
// or PowerShell's backtick, and PowerShell drops them as it runs a `.cmd`, whose cmd
// then splits the path.
export const shellPath = (path: string): string => {
  if (windowsPath(path)) return windowsSafe.test(path) && !/\s/.test(path) ? path : `"${path}"`
  return path.replace(/([ \t"'`\\()&;|<>$!*?[\]{}#~^])/g, "\\$1")
}

// A file's own path as a shell reads it as one word, or undefined where it can't go in
// safely, and a copy goes instead: one with a control character, and on Windows, whose
// cmd and PowerShell can't be escaped alike, one with anything `windowsSafe` leaves out
// or a space before a `-`.
export const ownPath = (path: string): string | undefined => {
  if (!path || /\p{Cc}/u.test(path)) return undefined
  // A space before `-` could make an option of the rest, were its quotes lost.
  if (windowsPath(path) && (!windowsSafe.test(path) || /\s-/.test(path))) return undefined
  return shellPath(path)
}

// The images on the clipboard. A paste into the emulator's text field leaves out what a
// text field can't hold, so a paste of an image alone arrives empty; the clipboard API
// still has it, once the page may read the clipboard. Undefined where it may not, or
// has no clipboard API.
export const clipboardImages = async (now: Date): Promise<File[] | undefined> => {
  try {
    return await imagesOf(await navigator.clipboard.read(), now)
  } catch {
    return undefined
  }
}

type ClipboardEntry = Pick<ClipboardItem, "types" | "getType">

// The images among a clipboard's items, as files.
const imagesOf = async (items: readonly ClipboardEntry[], now: Date): Promise<File[]> => {
  const images = await Promise.all(
    items.map(async (item) => {
      const type = item.types.find((name) => name.startsWith("image/"))
      if (!type) return undefined
      const blob = await item.getType(type)
      return new File([blob], uploadName({ name: "", type }, now), { type })
    }),
  )
  return images.filter((image) => image !== undefined)
}

// What a failed paste tells the person: that the clipboard could not be read, or which
// file could not be saved, and why when it was too large.
export const pasteNotice = (
  failure: "clipboard" | { readonly type: string; readonly error: unknown },
): string => {
  if (failure === "clipboard") return "NovaDeck can't read the clipboard"
  const pasted = failure.type.startsWith("image/") ? "image" : "file"
  return hasCode(failure.error, "UPLOAD_TOO_LARGE")
    ? `Couldn't paste the ${pasted}: it's over ${maxUploadBytes / 1024 / 1024} MB`
    : `Couldn't paste the ${pasted}`
}

export type PasteTarget = {
  // Saves a file on the runner's machine and resolves with its path there.
  readonly upload: (file: { readonly name: string; readonly data: Uint8Array }) => Promise<string>
  // Pastes text into the terminal, as the emulator pastes the clipboard's.
  readonly paste: (text: string) => void
  // Tells the person why a paste failed, in a short notice.
  readonly failed: (notice: string) => void
  // A file's own path on the runner's machine, or "" for one that has none there. Only
  // the desktop app, whose runner is its own, knows it.
  readonly pathOf?: ((file: File) => string) | undefined
}

// A file's path as the shell reads it: its own, as of a file or folder copied in a file
// manager, where that is safe; otherwise a copy's, saved on the runner's machine. One too
// large to copy is never read.
const save = async (file: File, target: PasteTarget, now: Date): Promise<string> => {
  const own = ownPath(target.pathOf?.(file) ?? "")
  if (own) return own
  if (file.size > maxUploadBytes) throw new RunnerError("UPLOAD_TOO_LARGE")
  const path = await target.upload({
    name: uploadName(file, now),
    data: new Uint8Array(await file.arrayBuffer()),
  })
  return shellPath(path)
}

// Saves the files one after another, pasting the path of each one as it is,
// followed by a space, as a paste of its own: Codex takes a paste for an image only when
// it is one path. A file the runner could not save is left out, and the first of them
// told of. Answers how many went in.
const pasteFiles = async (files: readonly File[], target: PasteTarget): Promise<number> => {
  const now = new Date()
  let notice: string | undefined
  let pasted = 0
  for (const file of files) {
    try {
      // eslint-disable-next-line no-await-in-loop -- One file in memory and in flight at a time.
      target.paste(`${await save(file, target, now)} `)
      pasted += 1
    } catch (error) {
      console.error("NovaDeck could not save a pasted file on the runner:", error)
      notice ??= pasteNotice({ type: file.type, error })
    }
  }
  if (notice) target.failed(notice)
  return pasted
}

// Takes the pastes into `host` that carry files and no text, before the emulator inside
// it sees them, and pastes the files' paths instead. A paste with text is the emulator's,
// even with an image beside it, as a spreadsheet's cells come; one with neither, as of
// an image alone, reads the clipboard's images, and says so when it can't. That empty
// paste goes to the program only when no image's path does, as some read the clipboard
// themselves on one, and would take the image twice. Returns the undo.
export const takeFilePastes = (host: HTMLElement, target: PasteTarget): (() => void) => {
  const listener = (event: ClipboardEvent): void => {
    if (pastedText(event.clipboardData)) return
    const files = pastedFiles(event.clipboardData)
    if (files.length > 0) {
      event.preventDefault()
      event.stopPropagation()
      void pasteFiles(files, target)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    void clipboardImages(new Date()).then(async (images) => {
      if (images && images.length > 0 && (await pasteFiles(images, target)) > 0) return
      target.paste("")
      if (!images) target.failed(pasteNotice("clipboard"))
    })
  }
  host.addEventListener("paste", listener, true)
  return () => host.removeEventListener("paste", listener, true)
}

// How long typing waits behind Ctrl+V while the clipboard is read, at most.
export const ctrlVWaitMs = 1_000
// How long typing waits behind Ctrl+V at all, even for an image still uploading, whose
// path then goes in when it is saved.
export const ctrlVHoldMs = 2_000

type Key = Pick<
  KeyboardEvent,
  | "type"
  | "key"
  | "code"
  | "ctrlKey"
  | "shiftKey"
  | "altKey"
  | "metaKey"
  | "isComposing"
  | "keyCode"
>

// Whether a key press is a plain Ctrl+V on Linux or Windows, which may paste an image.
// On Apple platforms ⌘V pastes and Ctrl+V stays the program's; with Shift it pastes
// already, AltGr reports Ctrl with Alt, and a key composing text belongs to the input
// method. The V is the layout's, or the key's place where the layout has no Latin
// letters there.
export const plainCtrlV = (event: Key, platform: Platform): boolean => {
  if (platform === "mac" || event.type !== "keydown") return false
  if (event.isComposing || event.keyCode === 229) return false
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return false
  return /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === "v" : event.code === "KeyV"
}

// Whether Ctrl+V pastes a clipboard's images: it holds an image and no text. Text stays
// the program's, as the paste of text beside an image does.
export const pastesImages = (items: readonly Pick<ClipboardItem, "types">[]): boolean =>
  items.some((item) => item.types.some((type) => type.startsWith("image/"))) &&
  !items.some((item) => item.types.includes("text/plain"))

// The images Ctrl+V pastes: none but on a clipboard of images and no text, or one it
// can't read.
const ctrlVImages = async (now: Date): Promise<File[]> => {
  try {
    const items = await navigator.clipboard.read()
    return pastesImages(items) ? await imagesOf(items, now) : []
  } catch {
    return []
  }
}

// Whether Ctrl+V may read the clipboard without asking: always in the desktop app, which
// allows it, and in a browser once the page may, as after a first image pasted with
// Ctrl+Shift+V. Reading it otherwise would ask on every Ctrl+V, as vim's.
export const clipboardAccess = (desktop: boolean): (() => boolean) => {
  if (desktop) return () => true
  let granted = false
  const watch = async (): Promise<void> => {
    const status = await navigator.permissions.query({ name: "clipboard-read" as PermissionName })
    granted = status.state === "granted"
    status.addEventListener("change", () => (granted = status.state === "granted"))
  }
  // A browser that has no such permission to ask about never reads it.
  watch().catch(() => {})
  return () => granted
}

export type CtrlVTarget = PasteTarget & {
  // Whether the terminal's program takes input now; otherwise Ctrl+V goes as it did.
  readonly active: () => boolean
  // Holds the terminal's input until the returned release, which first sends Ctrl+V as
  // typed when `controlV`. Pastes while held go ahead of what it holds.
  readonly hold: () => (controlV: boolean) => void
}

// Makes a plain Ctrl+V on Linux and Windows paste a clipboard of images as their paths,
// as a paste of them does. Any other clipboard, one it can't read, or one read too slowly
// sends Ctrl+V to the program, without a word, as programs such as vim take it. Typing
// meanwhile waits, to arrive after the paths or Ctrl+V, for `holdMs` at most. Ctrl+V
// pressed again, or repeating, while typing waits does nothing, so an image goes in once;
// once typing goes again, as past a slow upload, Ctrl+V does too.
export const takeCtrlV = (
  xterm: Pick<Terminal, "attachCustomKeyEventHandler">,
  target: CtrlVTarget,
  {
    platform = currentPlatform(),
    readable = (): boolean => true,
    waitMs = ctrlVWaitMs,
    holdMs = ctrlVHoldMs,
  } = {},
): void => {
  let holding = false
  const check = async (): Promise<void> => {
    const hold = target.hold()
    let cap: ReturnType<typeof setTimeout> | undefined
    let released = false
    const release = (controlV: boolean): void => {
      if (released) return
      released = true
      holding = false
      clearTimeout(cap)
      hold(controlV)
    }
    // An image found but slow to upload lets typing go, and sends no Ctrl+V.
    cap = setTimeout(() => release(false), holdMs)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<File[]>((resolve) => (timer = setTimeout(resolve, waitMs, [])))
    const images = await Promise.race([ctrlVImages(new Date()), late])
    clearTimeout(timer)
    if (images.length === 0) return release(true)
    // An image none of whose paths went in leaves Ctrl+V to the program, as its paste does.
    release((await pasteFiles(images, target)) === 0)
  }
  xterm.attachCustomKeyEventHandler((event) => {
    if (!plainCtrlV(event, platform) || !target.active() || !readable()) return true
    event.preventDefault()
    if (holding) return false
    holding = true
    void check().catch(() => (holding = false))
    return false
  })
}
