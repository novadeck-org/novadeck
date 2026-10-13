// Reads zod's JSON Schema the way an API reference does: what a value is called, what it
// constrains, what it looks like as TypeScript and as an example.
import { isSchema, resolve } from "../../components/json-schema.ts"
import type { Schema } from "../../components/json-schema.ts"

export type { Schema }
export { isSchema, resolve }

const schemas = (value: unknown): Schema[] => (Array.isArray(value) ? value.filter(isSchema) : [])

// Schemas that say nothing: a procedure with no input is `{ $schema }` alone.
export const isEmpty = (schema: Schema | null): boolean =>
  !schema || Object.keys(schema).every((key) => ["$schema", "$defs", "definitions"].includes(key))

export type View = {
  schema: Schema
  nullable: boolean
  // More than one way to be this value, with `null` taken out.
  variants: Schema[]
}

const isNull = (schema: Schema) => schema["type"] === "null"

const inherit = (from: Schema): Schema => {
  const out: Schema = {}
  for (const key of ["description", "default"]) if (key in from) out[key] = from[key]
  return out
}

export const view = (root: Schema, input: Schema): View => {
  let schema = resolve(root, input)
  let nullable = false
  const all = schemas(schema["allOf"])
  if (all.length) {
    const parts = all.map((part) => resolve(root, part))
    const merged: Schema = {}
    for (const part of parts) {
      Object.assign(merged, part, {
        properties: {
          ...(isSchema(merged["properties"]) ? merged["properties"] : {}),
          ...(isSchema(part["properties"]) ? part["properties"] : {}),
        },
        required: [...new Set([...asList(merged["required"]), ...asList(part["required"])])],
      })
    }
    const { allOf: _all, ...rest } = schema
    schema = { ...merged, ...rest }
  }
  for (let i = 0; i < 8; i++) {
    const union = schemas(schema["anyOf"]).length
      ? schemas(schema["anyOf"])
      : schemas(schema["oneOf"])
    if (!union.length) break
    const resolved = flatten(root, union)
    const rest = resolved.filter((each) => !isNull(each))
    if (rest.length !== resolved.length) nullable = true
    if (rest.length === 1) {
      schema = { ...rest[0], ...inherit(schema) }
      continue
    }
    return { schema, nullable, variants: rest }
  }
  if (Array.isArray(schema["type"]) && schema["type"].includes("null")) {
    nullable = true
    const types = schema["type"].filter((each) => each !== "null")
    schema = { ...schema, type: types.length === 1 ? types[0] : types }
  }
  return { schema, nullable, variants: [] }
}

// Variants with unions among them: the alternatives of the inner ones count as the outer's.
const flatten = (root: Schema, union: Schema[], depth = 0): Schema[] =>
  union.flatMap((each) => {
    const resolved = resolve(root, each)
    const inner = schemas(resolved["anyOf"]).length
      ? schemas(resolved["anyOf"])
      : schemas(resolved["oneOf"])
    return inner.length && depth < 6 && !isSchema(resolved["properties"])
      ? flatten(root, inner, depth + 1)
      : [resolved]
  })

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export const properties = (schema: Schema): [string, Schema][] =>
  isSchema(schema["properties"])
    ? Object.entries(schema["properties"]).filter((entry): entry is [string, Schema] =>
        isSchema(entry[1]),
      )
    : []

export const requiredOf = (schema: Schema): Set<string> =>
  new Set(asList(schema["required"]).filter((each): each is string => typeof each === "string"))

const isLiteral = (schema: Schema) => "const" in schema || asList(schema["enum"]).length === 1

const literalOf = (schema: Schema): unknown =>
  "const" in schema ? schema["const"] : asList(schema["enum"])[0]

// The values of an enum, written either as `enum` or as a union of literals.
export const enumValues = (v: View): unknown[] | null => {
  if (asList(v.schema["enum"]).length > 1) return asList(v.schema["enum"])
  if (v.variants.length > 1 && v.variants.every(isLiteral)) return v.variants.map(literalOf)
  return null
}

// The property whose literal tells the variants apart, when there is one.
export const discriminator = (root: Schema, variants: Schema[]): string | null => {
  const first = variants[0] && view(root, variants[0]).schema
  if (!first) return null
  for (const [key] of properties(first)) {
    const same = variants.every((variant) => {
      const prop = properties(view(root, variant).schema).find(([name]) => name === key)?.[1]
      return prop !== undefined && isLiteral(view(root, prop).schema)
    })
    if (same) return key
  }
  return null
}

