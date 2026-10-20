// A string value, with the JSON quoting some harnesses wrap their arguments' strings in
// undone. Harmless for any other.
const unquote = (value: string): string => {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "string" ? parsed : value
  } catch {
    return value
  }
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
// as it is; several, one `name: value` to a line, strings without their JSON quotes.
// Input that isn't JSON, such as a patch, is shown as written.
export const inputText = (input: string): string => {
  const fields = parseFields(input)
  if (!fields) return input
  const entries = Object.entries(fields).map(
    ([name, value]) =>
      [name, typeof value === "string" ? unquote(value) : JSON.stringify(value)] as const,
  )
  if (entries.length === 1) return entries[0]![1]
  return entries
    .map(([name, value]) => (value.includes("\n") ? `${name}:\n${value}` : `${name}: ${value}`))
    .join("\n")
}
