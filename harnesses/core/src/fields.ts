/**
 * A JSON object's fields, whatever holds them: a tool call's input, a hook's payload, a
 * transcript's record, a harness's settings. Each is read as `Fields`, never as a mutable
 * record, and told apart from anything else by these helpers alone.
 */
export type Fields = Readonly<Record<string, unknown>>

/** Whether a value is a JSON object: not null, and no array. */
export const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A value's fields, where it is a JSON object; undefined for anything else. */
export const fieldsOf = (value: unknown): Fields | undefined =>
  isFields(value) ? value : undefined

/** The fields of JSON text holding an object, as a transcript's line; undefined for anything else. */
export const parseFields = (text: string): Fields | undefined => {
  try {
    return fieldsOf(JSON.parse(text))
  } catch {
    return undefined
  }
}
