import type { ChatFormField } from "@novadeck/core/conversation"

import { entryValid, enter, formAnswer, formComplete, keptEntries, type Entries } from "./forms"
import { describe, expect, it } from "./test"

const field = (overrides: Partial<ChatFormField> & { id: string }): ChatFormField => ({
  label: overrides.id,
  description: null,
  kind: "text",
  choices: [],
  required: false,
  ...overrides,
})

const fields = [
  field({ id: "name", required: true }),
  field({ id: "env", kind: "choice", choices: ["staging", "production"], required: true }),
  field({ id: "replicas", kind: "number" }),
  field({ id: "dry", kind: "boolean" }),
]

describe("whether a form can be accepted", () => {
  it("waits for each required field", () => {
    let entries: Entries = {}
    expect(formComplete(entries, fields)).toBe(false)
    entries = enter(entries, fields[0]!, "  ")
    entries = enter(entries, fields[1]!, "staging")
    expect(formComplete(entries, fields)).toBe(false)
    entries = enter(entries, fields[0]!, "api")
    expect(formComplete(entries, fields)).toBe(true)
  })

  it("accepts an optional number left empty but not one that isn't a number", () => {
    expect(entryValid({}, fields[2]!)).toBe(true)
    expect(entryValid(enter({}, fields[2]!, "3"), fields[2]!)).toBe(true)
    expect(entryValid(enter({}, fields[2]!, "three"), fields[2]!)).toBe(false)
  })

  it("takes a choice only from those offered", () => {
    expect(entryValid(enter({}, fields[1]!, "dev"), fields[1]!)).toBe(false)
  })
})

describe("a text field with control characters", () => {
  it("can't be accepted", () => {
    const name = field({ id: "name" })
    expect(entryValid(enter({}, name, "ok"), name)).toBe(true)
    expect(entryValid(enter({}, name, "\u001b[31mred"), name)).toBe(false)
  })
})

describe("a boolean field", () => {
  const optional = field({ id: "a", kind: "boolean" })
  const required = field({ id: "b", kind: "boolean", required: true })

  it("is unset until the person says, and a required one must be said", () => {
    expect(entryValid({}, optional)).toBe(true)
    expect(entryValid({}, required)).toBe(false)
    expect(entryValid(enter({}, required, "no"), required)).toBe(true)
  })

  it("sends yes as true and no as false, and nothing when untouched", () => {
    const entries = enter(enter({}, optional, "yes"), required, "no")
    expect(formAnswer("d", "accept", entries, [optional, required]).type).toBe("form")
    expect(formAnswer("d", "accept", entries, [optional, required])).toMatchObject({
      values: { a: true, b: false },
    })
    expect(formAnswer("d", "accept", {}, [optional])).toMatchObject({ values: {} })
  })
})

describe("the answer a form makes", () => {
  it("types the values: numbers as numbers, booleans as said, untouched optionals left out", () => {
    let entries: Entries = enter({}, fields[0]!, " api ")
    entries = enter(entries, fields[1]!, "production")
    entries = enter(entries, fields[2]!, "3")
    entries = enter(entries, fields[3]!, "no")
    expect(formAnswer("d1", "accept", entries, fields)).toEqual({
      type: "form",
      dialog: "d1",
      action: "accept",
      values: { name: "api", env: "production", replicas: 3, dry: false },
    })
    expect(
      formAnswer("d1", "accept", enter({}, fields[0]!, "x"), [fields[0]!, fields[3]!]),
    ).toEqual({ type: "form", dialog: "d1", action: "accept", values: { name: "x" } })
  })

  it("sends no values when declined", () => {
    expect(formAnswer("d1", "decline", enter({}, fields[0]!, "x"), fields)).toEqual({
      type: "form",
      dialog: "d1",
      action: "decline",
      values: {},
    })
  })
})

describe("a form that was read again", () => {
  it("keeps values of fields still there with the same kind, and a choice still offered", () => {
    let entries: Entries = enter({}, fields[0]!, "api")
    entries = enter(entries, fields[1]!, "production")
    entries = enter(entries, fields[2]!, "3")
    const next = [
      fields[0]!,
      field({ id: "env", kind: "choice", choices: ["staging"], required: true }),
      field({ id: "replicas", kind: "text" }),
    ]
    expect(Object.keys(keptEntries(entries, next))).toEqual(["name"])
  })
})