export const variantLabel = (root: Schema, variant: Schema, key: string | null, index: number) => {
  const { schema } = view(root, variant)
  if (key) {
    const prop = properties(schema).find(([name]) => name === key)?.[1]
    if (prop) return String(literalOf(view(root, prop).schema))
  }
  if (typeof schema["title"] === "string") return schema["title"]
  return typeLabel(root, view(root, schema)) === "object"
    ? `variant ${index + 1}`
    : typeLabel(root, view(root, schema))
}

export const typeLabel = (root: Schema, v: View, depth = 0): string => {
  const s = v.schema
  if (enumValues(v)) return "enum"
  if (v.variants.length > 1) return "union"
  if (isLiteral(s)) return "literal"
  if (Array.isArray(s["type"])) return s["type"].join(" | ")
  const type = s["type"]
  if (type === "array") {
    if (Array.isArray(s["prefixItems"])) return "tuple"
    const items = isSchema(s["items"]) ? s["items"] : null
    return items && depth < 2 ? `array<${typeLabel(root, view(root, items), depth + 1)}>` : "array"
  }
  if (type === "object" || properties(s).length) {
    if (!properties(s).length && isSchema(s["additionalProperties"]))
      return `map<${typeLabel(root, view(root, s["additionalProperties"]), depth + 1)}>`
    return "object"
  }
  if (typeof type === "string") return type
  return Object.keys(s).length ? "unknown" : "any"
}

const safe = (value: unknown) =>
  typeof value === "number" && Math.abs(value) < Number.MAX_SAFE_INTEGER

const range = (low: unknown, high: unknown, label: string): string | null => {
  const lo = safe(low) ? String(low) : null
  const hi = safe(high) ? String(high) : null
  if (lo && hi) return `${label} ${lo === hi ? lo : `${lo}–${hi}`}`
  if (lo) return `${label} ${lo}+`
  return hi ? `${label} ≤ ${hi}` : null
}

export const constraints = (v: View): string[] => {
  const s = v.schema
  const out: string[] = []
  if (typeof s["format"] === "string") out.push(s["format"])
  const len = range(s["minLength"], s["maxLength"], "len")
  if (len) out.push(len)
  const items = range(s["minItems"], s["maxItems"], "items")
  if (items) out.push(items)
  const value = range(s["minimum"], s["maximum"], "range")
  if (value) out.push(value)
  if (safe(s["exclusiveMinimum"])) out.push(`> ${String(s["exclusiveMinimum"])}`)
  if (safe(s["exclusiveMaximum"])) out.push(`< ${String(s["exclusiveMaximum"])}`)
  if (safe(s["multipleOf"])) out.push(`step ${String(s["multipleOf"])}`)
  if (typeof s["pattern"] === "string" && !s["format"]) out.push(`/${s["pattern"]}/`)
  if ("const" in s) out.push(`= ${JSON.stringify(s["const"])}`)
  if ("default" in s) out.push(`default ${JSON.stringify(s["default"])}`)
  if (v.nullable) out.push("nullable")
  if (s["uniqueItems"] === true) out.push("unique")
  return out
}

const uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"

export const example = (root: Schema, input: Schema, depth = 0): unknown => {
  const v = view(root, input)
  const s = v.schema
  if (depth > 5) return null
  if ("const" in s) return s["const"]
  if ("default" in s) return s["default"]
  if (Array.isArray(s["enum"])) return s["enum"][0]
  if (v.variants.length) return example(root, v.variants[0]!, depth + 1)
  const type = Array.isArray(s["type"]) ? s["type"][0] : s["type"]
  if (properties(s).length || type === "object") {
    const out: Record<string, unknown> = {}
    for (const [name, prop] of properties(s)) out[name] = example(root, prop, depth + 1)
    if (!properties(s).length && isSchema(s["additionalProperties"]))
      out["key"] = example(root, s["additionalProperties"], depth + 1)
    return out
  }
  if (type === "array") {
    if (Array.isArray(s["prefixItems"]))
      return schemas(s["prefixItems"]).map((item) => example(root, item, depth + 1))
    return isSchema(s["items"]) ? [example(root, s["items"], depth + 1)] : []
  }
  if (type === "integer" || type === "number") {
    if (typeof s["minimum"] === "number" && safe(s["minimum"])) return s["minimum"]
    if (typeof s["exclusiveMinimum"] === "number") return s["exclusiveMinimum"] + 1
    if (typeof s["maximum"] === "number" && s["maximum"] < 0) return s["maximum"]
    return 0
  }
  if (type === "boolean") return true
  if (type === "null") return null
  if (type === "string") {
    switch (s["format"]) {
      case "uuid":
        return uuid
      case "date-time":
        return "2026-10-12T09:30:00.000Z"
      case "date":
        return "2026-10-12"
      case "email":
        return "user@example.com"
      case "uri":
      case "url":
        return "https://example.com"
      default: {
        const min = typeof s["minLength"] === "number" ? s["minLength"] : 0
        return "string".padEnd(Math.min(min, 64), "x")
      }
    }
  }
  return null
}

