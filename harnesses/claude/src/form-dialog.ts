import type {
  AnswerableDialog,
  DialogRead,
  KeyStep,
  RequestFacts,
} from "@novadeck/harness-core/dialogs"
import type { RequestAnswer } from "@novadeck/protocol"

import { elicitationTool } from "./decode.js"
import {
  Down,
  Enter,
  fieldsOf,
  flat,
  idle,
  nonBlank,
  quoted,
  Right,
  settled,
  typeable,
  wraps,
} from "./dialog-screen.js"

/**
 * Claude Code's form for an MCP server's elicitation: its message over a row per field,
 * then Accept and Decline. The form handles keys against what it drew last, so every
 * step waits for the screen to hold still showing what the next one needs.
 */

type FormField = {
  readonly id: string
  readonly label: string
  readonly description: string | null
  readonly kind: "text" | "number" | "boolean" | "choice"
  readonly choices: readonly string[]
  readonly required: boolean
}
type Form = { readonly server: string; readonly message: string; readonly fields: FormField[] }

/**
 * The form an Elicitation hook asked, when it is one this reads: a text, number, boolean
 * or enum (of strings) field, each with a title and at most a description. Anything the
 * probes didn't draw (formats, limits, defaults, other types) is not read.
 */
const formOf = (input: unknown): Form | undefined => {
  const fields = fieldsOf(input)
  const server = nonBlank(fields?.mcp_server_name)
  const message = nonBlank(fields?.message)
  const schema = fieldsOf(fields?.requested_schema)
  const properties = fieldsOf(schema?.properties)
  if (!fields || !server || !message || fields.mode !== "form" || !schema || !properties) {
    return undefined
  }
  if (Object.keys(schema).some((key) => !["type", "properties", "required"].includes(key))) {
    return undefined
  }
  const required = schema.required === undefined ? [] : schema.required
  if (schema.type !== "object" || !Array.isArray(required)) return undefined
  if (required.some((each) => typeof each !== "string" || !(each in properties))) return undefined
  const ids = Object.keys(properties)
  if (ids.length < 1 || ids.length > 8 || server.includes("\n")) return undefined
  const read: FormField[] = []
  for (const id of ids) {
    const each = fieldsOf(properties[id])
    const label = nonBlank(each?.title)
    if (!each || !label || label.includes("\n")) return undefined
    if (Object.keys(each).some((key) => !["type", "title", "description", "enum"].includes(key))) {
      return undefined
    }
    if (each.description !== undefined && !nonBlank(each.description)) return undefined
    const description = (each.description as string | undefined) ?? null
    const enums = each.enum
    if (enums !== undefined) {
      const listed = Array.isArray(enums) ? (enums as unknown[]) : []
      if (each.type !== "string" || listed.length < 1 || listed.length > 32) return undefined
      if (listed.some((value) => !nonBlank(value) || (value as string).includes("\n"))) {
        return undefined
      }
      if (new Set(listed).size !== listed.length) return undefined
      read.push({
        id,
        label,
        description,
        kind: "choice",
        choices: listed as string[],
        required: required.includes(id),
      })
      continue
    }
    const kind = { string: "text", number: "number", boolean: "boolean" }[String(each.type)] as
      | "text"
      | "number"
      | "boolean"
      | undefined
    if (!kind) return undefined
    read.push({ id, label, description, kind, choices: [], required: required.includes(id) })
  }
  return { server, message, fields: read }
}

