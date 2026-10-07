import type { ChatAnswer, ChatFormField } from "../../model/conversation"
import { hasControlCharacters } from "../../model/prompt-refusal"

// What the person has put into a form's fields, as typed (text and numbers as strings), and
// the values it makes. Pure, so the form's rules read apart from its markup.

// A boolean is `"yes"`, `"no"` or, until the person says, `""`.
export type Entry = { readonly kind: ChatFormField["kind"]; readonly value: string }
export type Entries = Readonly<Record<string, Entry>>

const blank = (field: ChatFormField): Entry => ({
  kind: field.kind,
  value: "",
})

export const entryOf = (entries: Entries, field: ChatFormField): Entry => {
  const entry = entries[field.id]
  return entry && entry.kind === field.kind ? entry : blank(field)
}

export const enter = (entries: Entries, field: ChatFormField, value: string): Entries => ({
  ...entries,
  [field.id]: { kind: field.kind, value },
})

// What stays of the entries once the form is read again: a field that is still there with
// the same kind keeps its value, a choice only if it is still offered.
export const keep = (entries: Entries, fields: readonly ChatFormField[]): Entries =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const entry = entries[field.id]
      if (!entry || entry.kind !== field.kind) return []
      if (field.kind === "choice" && !field.choices.includes(entry.value)) return []
      return [[field.id, entry]]
    }),
  )

const text = (entry: Entry): string => entry.value.trim()

const numeric = (value: string): boolean => value !== "" && Number.isFinite(Number(value))

// A field is fine when it holds a value of its kind, or is optional and empty.
export const valid = (entries: Entries, field: ChatFormField): boolean => {
  const entry = entryOf(entries, field)
  const value = text(entry)
  if (field.kind === "text" && hasControlCharacters(entry.value)) return false
  if (value === "") return !field.required
  if (field.kind === "boolean") return value === "yes" || value === "no"
  if (field.kind === "number") return numeric(value)
  if (field.kind === "choice") return field.choices.includes(value)
  return true
}

export const complete = (entries: Entries, fields: readonly ChatFormField[]): boolean =>
  fields.every((field) => valid(entries, field))

// The answer to send: a value per field, numbers as numbers, booleans as yes or no,
// anything only where something was entered.
export const formAnswer = (
  dialog: string,
  action: "accept" | "decline",
  entries: Entries,
  fields: readonly ChatFormField[],
): ChatAnswer => {
  const values: Record<string, string | number | boolean> = {}
  if (action === "accept")
    for (const field of fields) {
      const entry = entryOf(entries, field)
      const value = text(entry)
      if (value === "") continue
      values[field.id] =
        field.kind === "number" ? Number(value) : field.kind === "boolean" ? value === "yes" : value
    }
  return { type: "form", dialog, action, values }
}
