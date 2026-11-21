import { describe, expect, it } from "vitest"

import { Permits, permitMs, Quotes, ringMs } from "./permits.js"

describe("permits", () => {
  it("cover one terminal's target for ten minutes", () => {
    let now = 1000
    const permits = new Permits(() => now)
    permits.give("a", "merge:1", false, { type: "quote", quote: "merge it" })
    expect(permits.covering("a", "merge:1")).toBeDefined()
    expect(permits.covering("b", "merge:1")).toBeUndefined()
    expect(permits.covering("a", "merge:2")).toBeUndefined()
    now += permitMs
    expect(permits.covering("a", "merge:1")).toBeUndefined()
  })

  it("end after one use only when single use", () => {
    const permits = new Permits()
    const many = permits.give("a", "x", false, { type: "answer", card: "c" })
    const once = permits.give("a", "y", true, { type: "answer", card: "c" })
    permits.used(many)
    permits.used(once)
    expect(permits.covering("a", "x")).toBeDefined()
    expect(permits.covering("a", "y")).toBeUndefined()
  })

  it("tell listeners, so a card another source answered is withdrawn", () => {
    const permits = new Permits()
    const seen: string[] = []
    permits.onGiven((permit) => seen.push(permit.key))
    permits.give("a", "x", false, { type: "quote", quote: "q" })
    expect(seen).toEqual(["x"])
  })
})

describe("the quote ring", () => {
  it("finds the person's words, word for word", () => {
    const quotes = new Quotes()
    quotes.record("a", "s1", "Please  merge it when green")
    expect(quotes.said("a", "merge it")).toBe(true)
    expect(quotes.said("a", "Merge IT when green")).toBe(true)
    expect(quotes.said("a", "merge them all")).toBe(false)
    expect(quotes.said("b", "merge it")).toBe(false)
    expect(quotes.said("a", "it")).toBe(false)
  })

  it("keeps three prompts, none older than an hour, and starts over with a new session", () => {
    let now = 0
    const quotes = new Quotes(() => now)
    for (const text of ["first one", "second one", "third one", "fourth one"])
      quotes.record("a", "s1", text)
    expect(quotes.prompts("a")).toEqual(["second one", "third one", "fourth one"])
    now += ringMs + 1
    expect(quotes.prompts("a")).toEqual([])
    quotes.record("a", "s1", "ship it now")
    quotes.record("a", "s2", "after clear")
    expect(quotes.prompts("a")).toEqual(["after clear"])
  })
})
