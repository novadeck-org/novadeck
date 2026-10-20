import { describe, expect, it } from "vitest"

import { cleaned, clip, loggedError, logSchema, textLimit } from "./envelope.js"
import { createRedactor } from "./redact.js"

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

describe("cleaned", () => {
  it("redacts no more of a long text than four times what it keeps", () => {
    const seen: number[] = []
    const result = cleaned("word ".repeat(2 * textLimit), (text) => {
      seen.push(text.length)
      return text
    })
    expect(seen).toEqual([4 * textLimit])
    expect(result).toHaveLength(textLimit)
    expect(result.endsWith("…")).toBe(true)
  })

  it("reads a long JSON text to the last field it holds whole", () => {
    const redact = createRedactor({ salt: "s".repeat(32) })
    const fields = '{"id":1234567,"ok":true},'.repeat((4 * textLimit) / 25 - 1)
    const result = cleaned(
      `[${fields}{"t":"AKIAIOSFODNN7EXAMPLE"}]`.slice(0, 4 * textLimit + 9),
      redact,
    )
    expect(result.startsWith('[{"id":1234567,"ok":true},')).toBe(true)
    expect(result).not.toMatch(/AKIA/)
  })

  it("reads none of a long text with nothing but a word in it", () => {
    expect(cleaned("x".repeat(10 * textLimit), (text) => text)).toBe("…")
  })

  it("marks a text it read only part of as cut, though redacting shortened it", () => {
    expect(cleaned("word ".repeat(2 * textLimit), () => "short")).toBe("short…")
  })

  it("keeps nothing of a secret the read cut short", () => {
    const redact = createRedactor({ salt: "s".repeat(32) })
    // A hex run that redacts to almost nothing, then a key cut by the read at its 10th character.
    const hex = "0123456789abcdef".repeat(125).slice(0, 4 * textLimit - 10)
    const result = cleaned(`${hex} AKIAIOSFODNN7EXAMPLE after`, redact)
    expect(result).toBe("<secret> …")
  })

  it("keeps a short text whole", () => {
    expect(cleaned("token=abc", (text) => text.replace("abc", "<redacted>"))).toBe(
      "token=<redacted>",
    )
  })
})

describe("logSchema", () => {
  it("is the first version", () => {
    expect(logSchema).toBe(1)
  })
})