type FieldState = {
  readonly highlighted: boolean
  readonly status: string
  readonly value: string
  readonly lines: readonly string[]
  /** An enum's rows, once expanded. */
  readonly options: readonly { readonly highlighted: boolean; readonly label: string }[]
}
type FormScreen = {
  readonly fields: readonly FieldState[]
  readonly buttons: "accept" | "decline" | null
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const formButtons = /^ {2}(?:❯ | {2})Accept(?: {4}| {2}❯ )Decline$/
const formOptionRow = /^ {8}(❯ | {2})◯ (.+)$/
const formFooter = "  Esc to cancel · ↑/↓ to navigate"
// A form's waits take the screen holding still on top of the keys landing.
const formTimeoutMs = 5000

/** The row where a field opens: its marker, status and label, then what it holds. */
const fieldRow = (field: FormField) =>
  new RegExp(`^ {2}(❯| ) ([*✔⚠ ]) ${escaped(field.label)}: (.*)$`)

/** The form on screen, row by row, in the order of its fields; undefined unless all of it reads. */
const formScreen = (rows: readonly string[], form: Form): FormScreen | undefined => {
  const heading = rows.findLastIndex(
    (each) => each === `  MCP server “${form.server}” requests your input`,
  )
  if (heading < 0) return undefined
  const after = rows.slice(heading + 1)
  const first = after.findIndex((each) => fieldRow(form.fields[0]!).test(each))
  if (first < 0 || !wraps(quoted(after.slice(0, first)), form.message)) return undefined
  const states: FieldState[] = []
  let at = first
  for (const [index, field] of form.fields.entries()) {
    const match = fieldRow(field).exec(after[at] ?? "")
    if (!match) return undefined
    const lines: string[] = []
    const options: { highlighted: boolean; label: string }[] = []
    at++
    const next = form.fields[index + 1]
    for (; at < after.length; at++) {
      const row = after[at]!
      if (row === "") continue
      if (formButtons.test(row) || (next && fieldRow(next).test(row))) break
      const choice = formOptionRow.exec(row)
      if (choice) options.push({ highlighted: choice[1] === "❯ ", label: choice[2]! })
      else if (/^ {8}\S/.test(row)) lines.push(row.trim())
      else return undefined
    }
    states.push({
      highlighted: match[1] === "❯",
      status: match[2]!,
      value: match[3]!,
      lines,
      options,
    })
  }
  const row = after[at] ?? ""
  if (!formButtons.test(row)) return undefined
  const footer = after.slice(at + 1).filter((each) => each !== "")
  if (footer.length !== 1 || !footer[0]!.startsWith(formFooter)) return undefined
  return {
    fields: states,
    buttons: row.includes("❯ Accept") ? "accept" : row.includes("❯ Decline") ? "decline" : null,
  }
}

// What a highlighted field holds before anything is entered, by its kind, as the probes
// drew them; any other reads "not set".
const blank: Readonly<Record<FormField["kind"], string>> = {
  text: "Type something…",
  number: "Type something…",
  boolean: "☐",
  choice: "▸ not set",
}

// Whether the rows under a field's own are its description, and nothing else.
const described = (field: FormField, state: FieldState): boolean =>
  flat(state.lines.join("")) === (field.description === null ? "" : flat(field.description))

// What each field reads as before anything is entered, by its kind and whether it is
// highlighted.
const untouched = (field: FormField, state: FieldState, highlighted: boolean): boolean => {
  return (
    state.highlighted === highlighted &&
    state.status === (field.required ? "*" : " ") &&
    state.value === (highlighted ? blank[field.kind] : "not set") &&
    state.options.length === 0 &&
    described(field, state)
  )
}

const onField = (index: number) => (screen: FormScreen) =>
  screen.fields.every((each, at) => each.highlighted === (at === index)) && screen.buttons === null

const formKeys = (form: Form, answer: RequestAnswer): readonly KeyStep[] | undefined => {
  if (answer.type !== "form") return undefined
  const { fields } = form
  const given = answer.action === "accept" ? answer.values : {}
  // A field as the answer leaves it: its value shown and valid, or untouched.
  const finished = (field: FormField, state: FieldState): boolean => {
    const value = given[field.id]
    if (value === undefined) return untouched(field, state, state.highlighted)
    if (state.status !== "✔" || !described(field, state)) return false
    switch (field.kind) {
      case "text":
        return typeof value === "string" && state.value.startsWith(value.trimStart().slice(0, 20))
      case "number":
        return state.value === String(value)
      case "boolean":
        return state.value === (value ? "☒" : "☐")
      default:
        // Highlighted, a chosen enum reads `▸ green`; not, plain `green`.
        return state.value === String(value) || state.value === `▸ ${String(value)}`
    }
  }
  // Every field but `current` is as it should be by then: those before it finished, those
  // after it untouched, so a key that landed on the wrong field fails the wait.
  const others = (screen: FormScreen, current: number): boolean =>
    fields.every((field, at) => {
      const state = screen.fields[at]!
      if (at === current) return true
      return at < current ? finished(field, state) : untouched(field, state, state.highlighted)
    })
  const wait = (test: (screen: FormScreen) => boolean, why: string, current: number): KeyStep => ({
    until: settled((rows) => {
      const screen = formScreen(rows, form)
      return screen !== undefined && others(screen, current) && test(screen)
    }),
    timeoutMs: formTimeoutMs,
    why,
  })
  const steps: KeyStep[] = []
  const toButtons = (): void => {
    for (let index = 0; index < fields.length; index++) {
      steps.push({ press: Down })
      steps.push(
        index + 1 < fields.length
          ? wait(onField(index + 1), `field ${index + 2} highlighted`, index + 1)
          : wait((screen) => screen.buttons === "accept", "Accept highlighted", fields.length),
      )
    }
  }

  if (answer.action === "decline") {
    if (Object.keys(answer.values).length > 0) return undefined
    toButtons()
    steps.push({ press: Right })
    steps.push(wait((screen) => screen.buttons === "decline", "Decline highlighted", fields.length))
    steps.push({ press: Enter })
    return steps
  }

  const known = new Set(fields.map(({ id }) => id))
  if (Object.keys(answer.values).some((id) => !known.has(id))) return undefined
  if (fields.some(({ id, required }) => required && !(id in answer.values))) return undefined
  for (const [index, field] of fields.entries()) {
    const value = answer.values[field.id]
    if (value !== undefined) {
      const row = (screen: FormScreen) => screen.fields[index]!
      if (field.kind === "text") {
        if (typeof value !== "string" || value === "" || !typeable(value)) return undefined
        const start = value.trimStart().slice(0, 20)
        steps.push({ type: value })
        steps.push(
          wait(
            (screen) => row(screen).status === "✔" && row(screen).value.startsWith(start),
            `the words in field ${index + 1}`,
            index,
          ),
        )
      } else if (field.kind === "number") {
        if (typeof value !== "number" || !/^-?\d+(?:\.\d+)?$/.test(String(value))) return undefined
        steps.push({ type: String(value) })
        steps.push(
          wait(
            (screen) => row(screen).status === "✔" && row(screen).value === String(value),
            `the number in field ${index + 1}`,
            index,
          ),
        )
      } else if (field.kind === "boolean") {
        if (typeof value !== "boolean") return undefined
        // Space ticks an untouched one (true); once more clears it (false).
        steps.push({ press: " " })
        steps.push(
          wait(
            (screen) => row(screen).status === "✔" && row(screen).value === "☒",
            `field ${index + 1} ticked`,
            index,
          ),
        )
        if (!value) {
          steps.push({ press: " " })
          steps.push(
            wait(
              (screen) => row(screen).status === "✔" && row(screen).value === "☐",
              `field ${index + 1} cleared`,
              index,
            ),
          )
        }
      } else {
        const at = typeof value === "string" ? field.choices.indexOf(value) : -1
        if (at < 0) return undefined
        steps.push({ press: Right })
        steps.push(
          wait(
            (screen) =>
              row(screen).value === "▾" &&
              row(screen).options.length === field.choices.length &&
              row(screen).options.every((each, option) => each.label === field.choices[option]) &&
              row(screen).options[0]!.highlighted,
            `field ${index + 1} expanded`,
            index,
          ),
        )
        for (let step = 1; step <= at; step++) {
          steps.push({ press: Down })
          steps.push(
            wait(
              (screen) => row(screen).options[step]?.highlighted === true,
              `choice ${step + 1} highlighted`,
              index,
            ),
          )
        }
        steps.push({ press: " " })
        steps.push(
          wait(
            (screen) => row(screen).status === "✔" && row(screen).value === `▸ ${value}`,
            `field ${index + 1} set`,
            index,
          ),
        )
      }
    }
    steps.push({ press: Down })
    steps.push(
      index + 1 < fields.length
        ? wait(onField(index + 1), `field ${index + 2} highlighted`, index + 1)
        : wait((screen) => screen.buttons === "accept", "Accept highlighted", fields.length),
    )
  }
  // On Accept with every field as the answer says: the wait above checked them all.
  steps.push({ press: Enter })
  return steps
}

export const forms = (rows: readonly string[], facts: RequestFacts): DialogRead | undefined => {
  if (facts.kind !== "question" || !facts.tool.startsWith("mcp__")) return undefined
  const form = formOf(facts.input)
  if (!form || facts.tool !== elicitationTool(form.server)) return undefined
  const screen = formScreen(rows, form)
  if (!screen || screen.buttons !== null) return undefined
  // As the probes drew it: the first field highlighted, nothing entered, nothing shown
  // below or above the fields that isn't the form.
  if (!form.fields.every((field, index) => untouched(field, screen.fields[index]!, index === 0))) {
    return undefined
  }
  const dialog: AnswerableDialog = {
    type: "form",
    message: form.message,
    fields: form.fields.map(({ id, label, description, kind, choices: listed, required }) => ({
      id,
      label,
      description,
      kind,
      choices: [...listed],
      required,
    })),
  }
  return {
    dialog,
    keys: (answer) => formKeys(form, answer),
    // Gone: the form's heading no longer shows, and the prompt is back.
    answered: (later) =>
      idle(later) &&
      !later.some((each) => each === `  MCP server “${form.server}” requests your input`),
  }
}