const indentOf = (level: number) => "  ".repeat(level)

// The schema as a TypeScript type, objects spread over lines.
export const tsType = (root: Schema, input: Schema, level = 0, depth = 0): string => {
  const v = view(root, input)
  const s = v.schema
  const nullable = v.nullable ? " | null" : ""
  if (depth > 8) return "unknown"
  const values = enumValues(v)
  if (values) return values.map((each) => JSON.stringify(each)).join(" | ") + nullable
  if (v.variants.length > 1) {
    const parts = v.variants.map((each) => tsType(root, each, level + 1, depth + 1))
    const multi = parts.some((part) => part.includes("\n"))
    return multi
      ? parts.map((part) => `\n${indentOf(level + 1)}| ${part}`).join("") +
          (v.nullable ? `\n${indentOf(level + 1)}| null` : "")
      : parts.join(" | ") + nullable
  }
  if ("const" in s) return JSON.stringify(s["const"]) + nullable
  if (Array.isArray(s["enum"]))
    return s["enum"].map((each) => JSON.stringify(each)).join(" | ") + nullable
  const type = Array.isArray(s["type"]) ? s["type"] : [s["type"]]
  if (type.length > 1) return type.map(String).join(" | ") + nullable
  switch (type[0]) {
    case "string":
      return "string" + nullable
    case "integer":
    case "number":
      return "number" + nullable
    case "boolean":
      return "boolean" + nullable
    case "null":
      return "null"
    case "array": {
      if (Array.isArray(s["prefixItems"]))
        return `[${schemas(s["prefixItems"])
          .map((each) => tsType(root, each, level, depth + 1))
          .join(", ")}]${nullable}`
      const inner = isSchema(s["items"]) ? tsType(root, s["items"], level, depth + 1) : "unknown"
      return (/[|\n]/.test(inner) ? `Array<${inner}>` : `${inner}[]`) + nullable
    }
    default: {
      const props = properties(s)
      if (!props.length) {
        if (isSchema(s["additionalProperties"]))
          return `Record<string, ${tsType(root, s["additionalProperties"], level, depth + 1)}>${nullable}`
        return (type[0] === "object" ? "Record<string, never>" : "unknown") + nullable
      }
      const required = requiredOf(s)
      const lines = props.map(
        ([name, prop]) =>
          `${indentOf(level + 1)}${/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${tsType(root, prop, level + 1, depth + 1)}`,
      )
      return `{\n${lines.join("\n")}\n${indentOf(level)}}${nullable}`
    }
  }
}

// A value as a JavaScript literal: unquoted keys, two-space indent.
export const jsLiteral = (value: unknown, level = 0): string => {
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    const flat = value.map((each) => jsLiteral(each, level + 1))
    return flat.every((each) => !each.includes("\n")) && flat.join(", ").length < 48
      ? `[${flat.join(", ")}]`
      : `[\n${flat.map((each) => indentOf(level + 1) + each).join(",\n")},\n${indentOf(level)}]`
  }
  if (isSchema(value)) {
    const entries = Object.entries(value)
    if (!entries.length) return "{}"
    return `{\n${entries
      .map(
        ([key, each]) =>
          `${indentOf(level + 1)}${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${jsLiteral(each, level + 1)}`,
      )
      .join(",\n")},\n${indentOf(level)}}`
  }
  return JSON.stringify(value) ?? "undefined"
}
