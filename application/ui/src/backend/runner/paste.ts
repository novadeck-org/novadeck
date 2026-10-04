import { maxUploadBytes } from "@novadeck/protocol"
import { hasCode, RunnerError } from "@novadeck/protocol/client"

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

// A path as a shell reads it as one word: backslashes before its special characters, or
// on Windows, where a backslash separates folders, in double quotes when it has a space.
export const shellPath = (path: string): string => {
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) return /\s/.test(path) ? `"${path}"` : path
  return path.replace(/([ \t"'`\\()&;|<>$!*?[\]{}#~])/g, "\\$1")
}

// The images on the clipboard. A paste into the emulator's text field leaves out what a
// text field can't hold, so a paste of an image alone arrives empty; the clipboard API
// still has it, once the page may read the clipboard. Undefined where it may not, or
// has no clipboard API.
export const clipboardImages = async (now: Date): Promise<File[] | undefined> => {
  try {
    const items = await navigator.clipboard.read()
    const images = await Promise.all(
      items.map(async (item) => {
        const type = item.types.find((name) => name.startsWith("image/"))
        if (!type) return undefined
        const blob = await item.getType(type)
        return new File([blob], uploadName({ name: "", type }, now), { type })
      }),
    )
    return images.filter((image) => image !== undefined)
  } catch {
    return undefined
  }
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
}

// Saves a file on the runner's machine; one too large is never read.
const save = async (file: File, target: PasteTarget, now: Date): Promise<string> => {
  if (file.size > maxUploadBytes) throw new RunnerError("UPLOAD_TOO_LARGE")
  return target.upload({
    name: uploadName(file, now),
    data: new Uint8Array(await file.arrayBuffer()),
  })
}

// Uploads the files one after another, pasting the path of each one saved as it is,
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
      target.paste(`${shellPath(await save(file, target, now))} `)
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
