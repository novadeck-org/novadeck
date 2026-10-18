export type Schema = Record<string, unknown>

export const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Follows local `$ref`s. Keywords written beside a `$ref` (a description, a default) win over
// the target's, as JSON Schema 2020-12 reads them.
export const resolve = (root: Schema, schema: Schema): Schema => {
  let current = schema
  for (let i = 0; i < 12; i++) {
    const ref = current["$ref"]
    if (typeof ref !== "string" || !ref.startsWith("#/")) return current
    let target: unknown = root
    for (const part of ref.slice(2).split("/")) target = isSchema(target) ? target[part] : undefined
    if (!isSchema(target)) return current
    const { $ref: _ref, ...rest } = current
    current = { ...target, ...rest }
  }
  return current
}
