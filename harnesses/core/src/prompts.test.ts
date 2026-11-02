import { describe, expect, it } from "vitest"

import {
  doorbell,
  doorbellLine,
  doorbellNonce,
  maxReplyLine,
  quotedLine,
  replyDoorbell,
  replyLine,
  withoutDoorbell,
} from "./prompts.js"

describe("the reply line", () => {
  const merge = { subject: "Merge #461 (ligatures on WebGL)?", option: "Merge it", text: "" }

  it("says the person's picked option in their voice, its nonce opening and closing it", () => {
    expect(replyLine([merge])!("Ab12")).toBe(
      '[Novadeck Inbox reply, Ab12] Re "Merge #461 (ligatures on WebGL)?": I picked "Merge it". [Ab12]',
    )
  })

  it("says their own words, alone or beside an option, and an action marked done", () => {
    const line = replyLine([
      { subject: "Merge #536 when green?", text: "yah" },
      { subject: "Which port?", option: "8080", text: "and restart it" },
      { subject: "Sign in to npm", action: "Signed in", text: "" },
    ])!("n0")
    expect(line).toBe(
      '[Novadeck Inbox reply, n0] Re "Merge #536 when green?": yah | Re "Which port?": I picked "8080" and wrote: and restart it | Re "Sign in to npm": I marked it done ("Signed in"). [n0]',
    )
  })

  it("is one line holding nothing a harness treats specially", () => {
    const line = replyLine([{ subject: "Pay $5\nto @flint?", text: "yes\r\n\tdo it @ once" }])!("n")
    expect(line).not.toMatch(/[\n\r\t@$]/)
    expect(line).toContain("Pay ＄5 to ＠flint?")
    expect(line).toContain("yes do it ＠ once")
  })

  it("stays short, cutting long parts and leaving replies past its limit to the delivery", () => {
    const long = { subject: "q".repeat(500), option: "o".repeat(500), text: "t".repeat(500) }
    const one = replyLine([long])!("AbCdEf")
    expect(one.length).toBeLessThanOrEqual(maxReplyLine)
    expect(one).toContain("...")
    const many = replyLine([merge, long, merge, merge])!("AbCdEf")
    expect(many.length).toBeLessThanOrEqual(maxReplyLine)
    expect(many).toMatch(/\| \+3 more replies below \[AbCdEf\]$/)
    // The longest first reply, with more after it, still fits.
    const worst = replyLine(Array.from({ length: 50 }, () => long))!("AbCdEf")
    expect(worst.length).toBeLessThanOrEqual(maxReplyLine)
    expect(worst).toMatch(/\| \+49 more replies below \[AbCdEf\]$/)
  })

  it("says nothing for no replies", () => {
    expect(replyLine([])).toBeUndefined()
  })

  it("is a doorbell prompt by its nonce, and left out of the person's own prompt", () => {
    const line = replyLine([merge])!("Xy9")
    expect(doorbellNonce(` ${line} `)).toBe("Xy9")
    expect(doorbellNonce(`${line} and more`)).toBeUndefined()
    expect(withoutDoorbell(`${line} also fix the tests`)).toBe("also fix the tests")
    expect(`${line}\n${replyLine([merge])!("Zz1")}`.match(replyDoorbell)).toHaveLength(2)
  })

  it("is never closed by another nonce", () => {
    expect(doorbellNonce('[Novadeck Inbox reply, Ab12] Re "x": y [Cd34]')).toBeUndefined()
  })
})

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
