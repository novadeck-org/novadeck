import { describe, expect, it, vi } from "vitest"

import { Permits, permitMs, Quotes, quotedIn, ringMs, standingMs } from "./permits.js"

describe("permits", () => {
  it("cover one terminal's target, standing for twelve hours unused", () => {
    let now = 1000
    const permits = new Permits(() => now)
    permits.give("a", "merge:1", false, { type: "quote", quote: "merge it" })
    expect(permits.covering("a", "merge:1")).toBeDefined()
    expect(permits.covering("b", "merge:1")).toBeUndefined()
    expect(permits.covering("a", "merge:2")).toBeUndefined()
    // A go-ahead at bedtime still covers the merge once CI is green, hours later.
    now += 5 * 60 * 60_000
    expect(permits.covering("a", "merge:1")).toBeDefined()
    now = 1000 + standingMs
    expect(permits.covering("a", "merge:1")).toBeUndefined()
    expect(permits.of("a")).toEqual([])
  })

  it("keep only a retry window from their first use, for their whole group; a single-use one ends there", () => {
    let now = 0
    const permits = new Permits(() => now)
    const given = { group: "g", title: "Merge PR #5 into main" }
    const many = permits.give("a", "x", false, { type: "answer", card: "c" }, given)
    permits.give("a", "x-branch", false, { type: "answer", card: "c" }, given)
    const once = permits.give("a", "y", true, { type: "answer", card: "c" })
    now = 60 * 60_000
    permits.used(many)
    permits.used(once)
    expect(permits.covering("a", "y")).toBeUndefined()
    // Retried, as a failed push is, or asked twice, as Codex does.
    now += permitMs - 1
    permits.used(many)
    expect(permits.covering("a", "x")).toBeDefined()
    expect(permits.covering("a", "x-branch")?.usedAt).toBe(60 * 60_000)
    now += 1
    expect(permits.covering("a", "x")).toBeUndefined()
    expect(permits.covering("a", "x-branch")).toBeUndefined()
  })

  it("are taken back by group, the person's own call, leaving the rest", () => {
    const permits = new Permits()
    const changed: string[] = []
    permits.watch((terminalId) => changed.push(terminalId))
    permits.give("a", "x", false, { type: "quote", quote: "q" }, { group: "g" })
    permits.give("a", "x2", false, { type: "quote", quote: "q" }, { group: "g" })
    permits.give("a", "y", false, { type: "quote", quote: "q" }, { group: "h" })
    permits.give("b", "x", false, { type: "quote", quote: "q" }, { group: "g" })
    expect(permits.takeBack("a", "g")).toBe(true)
    expect(permits.takeBack("a", "g")).toBe(false)
    expect(permits.of("a").map(({ key }) => key)).toEqual(["y"])
    expect(permits.covering("b", "x")).toBeDefined()
    expect(changed.at(-1)).toBe("a")
  })

  it("end every terminal's permit for a target that changed", () => {
    const permits = new Permits()
    permits.give("a", "pr-merge:r#5", false, { type: "quote", quote: "q" })
    permits.give("b", "pr-merge:r#5", false, { type: "quote", quote: "q" })
    permits.give("a", "pr-merge:r#6", false, { type: "quote", quote: "q" })
    permits.revoke("pr-merge:r#5")
    expect(permits.covering("a", "pr-merge:r#5")).toBeUndefined()
    expect(permits.covering("b", "pr-merge:r#5")).toBeUndefined()
    expect(permits.covering("a", "pr-merge:r#6")).toBeDefined()
  })

  it("tell listeners, so a card another source answered is withdrawn", () => {
    const permits = new Permits()
    const seen: string[] = []
    permits.onGiven((permit) => seen.push(permit.key))
    permits.give("a", "x", false, { type: "quote", quote: "q" })
    expect(seen).toEqual(["x"])
  })
})

