import { describe, expect, it } from "vitest"

import { doorbell, doorbellLine, doorbellNonce, quotedLine } from "./prompts.js"

// What a prompt starts and how a stale line is left out are tested with the harnesses, in
// the runner's harnesses/answers.test.ts; this pins the line itself.
describe("the doorbell line", () => {
  const bell = doorbellLine("Ab12")

  it("is Novadeck's notice with its nonce", () => {
    expect(bell).toBe("[Novadeck: automatic notice, agent messages waiting, Ab12]")
  })

  it("takes only letters and digits as a nonce", () => {
    expect(doorbellNonce(doorbellLine("a-b"))).toBeUndefined()
  })

  it("is found wherever it is in a text, as often as it is there", () => {
    expect(`one ${bell} two ${doorbellLine("Cd34")}`.match(doorbell)).toHaveLength(2)
  })
})

describe("quotedLine", () => {
  it("quotes a doorbell line and the plain words a launch line holds", () => {
    const line = doorbellLine("abc123")
    expect(quotedLine(line)).toBe(`"${line}"`)
    expect(quotedLine("gpt-6.1-sol")).toBe('"gpt-6.1-sol"')
  })

  it("refuses any character a shell expands or ends a word at", () => {
    for (const bad of [
      "$(id)",
      "`id`",
      "a\\b",
      'a"b',
      "a!b",
      "100%",
      "a^b",
      "a&b",
      "a;b",
      "a|b",
      "a\nb",
      "a'b",
      "~",
      "*",
    ])
      expect(() => quotedLine(bad), bad).toThrow(RangeError)
  })
})
