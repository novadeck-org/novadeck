import { describe, expect, it } from "vitest"

import { fieldsOf, isFields, parseFields } from "./fields.js"

describe("a JSON object's fields", () => {
  it("are an object's own, the same object", () => {
    const input = { command: "ls" }
    expect(isFields(input)).toBe(true)
    expect(fieldsOf(input)).toBe(input)
  })

  it("are none for null, an array or anything else", () => {
    for (const value of [null, undefined, [], ["ls"], "ls", 7, true]) {
      expect(isFields(value)).toBe(false)
      expect(fieldsOf(value)).toBeUndefined()
    }
  })

  it("are read from JSON text that holds an object, and from nothing else", () => {
    expect(parseFields('{"type":"user","n":1}')).toEqual({ type: "user", n: 1 })
    expect(parseFields("[1,2]")).toBeUndefined()
    expect(parseFields('"text"')).toBeUndefined()
    expect(parseFields("{not json")).toBeUndefined()
    expect(parseFields("")).toBeUndefined()
  })
})
