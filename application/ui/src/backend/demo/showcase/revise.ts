import { notePattern } from "../../../model/companion"

// How a sample agent revises its plan: edits to the file as it finds it, as an agent
// rewrites the lines it means to change and leaves the rest, the user's edits included.
export type PlanEdit =
  // The line reading `line`, notes aside, now reads `with`; its notes stay, after it.
  | { readonly line: string; readonly with: string }
  // A new line after the one reading `after`.
  | { readonly after: string; readonly insert: string }

const withoutNotes = (line: string): string => line.replace(/ ?<!-- novadeck: .*? -->/g, "")

// The file's line break, kept as the file has it.
const lineBreak = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n")

export const applyEdits = (text: string, edits: readonly PlanEdit[]): string => {
  const eol = lineBreak(text)
  const lines = text.split(/\r?\n/)
  for (const edit of edits) {
    const target = "line" in edit ? edit.line : edit.after
    const index = lines.findIndex((line) => withoutNotes(line) === target)
    if (index < 0) continue
    // The line's notes stay, after its new text.
    if ("line" in edit)
      lines[index] = edit.with + (lines[index]!.match(/ ?<!-- novadeck: .*? -->/g) ?? []).join("")
    else lines.splice(index + 1, 0, edit.insert)
  }
  return lines.join(eol)
}

// The agent read the notes, applied them, and removed each one: a note with a line to
// itself goes with its line.
export const removeNotes = (text: string): string => {
  const eol = lineBreak(text)
  return text
    .split(/\r?\n/)
    .filter((line) => !(line.trim() && !line.replace(notePattern, "").trim()))
    .map(withoutNotes)
    .join(eol)
}
