import { describe, expect, it } from "vitest"

import { clip, loggedError, logSchema, textLimit } from "./envelope.js"

const same = (text: string): string => text

describe("loggedError", () => {
  it("keeps an error's name, message, stack and code", () => {
    const error = Object.assign(new Error("no such file"), { code: "ENOENT" })
    expect(loggedError(error, same)).toEqual({
      name: "Error",
      message: "no such file",
      stack: error.stack,
      code: "ENOENT",
    })
  })

  it("redacts the message and the stack", () => {
    const error = new Error("open /home/ana/x")
    error.stack = "Error: open /home/ana/x\n    at read (/home/ana/a.ts:1:2)"
    const logged = loggedError(error, (text) => text.replaceAll("/home/ana", "~"))
    expect(logged.message).toBe("open ~/x")
    expect(logged.stack).toBe("Error: open ~/x\n    at read (~/a.ts:1:2)")
  })

  it("keeps none of the input a JSON syntax error quotes", () => {
    const body = '{"to": "@fox", "text": "the launch codes are 0000'
    let thrown: unknown
    try {
      JSON.parse(body)
    } catch (error) {
      thrown = error
    }
    const logged = loggedError(thrown, same)
    expect(logged.name).toBe("SyntaxError")
    expect(logged.message).not.toContain("launch codes")
    expect(logged.stack).not.toContain("launch codes")
    expect(JSON.stringify(logged)).not.toContain("@fox")
  })

  it("keeps none of a quoted token either", () => {
    let thrown: unknown
    try {
      JSON.parse("hello secret")
    } catch (error) {
      thrown = error
    }
    expect(loggedError(thrown, same).message).toBe("Unexpected token (input withheld)")
  })

  it("keeps where in its input a JSON syntax error failed", () => {
    let thrown: unknown
    try {
      JSON.parse('{"a": 1 "b"}')
    } catch (error) {
      thrown = error
    }
    expect(loggedError(thrown, same).message).toBe(
      "Expected (input withheld; in JSON at position 8 (line 1 column 9))",
    )
  })

  it("cuts a long message to size", () => {
    const logged = loggedError(new Error("x".repeat(2_000)), same)
    expect(logged.message).toHaveLength(textLimit)
    expect(logged.message.endsWith("…")).toBe(true)
  })

  it("keeps only the type of anything thrown that is not an Error", () => {
    expect(loggedError("the person's prompt", same)).toEqual({
      name: "string",
      message: "A non-Error was thrown",
    })
  })
})

describe("clip", () => {
  it("leaves short text as it is", () => {
    expect(clip("short")).toBe("short")
  })
})

describe("logSchema", () => {
  it("is the first version", () => {
    expect(logSchema).toBe(1)
  })
})
