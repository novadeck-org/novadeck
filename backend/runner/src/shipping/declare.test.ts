/* eslint-disable no-await-in-loop -- Each case is read in turn. */
import { describe, expect, it } from "vitest"

import { heldOptions, heldRef } from "../harnesses/detail.js"
import { Cards } from "./cards.js"
import { declare, type DeclareDeps } from "./declare.js"
import { answeredCard } from "./held.js"
import { Permits, Quotes } from "./permits.js"
import { readCommand, type Lookups } from "./reader.js"
import { Shipping } from "./service.js"

const lookups: Lookups = {
  branch: async () => "feat/x",
  upstream: async () => undefined,
  repo: async () => "r/app",
  own: async () => false,
}

const deps = (agent: "claude" | "codex" = "claude", via: Lookups = lookups) => {
  const permits = new Permits()
  const quotes = new Quotes()
  const cards = new Cards()
  const all: DeclareDeps = {
    lookups: () => via,
    permits,
    quotes,
    cards,
    pull: async () => ({ base: "main", head: "feat/x" }),
    valid: async (_folder, name) => !/[\s~^:?*[\\]|\.\.|^-/.test(name),
    defaultBranch: async () => "trunk",
    agentOf: () => agent,
  }
  return { permits, quotes, cards, all }
}

describe("request_permit", () => {
  it("permits at once on the user's own words, as typed in this terminal", async () => {
    const { all, quotes, permits } = deps()
    quotes.record("t", "s", "go ahead and merge it please")
    const answer = await declare(all, "t", "/w", {
      action: "merge_pr",
      target: "1170",
      said: "merge it",
    })
    expect(answer).toMatchObject({ ok: true, state: "permitted" })
    expect(permits.covering("t", "pr-merge:r/app#1170")?.source).toEqual({
      type: "quote",
      quote: "merge it",
    })
    // The branch form covers a bare `gh pr merge` from the PR's own branch.
    expect(permits.covering("t", "pr-merge:r/app@feat/x")).toBeDefined()
  })

  it("never counts a teammate's quote: the words weren't typed in its terminal", async () => {
    const { all, quotes, cards } = deps()
    quotes.record("lead", "s", "merge it")
    const answer = await declare(all, "mate", "/w", {
      action: "merge_pr",
      target: "1170",
      said: "merge it",
    })
    expect(answer).toMatchObject({ ok: true, state: "asked" })
    expect(cards.of("mate")).toHaveLength(1)
  })

  it("asks with a card titled from what Novadeck resolved, one per terminal and target", async () => {
    const { all, cards } = deps()
    await declare(all, "t", "/w", { action: "merge_pr", target: "#1170" })
    const again = await declare(all, "t", "/w", { action: "merge_pr", target: "1170" })
    expect(cards.of("t")).toHaveLength(1)
    expect(cards.of("t")[0]!.title).toBe("Merge PR #1170 into main?")
    expect(again).toMatchObject({ state: "asked" })
  })

  it("withdraws the card when another source gives the permit, and tells Codex to escalate", async () => {
    const { all, quotes, cards } = deps("codex")
    await declare(all, "t", "/w", { action: "land", target: "main" })
    expect(cards.of("t")).toHaveLength(1)
    quotes.record("t", "s", "land it on main")
    const answer = await declare(all, "t", "/w", {
      action: "land",
      target: "main",
      said: "land it",
    })
    expect(answer).toMatchObject({ state: "permitted" })
    expect(answer.ok && answer.text).toContain("escalation")
  })

  it("declares the keys the hook will read, with the remote it resolves", async () => {
    const { all, permits, quotes } = deps("claude", {
      ...lookups,
      branch: async () => "feat/x",
      upstream: async () => ({ remote: "fork", branch: "feat/x" }),
      own: async () => false,
    })
    quotes.record("t", "s", "push it to main, and open a PR")
    const asRead = async (command: string) => {
      const read = await readCommand(command, "/w", {
        ...lookups,
        upstream: async () => ({ remote: "fork", branch: "feat/x" }),
        own: async () => false,
      })
      return read.kind === "ships" ? read.actions.map((each) => each.key) : []
    }
    // No remote named: the branch's upstream remote, as the reader resolves it, not `origin`.
    await declare(all, "t", "/w", { action: "push", said: "push it to main" })
    for (const key of await asRead("git push")) expect(permits.covering("t", key)).toBeDefined()
    expect(permits.covering("t", "push:r/app:origin/feat/x")).toBeUndefined()
    // A remote the agent names is the one the permit is for.
    await declare(all, "t", "/w", {
      action: "push",
      target: "main",
      remote: "origin",
      said: "push it to main",
    })
    expect(permits.covering("t", "push:r/app:origin/main")).toBeDefined()
    // A PR with no --base goes to the default branch, which is resolved here and never in the hook.
    await declare(all, "t", "/w", { action: "open_pr", said: "open a PR" })
    for (const key of await asRead("gh pr create --fill"))
      expect(permits.covering("t", key)).toBeDefined()
    expect(permits.covering("t", "pr-create:r/app:trunk")).toBeDefined()
  })

  it("draws the card only from names git accepts", async () => {
    const { all, cards } = deps()
    for (const target of ["main; rm -rf /", "bad name", "-x", "a..b"]) {
      expect(await declare(all, "t", "/w", { action: "land", target })).toMatchObject({ ok: false })
      expect(await declare(all, "t", "/w", { action: "push", target })).toMatchObject({ ok: false })
      expect(await declare(all, "t", "/w", { action: "open_pr", target })).toMatchObject({
        ok: false,
      })
    }
    expect(
      await declare(all, "t", "/w", { action: "push", target: "main", remote: "o rigin" }),
    ).toMatchObject({ ok: false })
    expect(cards.of("t")).toHaveLength(0)
    await declare(all, "t", "/w", { action: "push", target: "main", remote: "fork" })
    expect(cards.of("t")[0]!.title).toBe("Push to fork/main?")
  })

  it("gives no permit for one word or part of a word, and shows the words it went by", async () => {
    const { all, quotes, permits, cards } = deps()
    quotes.record("t", "s", "Please MERGE   it now")
    expect(
      await declare(all, "t", "/w", { action: "merge_pr", target: "5", said: "merge" }),
    ).toMatchObject({ state: "asked" })
    expect(cards.of("t")).toHaveLength(1)
    const answer = await declare(all, "t", "/w", {
      action: "merge_pr",
      target: "6",
      said: "merge it",
    })
    expect(answer.ok && answer.text).toContain('"MERGE   it"')
    expect(permits.covering("t", "pr-merge:r/app#6")?.source).toEqual({
      type: "quote",
      quote: "MERGE   it",
    })
  })

  it("refuses what it can't resolve", async () => {
    const { all } = deps()
    expect(await declare(all, "t", "/w", { action: "merge_pr" })).toMatchObject({ ok: false })
    expect(await declare(all, "t", "/w", { action: "nuke" })).toMatchObject({ ok: false })
  })
})

describe("the shipping service's cards", () => {
  const service = () => {
    const told: string[] = []
    const shipping = new Shipping({
      enabled: () => true,
      owned: { ofTerminal: () => [], all: () => [] },
      notify: (_id, text) => (told.push(text), true),
    })
    return { shipping, told }
  }
  const record = {
    summary: { id: "t" },
    bound: { binding: { agent: "claude", sessionId: "s1" } },
  } as never

  it("gives the permit on Allow and tells the agent, once; the first answer wins", async () => {
    const { shipping, told } = service()
    const card = shipping.cards.ask("t", ["land:r/app:main"], false, "Land work on main?", "").card
    const request = heldRef({ agent: "claude", sessionId: "s1" } as never, card)
    const answer = {
      type: "choice",
      dialog: `permit-${card.id}`,
      option: heldOptions.allow,
    } as const
    await answeredCard(shipping, record, request, answer, "window-1")
    expect(shipping.permits.covering("t", "land:r/app:main")?.source).toEqual({
      type: "answer",
      card: card.id,
      client: "window-1",
    })
    expect(told).toHaveLength(1)
    expect(told[0]).toContain("Novadeck · Shipping")
    expect(answeredCard(shipping, record, request, answer)).toBeUndefined()
  })

  it("gives nothing on Deny", async () => {
    const { shipping, told } = service()
    const card = shipping.cards.ask("t", ["land:r/app:main"], false, "Land work on main?", "").card
    const request = heldRef({ agent: "claude", sessionId: "s1" } as never, card)
    await answeredCard(shipping, record, request, {
      type: "choice",
      dialog: `permit-${card.id}`,
      option: heldOptions.deny,
    })
    expect(shipping.permits.covering("t", "land:r/app:main")).toBeUndefined()
    expect(told[0]).toContain("declined")
  })
})
