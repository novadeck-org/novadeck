import type { ToolRun } from "@novadeck/core/conversation"

const parseFields = (input: string): Readonly<Record<string, unknown>> | null => {
  try {
    const value: unknown = JSON.parse(input)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null
  } catch {
    return null
  }
}

type Entry = readonly [name: string, value: string]

const textEntries = (fields: Readonly<Record<string, unknown>>): readonly Entry[] =>
  Object.entries(fields).map(([name, value]) => [
    name,
    typeof value === "string" ? value : JSON.stringify(value),
  ])

const namedText = (entries: readonly Entry[]): string =>
  entries
    .map(([name, value]) => (value.includes("\n") ? `${name}:\n${value}` : `${name}: ${value}`))
    .join("\n")

const entriesText = (entries: readonly Entry[]): string =>
  entries.length === 1 ? entries[0]![1] : namedText(entries)

// What a command's input carries beside the command: the harness's own words for it.
const aboutACommand = new Set(["description", "Description", "toolAction"])

// A tool call's input as a person reads it when the row opens, less what its line says already;
// null where that leaves nothing. The one value a call holds, as it is; several, one `name: value`
// to a line; input that isn't JSON, such as a patch, as written. Only the field the line shows
// goes, whole as it stands there, and what a command says of itself: a subagent's prompt, a
// search's path and flags all stay.
export const inputBeyondLine = (input: string, { kind, detail }: ToolRun): string | null => {
  const line = detail.trim()
  const fields = parseFields(input)
  if (!fields) {
    const text = input.trim()
    return text === "" || text === line ? null : text
  }
  const entries = textEntries(fields)
  const rest = entries.filter(
    ([name, value]) =>
      !(line !== "" && value.trim() === line) && !(kind === "run" && aboutACommand.has(name)),
  )
  if (rest.length === 0) return null
  if (rest.length === entries.length) return entriesText(rest)
  // What is left of a field the line starts is that field; anything else keeps its name.
  const only = rest.length === 1 ? rest[0]![1].trim() : ""
  return line !== "" && only.split("\n", 1)[0]?.trim() === line ? only : namedText(rest)
}
