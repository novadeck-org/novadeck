/* eslint-disable no-await-in-loop -- Each case is read in turn. */
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { heldOptions, heldRef } from "../harnesses/detail.js"
import { Cards } from "./cards.js"
import { declare, type DeclareDeps } from "./declare.js"
import { answeredCard } from "./held.js"
import { Declines, Permits, Quotes } from "./permits.js"
import { readCommand, type Lookups } from "./reader.js"
import { Shipping } from "./service.js"

const lookups: Lookups = {
  branch: async () => "feat/x",
  upstream: async () => undefined,
  repo: async () => "r/app",
  ghRepo: async () => "r/app",
  remoteRepo: async () => "r/app",
  tag: async () => false,
  own: async () => false,
}

const deps = (agent: "claude" | "codex" = "claude", via: Lookups = lookups) => {
  const permits = new Permits()
  const clock = { now: 1_000 }
  const quotes = new Quotes(() => clock.now)
  const cards = new Cards()
  const declines = new Declines(quotes)
  const all: DeclareDeps = {
    lookups: () => via,
    permits,
    quotes,
    declines,
    cards,
    pull: async () => ({ base: "main", head: "feat/x" }),
    valid: async (_folder, name) => !/[\s~^:?*[\\]|\.\.|^-/.test(name),
    defaultBranch: async () => "trunk",
    agentOf: () => agent,
  }
  return { permits, quotes, cards, declines, clock, all }
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

  it("gives one standing permit for the PR of a branch of its own, opened or not, and never its number", async () => {
    let now = 0
    const permits = new Permits(() => now)
    const quotes = new Quotes(() => now)
    const own: Lookups = { ...lookups, own: async (_folder, branch) => branch === "feat/x" }
    const { all, cards } = deps("claude", own)
    const fresh = { ...all, permits, quotes }
    quotes.record("t", "s", "feel free to merge stuff when green")
    const branch = await declare(fresh, "t", "/w", {
      action: "merge_pr",
      target: "feat/x",
      said: "merge stuff",
    })
    expect(branch).toMatchObject({ ok: true, state: "permitted" })
    expect(permits.of("t").map(({ key, title }) => [key, title])).toEqual([
      ["pr-merge:r/app@feat/x", "Merge the PR of feat/x"],
    ])
    // Its number is another target: a PR of that name may be a fork's, or into another base.
    now += 4 * 60 * 60_000
    expect(await declare(fresh, "t", "/w", { action: "merge_pr", target: "1190" })).toMatchObject({
      ok: true,
      state: "asked",
    })
    expect(permits.covering("t", "pr-merge:r/app#1190")).toBeUndefined()
    expect(cards.of("t")).toHaveLength(1)
    // A branch that isn't its own, or isn't a branch name, isn't one.
    expect(
      await declare(fresh, "t", "/w", { action: "merge_pr", target: "main", said: "merge stuff" }),
    ).toMatchObject({ ok: false })
    expect(await declare(fresh, "t", "/w", { action: "merge_pr", target: "fe at" })).toMatchObject({
      ok: false,
    })
  })

  it("takes a reply to an ask whole, even one word, and a bare word with no ask still needs two", async () => {
    const { all, quotes, permits } = deps()
    quotes.record("t", "s", "yes", true)
    expect(
      await declare(all, "t", "/w", { action: "push", target: "main", said: "Yes!" }),
    ).toMatchObject({ ok: true, state: "permitted" })
    expect(permits.covering("t", "push:r/app:origin/main")?.source).toEqual({
      type: "quote",
      quote: "yes",
    })
    const bare = deps()
    bare.quotes.record("t", "s", "yes")
    expect(
      await declare(bare.all, "t", "/w", { action: "push", target: "main", said: "yes" }),
    ).toMatchObject({ ok: true, state: "asked" })
  })

  it("answers declined after a Deny, with no card, until the user types again", async () => {
    const { all, quotes, cards, declines, permits, clock } = deps()
    quotes.record("t", "s", "yes", true)
    clock.now += 10
    declines.decline("t", ["push:r/app:origin/main"])
    const again = await declare(all, "t", "/w", { action: "push", target: "main", said: "yes" })
    expect(again).toMatchObject({ ok: true, state: "declined" })
    expect(cards.of("t")).toEqual([])
    expect(permits.of("t")).toEqual([])
    // The person types: the words before the decline never count, their new ones do.
    clock.now += 10
    quotes.record("t", "s", "no wait")
    expect(
      await declare(all, "t", "/w", { action: "push", target: "main", said: "yes" }),
    ).toMatchObject({ state: "asked" })
    cards.forget("t")
    clock.now += 10
    quotes.record("t", "s", "ok push main after all", true)
    expect(
      await declare(all, "t", "/w", { action: "push", target: "main", said: "push main" }),
    ).toMatchObject({ state: "permitted" })
    // Another target was never declined.
    expect(await declare(all, "t", "/w", { action: "push", target: "other" })).toMatchObject({
      state: "asked",
    })
  })

  it("says how long a permit from the user's words stands", async () => {
    const { all, quotes } = deps()
    quotes.record("t", "s", "go ahead and merge it please")
    const answer = await declare(all, "t", "/w", {
      action: "merge_pr",
      target: "1170",
      said: "merge it",
    })
    expect(answer.ok && answer.text).toContain(
      "The permit stands for 12 hours, until its first use, and for ten minutes after that use, for a retry. The user sees it and can take it back.",
    )
  })

  it("reads a relative folder from the terminal's directory, never the runner's own", async () => {
    const asked: string[] = []
    const { all } = deps("claude", {
      ...lookups,
      repo: async (folder) => {
        asked.push(folder)
        return "r/app"
      },
    })
    await declare(all, "t", "/w", { action: "push", folder: ".", target: "main" })
    await declare(all, "t", "/w", { action: "push", folder: "sub", target: "main" })
    await declare(all, "t", "/w", { action: "push", target: "main" })
    expect(asked.slice(0, 3)).toEqual([resolve("/w", "."), resolve("/w", "sub"), "/w"])
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

  it("asks for --auto and --admin with cards of their own, and --auto's Allow covers the plain merge", async () => {
    const { all, cards, permits } = deps()
    expect(
      await declare(all, "t", "/w", { action: "merge_pr", target: "50", auto: true }),
    ).toMatchObject({ state: "asked" })
    const auto = cards.of("t")[0]!
    expect(auto.title).toBe(
      "Merge PR #50 into main by itself once its checks pass, including work added later?",
    )
    expect(auto.singleUse).toBe(false)
    expect(auto.keys).toContain("pr-auto:r/app#50")
    expect(auto.keys).toContain("pr-merge:r/app#50")
    // A plain merge's permit never covers --auto.
    permits.give("t", "pr-merge:r/app#51", false, { type: "quote", quote: "merge it" })
    expect(
      await declare(all, "t", "/w", { action: "merge_pr", target: "51", auto: true }),
    ).toMatchObject({ state: "asked" })
    // Admin: its own, single use.
    await declare(all, "t", "/w", { action: "merge_pr", target: "52", admin: true })
    const admin = cards.of("t").find((card) => card.keys.includes("pr-admin:r/app#52"))!
    expect(admin.title).toBe("Merge PR #52 into main past its required checks?")
    expect(admin.singleUse).toBe(true)
    expect(admin.keys).toEqual(["pr-admin:r/app#52", "pr-admin:r/app@feat/x"])
    expect(
      await declare(all, "t", "/w", { action: "merge_pr", target: "53", auto: true, admin: true }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("refuses") })
  })

  it("gives a Codex agent that can't escalate no escalation advice", async () => {
    const { all } = deps("codex")
    const text = async (canEscalate: boolean) => {
      const answer = await declare({ ...all, canEscalate: () => canEscalate }, "t", "/w", {
        action: "land",
        target: "main",
        said: "land it",
      })
      return answer.ok ? answer.text : ""
    }
    all.quotes.record("t", "s", "please land it now")
    expect(await text(true)).toContain("asking for escalation")
    all.permits.clear()
    const never = await text(false)
    expect(never).not.toContain("asking for escalation")
    expect(never).toContain("can't ask to escalate")
  })

  it("ends every target of a single-use --admin permit with its first use", async () => {
    const { all, permits, quotes } = deps()
    quotes.record("t", "s", "merge it past the checks")
    await declare(all, "t", "/w", {
      action: "merge_pr",
      target: "52",
      admin: true,
      said: "past the checks",
    })
    expect(permits.covering("t", "pr-admin:r/app#52")).toBeDefined()
    expect(permits.covering("t", "pr-admin:r/app@feat/x")).toBeDefined()
    permits.used(permits.covering("t", "pr-admin:r/app#52")!)
    expect(permits.covering("t", "pr-admin:r/app@feat/x")).toBeUndefined()
    expect(permits.covering("t", "pr-admin:r/app#52")).toBeUndefined()
  })

  it("resolves the repository as the hook does, and asks for the name where it can't", async () => {
    const forked: Lookups = { ...lookups, ghRepo: async () => undefined }
    const { all, cards } = deps("claude", forked)
    const unknown = await declare(all, "t", "/w", { action: "merge_pr", target: "5" })
    expect(unknown).toMatchObject({ ok: false, reason: expect.stringContaining("-R") })
    expect(await declare(all, "t", "/w", { action: "open_pr", target: "main" })).toMatchObject({
      ok: false,
    })
    await declare(all, "t", "/w", { action: "merge_pr", target: "5", repo: "a/b" })
    expect(cards.of("t")[0]!.keys[0]).toBe("pr-merge:a/b#5")
    await declare(all, "t", "/w", {
      action: "merge_pr",
      target: "https://github.com/c/d/pull/6",
    })
    expect(cards.of("t")[1]!.keys[0]).toBe("pr-merge:c/d#6")
    // A push goes to its remote's repository, whatever gh acts on.
    const fork: Lookups = {
      ...lookups,
      remoteRepo: async () => "me/app",
      ghRepo: async () => "up/app",
    }
    const pushed = deps("claude", fork)
    await declare(pushed.all, "t", "/w", { action: "push", target: "main", remote: "origin" })
    expect(pushed.cards.of("t")[0]!.keys).toEqual(["push:me/app:origin/main"])
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
