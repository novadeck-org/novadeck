import { mentionInCode, mentionsIn, type Mention } from "./mentions"
import { context, describe, expect, it } from "./test"

const known: Mention = (handle) => ({ thorn: 3, fox: 5, "api-server": 2 })[handle] ?? null

describe("mentionsIn", () => {
  it("splits a handle out of prose, keeping the words around it", () => {
    expect(mentionsIn("Ask @thorn about it.", known)).toEqual([
      { t: "text", text: "Ask " },
      { t: "mention", text: "@thorn", hue: 3 },
      { t: "text", text: " about it." },
    ])
  })

  it("finds each handle with its own hue", () => {
    const parts = mentionsIn("@thorn and @fox", known)
    expect(parts?.filter((part) => part.t === "mention")).toEqual([
      { t: "mention", text: "@thorn", hue: 3 },
      { t: "mention", text: "@fox", hue: 5 },
    ])
  })

  it("takes a handle with a dash whole, and leaves out the dash a sentence ended on", () => {
    expect(mentionsIn("@api-server is up", known)?.[0]).toEqual({
      t: "mention",
      text: "@api-server",
      hue: 2,
    })
    expect(mentionsIn("ask @fox- now", known)?.[1]).toEqual({
      t: "mention",
      text: "@fox",
      hue: 5,
    })
  })

  context("a handle no agent answers to", () => {
    it("stays plain", () => {
      expect(mentionsIn("@nobody says hi", known)).toBeNull()
    })
  })

  context("an @ that is not a mention", () => {
    it.each([
      ["an email", "write to me@thorn.dev"],
      ["a URL path", "see https://example.com/@thorn"],
      ["a URL query", "https://example.com/?user=@thorn"],
      ["a longer word", "the @thornier one"],
      ["a doubled @", "@@thorn"],
    ])("leaves %s plain", (_, text) => {
      expect(mentionsIn(text, known)).toBeNull()
    })
  })
})

describe("mentionInCode", () => {
  it("takes the handle of code that is one alone", () => {
    expect(mentionInCode("@thorn", known)).toEqual({ hue: 3, handle: "@thorn", rest: "" })
  })

  it("keeps Novadeck's title after the handle", () => {
    expect(mentionInCode("@fox · api-server", known)).toEqual({
      hue: 5,
      handle: "@fox",
      rest: " · api-server",
    })
  })

  it.each([
    ["a command", "@thorn --help"],
    ["a path", "@thorn/src"],
    ["words before it", "ask @thorn"],
    ["an unknown handle", "@nobody"],
  ])("leaves %s as it is", (_, text) => {
    expect(mentionInCode(text, known)).toBeNull()
  })
})
