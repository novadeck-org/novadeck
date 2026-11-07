import { doorbellLine, replyLine } from "@novadeck/harness-core/prompts"

import { describe, expect, it } from "../test.js"
import {
  inBox,
  knownWords,
  missingAt,
  promptLines,
  settledBy,
  type Turns,
} from "./receipt-match.js"

const waiting = (...texts: string[]) =>
  texts.map((text, index) => ({ ref: `r${index}`, lines: promptLines(text) }))

describe("promptLines", () => {
  it("takes line breaks as line feeds and drops blank edges and trailing white space", () => {
    expect(promptLines("\r\n  one  \r\ntwo\t\r\n\r\n")).toEqual(["one", "two"])
  })

  it("strips a doorbell line and an Inbox reply line", () => {
    const reply = replyLine([{ subject: "Colour", text: "green" }])!("abc123")
    expect(promptLines(`do the thing ${doorbellLine("n0nce1")}`)).toEqual(["do the thing"])
    expect(promptLines(`${reply}\nand more`)).toEqual(["and more"])
  })

  it("reads a shell send as the command beside its bang", () => {
    expect(promptLines("!  npm test")).toEqual(["!npm test"])
  })

  it("has no lines for text with no words", () => {
    expect(promptLines(`  \n${doorbellLine("n0nce1")}\n`)).toEqual([])
  })
})

describe("settledBy", () => {
  it("settles a prompt the item holds exactly", () => {
    expect(settledBy(waiting("fix the build"), "fix the build")).toEqual(["r0"])
  })

  it("settles a multi-line prompt by its run of lines", () => {
    const text = "first\nsecond\nthird"
    expect(settledBy(waiting(text), "intro\nfirst\nsecond\nthird\noutro")).toEqual(["r0"])
    expect(settledBy(waiting(text), "first\nthird")).toEqual([])
  })

  it("settles two sends an Antigravity item joined by a line break, in order", () => {
    expect(settledBy(waiting("one", "two"), "one\ntwo")).toEqual(["r0", "r1"])
  })

  it("settles only the first of two sends the item holds out of order", () => {
    expect(settledBy(waiting("one", "two"), "two\none")).toEqual(["r0"])
  })

  it("matches through a doorbell line and an Inbox reply line beside the words", () => {
    const reply = replyLine([{ subject: "Colour", text: "green" }])!("abc123")
    const item = `${doorbellLine("n0nce1")}\nship it\n${reply}`
    expect(settledBy(waiting("ship it"), item)).toEqual(["r0"])
  })

  it("matches a CRLF send against an LF item and the other way round", () => {
    expect(settledBy(waiting("a\r\nb"), "a\nb")).toEqual(["r0"])
    expect(settledBy(waiting("a\nb"), "a\r\nb")).toEqual(["r0"])
  })

  it("matches a shell send with spaces after the bang to the item without them", () => {
    expect(settledBy(waiting("!  npm test"), "!npm test")).toEqual(["r0"])
  })

  it("lets a skipped first send hold back none sent after it", () => {
    expect(settledBy(waiting("never recorded", "recorded"), "recorded")).toEqual(["r1"])
  })

  it("settles only the first of two identical sends against one item", () => {
    expect(settledBy(waiting("ok", "ok"), "ok")).toEqual(["r0"])
  })

  it("settles both identical sends an item holds twice", () => {
    expect(settledBy(waiting("ok", "ok"), "ok\nok")).toEqual(["r0", "r1"])
  })
})

describe("inBox", () => {
  it("finds words the box wraps or indents", () => {
    const box = "> deploy the\n    staging build and\n  tell me"
    expect(inBox(box, ["deploy the staging build", "and tell me"])).toBe(true)
  })

  it("finds words among a draft's other text", () => {
    expect(inBox("> earlier thought deploy now", ["deploy now"])).toBe(true)
  })

  it("does not find other words, or any in an empty prompt", () => {
    expect(inBox("> deploy now", ["deploy later"])).toBe(false)
    expect(inBox("> deploy now", [])).toBe(false)
  })
})

describe("missingAt", () => {
  const slack = 1_000
  const idle = (endedAt: number | null): Turns => ({ working: false, endedAt })
  const running: Turns = { working: true, endedAt: null }

  it("is due at the turn's end plus the slack for a steer the agent dropped", () => {
    // Sent at 100 while working; the turn ended at 5000 and the agent stayed idle.
    expect(missingAt(100, running, null, 4_000, slack)).toBeNull()
    expect(missingAt(100, idle(5_000), null, 5_500, slack)).toBe(6_000)
    expect(missingAt(100, idle(5_000), 6_000, 6_000, slack)).toBe(true)
  })

  it("is put off by a next turn that starts inside the slack, and restarts at its end", () => {
    expect(missingAt(100, running, null, 5_900, slack)).toBeNull()
    expect(missingAt(100, idle(7_000), null, 7_200, slack)).toBe(8_000)
    expect(missingAt(100, idle(7_000), 8_100, 8_100, slack)).toBe(true)
  })

  it("is due the slack after the send when idle and no turn ever starts", () => {
    expect(missingAt(100, idle(null), null, 500, slack)).toBe(1_100)
    expect(missingAt(100, idle(null), 1_100, 1_100, slack)).toBe(true)
  })

  it("takes the slack from the send when the last turn ended before it", () => {
    expect(missingAt(5_000, idle(2_000), null, 5_200, slack)).toBe(6_000)
  })

  it("waits for a read to the end after the due time", () => {
    expect(missingAt(100, idle(null), null, 2_000, slack)).toBeNull()
    expect(missingAt(100, idle(null), 1_000, 2_000, slack)).toBeNull()
  })
})

describe("a prompt that went on the same line as what the box held", () => {
  it("settles by a line that ends with its first, after a space", () => {
    const joined = { ref: "r", lines: promptLines("the message\nits second"), joined: true }
    expect(settledBy([joined], "half typed the message\nits second")).toEqual(["r"])
    expect(settledBy([joined], "half typedthe message\nits second")).toEqual([])
    expect(settledBy([joined], "half typed the message\nsomething else")).toEqual([])
  })

  it("is the only one that does, as any other's words may just end a line", () => {
    const other = { ref: "r", lines: promptLines("ok") }
    expect(settledBy([other], "that is ok")).toEqual([])
  })
})

describe("knownWords", () => {
  const back = (text: string) => ({ text, lines: promptLines(text) })

  it("gives the words of the prompts that are all the box holds, white space aside", () => {
    expect(knownWords([back("one two")], "one\n  two")).toBe("one two")
    expect(knownWords([back("one"), back("two")], "one\ntwo")).toBe("one\ntwo")
    expect(knownWords([back("one"), back("two")], "one")).toBe("one")
    expect(knownWords([back("one"), back("two")], "two\none")).toBe("two\none")
  })

  it("gives nothing where anything else is there, or nothing is back", () => {
    expect(knownWords([back("one")], "one and more")).toBeUndefined()
    expect(knownWords([], "one")).toBeUndefined()
    expect(knownWords([back("")], "")).toBeUndefined()
  })
})
