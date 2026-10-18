import type { PasteFailure } from "@novadeck/terminal/view"

// What a failed paste tells the person, in the app's words: that the clipboard could not be
// read, or which file could not be saved, and why when it was over the `maxBytes` a paste may
// upload. A backend that hears of a file too large some other way says so in `tooLarge`.
export const pasteNotice =
  (maxBytes: number) =>
  (failure: PasteFailure): string => {
    if (failure.kind === "clipboard") return "Novadeck can't read the clipboard"
    const pasted = failure.type.startsWith("image/") ? "image" : "file"
    return failure.tooLarge
      ? `Couldn't paste the ${pasted}: it's over ${maxBytes / 1024 / 1024} MB`
      : `Couldn't paste the ${pasted}`
  }
