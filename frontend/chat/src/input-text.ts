// A JSON value written as a string, as Antigravity writes each argument of a call; undefined
// for a string that isn't one.
const decoded = (value: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(value) as unknown }
  } catch {
    return undefined
  }
}

// Whether a call's arguments are each a JSON value written as a string, as Antigravity's are.
// Claude Code's and Codex's arguments are plain values: a string of theirs that reads as
// JSON, such as a command in quotes, is what the agent wrote, and stays so beside any other
// argument that doesn't read as JSON, as a path, a description or a number. A call of theirs
// with one argument, a string all in quotes, reads as Antigravity's.
const encoded = (values: readonly unknown[]): boolean =>
  values.length > 0 &&
  values.every((value) => typeof value === "string" && decoded(value) !== undefined)

// A string argument with the JSON quoting of an encoded call's undone.
const unquote = (value: string): string => {
  const parsed = decoded(value)?.value
  return typeof parsed === "string" ? parsed : value
}

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

// A tool call's input as a person reads it when the row opens: the one value a call holds,
// as it is; several, one `name: value` to a line, strings without the JSON quotes of a call
// that encodes each (`encoded`). Input that isn't JSON, such as a patch, is shown as written.
export const inputText = (input: string): string => {
  const fields = parseFields(input)
  if (!fields) return input
  const quoted = encoded(Object.values(fields))
  const entries = Object.entries(fields).map(
    ([name, value]) =>
      [
        name,
        typeof value !== "string" ? JSON.stringify(value) : quoted ? unquote(value) : value,
      ] as const,
  )
  if (entries.length === 1) return entries[0]![1]
  return entries
    .map(([name, value]) => (value.includes("\n") ? `${name}:\n${value}` : `${name}: ${value}`))
    .join("\n")
}
