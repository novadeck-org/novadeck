import { describe, expect, it } from "vitest"

import { clip, keep, loggedError, logSchema, textLimit } from "./envelope.js"

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

  it("redacts the name and code an error gives itself", () => {
    const error = Object.assign(new Error("x"), { code: "/home/ana/acme" })
    error.name = "AcmeError /home/ana/acme"
    const logged = loggedError(error, (text) => text.replaceAll("/home/ana", "~"))
    expect(logged.name).toBe("AcmeError ~/acme")
    expect(logged.code).toBe("~/acme")
  })

  it("cuts a long message to size", () => {
    const logged = loggedError(new Error("x".repeat(2_000)), same)
    expect(logged.message).toHaveLength(textLimit)
    expect(logged.message.endsWith("…")).toBe(true)
  })

  it("keeps an error whose name, message or stack was set to something other than text", () => {
    const error = new Error("x")
    Object.assign(error, { name: 42, message: { toString: () => "told" }, stack: {} })
    expect(loggedError(error, same)).toEqual({
      name: "42",
      message: "told",
      stack: "[object Object]",
    })
  })

  it("keeps an error whose name can't be made text", () => {
    const error = Object.assign(new Error("x"), { name: Object.create(null) as object })
    expect(loggedError(error, same)).toEqual({ name: "Error", message: "x" })
  })

  it("withholds a syntax error's quote where it has no stack", () => {
    const error = new SyntaxError("Unexpected token 'a', \"abc\" is not valid JSON")
    Object.defineProperty(error, "stack", { value: undefined })
    expect(loggedError(error, same)).toEqual({
      name: "SyntaxError",
      message: "Unexpected token (input withheld)",
    })
  })

  it("keeps only the type of anything thrown that is not an Error", () => {
    expect(loggedError("the person's prompt", same)).toEqual({
      name: "string",
      message: "A non-Error was thrown",
    })
  })
})

describe("keep", () => {
  it("redacts no more than a bounded part of a long text", () => {
    let read = 0
    const kept = keep(`${"word ".repeat(1_000_000)}`, (text) => {
      read = text.length
      return text
    })
    expect(read).toBeLessThanOrEqual(8_000)
    expect(kept).toHaveLength(textLimit)
  })

  it("cuts before a word that runs past what it reads, so no secret is read cut short", () => {
    const secret = "sk-proj-abcdefghijklmnop1234"
    const text = `${"a ".repeat(3_995)}${secret} after`
    // A redactor that keeps little of the text, so what it reads last is what the line keeps.
    const kept = keep(text, (read) => read.replaceAll("a ", "").replaceAll(secret, "<secret>"))
    expect(kept).toBe("…")
  })

  it("cuts a single word longer than it reads where it stops", () => {
    expect(keep("x".repeat(20_000), (text) => `${text.length}`)).toBe("8000…")
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
