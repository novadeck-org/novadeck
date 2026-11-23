import { describe, expect, it } from "vitest"

import { classifyInput } from "./takeover.js"

describe("classifying the input of an observed terminal", () => {
  it.each([
    ["a typed letter", "a", "text"],
    ["typed text", "héllo ", "text"],
    ["a space", " ", "text"],
    ["an emoji", "😀", "text"],
    ["a bracketed paste", "\u001b[200~ls -la\r\u001b[201~", "text"],
    ["a paste outside bracketed mode", "echo hi\rls", "text"],
    ["Enter", "\r", "key"],
    ["Esc", "\u001b", "key"],
    ["Tab", "\t", "key"],
    ["Backspace", "\u007f", "key"],
    ["an arrow", "\u001b[A", "key"],
    ["an application arrow", "\u001bOA", "key"],
    ["Page Down", "\u001b[6~", "key"],
    ["a Ctrl chord", "\u0004", "key"],
    ["Ctrl+C", "\u0003", "key"],
    ["an Alt chord", "\u001bb", "key"],
    ["a mouse report", "\u001b[<0;10;5M", "report"],
    ["a focus report", "\u001b[I", "report"],
    ["a cursor position answer", "\u001b[12;40R", "report"],
    ["a colour answer", "\u001b]10;rgb:ffff/ffff/ffff\u001b\\", "report"],
  ])("takes %s as %s", (_name, data, kind) => {
    expect(classifyInput(data)).toBe(kind)
  })
})