describe("what ends a standing permit", () => {
  const quote = { type: "quote", quote: "merge stuff" } as const

  it("stands for the agent session it was given in only: a /clear or another agent ends it", async () => {
    const session = new Map([["t", "s1"]])
    const permits = new Permits(Date.now, { session: (id) => session.get(id) })
    const changed: string[] = []
    permits.watch((id) => changed.push(id))
    permits.give("t", "merge:5", false, quote)
    expect(permits.covering("t", "merge:5")?.sessionId).toBe("s1")
    session.set("t", "s2")
    expect(permits.covering("t", "merge:5")).toBeUndefined()
    expect(permits.of("t")).toEqual([])
    // Told once the read is done, as a read may come while a detail is drawn.
    await Promise.resolve()
    expect(changed).toEqual(["t", "t"])
    // Nor while no session is bound, as while its agent is suspended (Ctrl+Z); it waits for
    // that session to come back, and another one ends it.
    session.set("t", "s2")
    permits.give("t", "merge:6", false, quote)
    session.delete("t")
    expect(permits.covering("t", "merge:6")).toBeUndefined()
    expect(permits.of("t")).toHaveLength(1)
    session.set("t", "s2")
    expect(permits.covering("t", "merge:6")?.sessionId).toBe("s2")
    session.set("t", "s3")
    expect(permits.covering("t", "merge:6")).toBeUndefined()
    expect(permits.of("t")).toEqual([])
  })

  it("tells its end when its time is up, with no read to find it", async () => {
    vi.useFakeTimers()
    try {
      const permits = new Permits()
      const changed: string[] = []
      permits.watch((id) => changed.push(id))
      const permit = permits.give("t", "merge:5", false, quote)
      vi.advanceTimersByTime(60_000)
      permits.used(permit)
      expect(changed).toEqual(["t", "t"])
      vi.advanceTimersByTime(permitMs + 1)
      await Promise.resolve()
      expect(changed).toEqual(["t", "t", "t"])
      expect(permits.of("t")).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("ends a whole group when one of its targets changed, and every permit as the gate goes off", () => {
    const permits = new Permits()
    const given = { group: "g", title: "Merge PR #5 into main" }
    permits.give("t", "pr-merge:r#5", false, quote, given)
    permits.give("t", "pr-merge:r@feat/x", false, quote, given)
    permits.give("t", "land:r:main", false, quote)
    permits.revoke("pr-merge:r#5")
    expect(permits.of("t").map(({ key }) => key)).toEqual(["land:r:main"])
    permits.clear()
    expect(permits.of("t")).toEqual([])
  })

  it("lets a taken single-use permit back after a take back that ended nothing, never after a revoke", () => {
    const permits = new Permits()
    const once = permits.give("t", "force", true, quote)
    const restore = permits.take(once)!
    expect(permits.takeBack("t", "none")).toBe(false)
    restore()
    expect(permits.covering("t", "force")).toBeDefined()
    const again = permits.take(once)!
    permits.revoke("force")
    again()
    expect(permits.covering("t", "force")).toBeUndefined()
  })
})

describe("the quote ring", () => {
  it("finds the person's words, word for word, and says what they wrote", () => {
    const quotes = new Quotes()
    quotes.record("a", "s1", "Please  merge it, when green")
    expect(quotes.said("a", "merge it")).toBe("merge it")
    expect(quotes.said("a", "Merge IT when green")).toBe("merge it, when green")
    expect(quotes.said("a", "merge them all")).toBeUndefined()
    expect(quotes.said("b", "merge it")).toBeUndefined()
    expect(quotes.said("a", "it")).toBeUndefined()
  })

  it("wants two whole words in a row, found at word boundaries", () => {
    expect(quotedIn("go ahead and merge it please", "merge it")).toBe("merge it")
    // One word, however long, could be found in any prompt.
    expect(quotedIn("go ahead and merge it please", "merge")).toBeUndefined()
    expect(quotedIn("go ahead and merge it please", "")).toBeUndefined()
    // A part of a word is no word; neither is words out of order or apart.
    expect(quotedIn("they emerge items", "merge it")).toBeUndefined()
    expect(quotedIn("merge itself", "merge it")).toBeUndefined()
    expect(quotedIn("it merge", "merge it")).toBeUndefined()
    expect(quotedIn("merge the PR and it", "merge it")).toBeUndefined()
    expect(quotedIn("MERGE\n\tIT now", "merge   it")).toBe("MERGE\n\tIT")
    expect(quotedIn("merge #1170, then stop", "merge 1170")).toBe("merge #1170")
  })

  it("keeps every prompt of the last hour, however many came after, and starts over with a new session", () => {
    let now = 0
    const quotes = new Quotes(() => now)
    quotes.record("a", "s1", "feel free to merge stuff")
    for (const text of ["second one", "third one", "fourth one", "fifth one", "sixth one"]) {
      now += 60_000
      quotes.record("a", "s1", text)
    }
    expect(quotes.said("a", "merge stuff")).toBe("merge stuff")
    now = ringMs
    expect(quotes.said("a", "merge stuff")).toBeUndefined()
    expect(quotes.prompts("a")).toEqual([
      "second one",
      "third one",
      "fourth one",
      "fifth one",
      "sixth one",
    ])
    now += ringMs
    expect(quotes.prompts("a")).toEqual([])
    quotes.record("a", "s1", "ship it now")
    quotes.record("a", "s2", "after clear")
    expect(quotes.prompts("a")).toEqual(["after clear"])
  })
})
