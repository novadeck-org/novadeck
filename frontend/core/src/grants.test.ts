import {
  commandText,
  grantBody,
  grantExtras,
  grantTitle,
  lifetimeWords,
  askedFor,
  type GrantCommand,
  type GrantProposal,
} from "./grants"
import { describe, expect, it } from "./test"

const command = (...argv: string[]): GrantCommand => ({ argv, rest: false })

describe("commandText", () => {
  it("leaves plain words bare", () => {
    expect(commandText(command("git", "push", "origin", "a:b", "--no-verify=1"))).toBe(
      "git push origin a:b --no-verify=1",
    )
  })

  it("quotes a word with a space or a shell character, and an apostrophe in it", () => {
    expect(commandText(command("echo", "a b", "$HOME", "it's", "x;y", "*"))).toBe(
      "echo 'a b' '$HOME' 'it'\\''s' 'x;y' '*'",
    )
  })
})

describe("the Grant card's words", () => {
  const proposal: GrantProposal = {
    presets: ["push", "pr"],
    commands: [{ argv: ["uberepo", "ship"], rest: false }],
    repos: [
      {
        repo: { url: "github.com/acme/shop", defaultBranch: "main", defaultFrom: "github" },
        ticked: true,
        flag: null,
      },
      {
        repo: { url: "github.com/acme/ui", defaultBranch: "main", defaultFrom: "github" },
        ticked: false,
        flag: "recent",
      },
      {
        repo: { url: "github.com/x/shop", defaultBranch: "main", defaultFrom: "guess" },
        ticked: false,
        flag: "added-remote",
      },
    ],
    withLead: false,
    lifetime: "until-done",
    reason: "ignored `here`",
    agyOutdated: false,
    covered: [
      { handle: "fox", agent: "codex", started: false, plan: false },
      { handle: "owl", agent: "claude", started: false, plan: false },
    ],
  }

  it("names the covered teammates, the lead when it is included, and my team past three", () => {
    expect(grantTitle(proposal, "moth")).toBe("Let @fox and @owl work without asking?")
    expect(grantTitle({ ...proposal, withLead: true }, "moth")).toBe(
      "Let @moth, @fox and @owl work without asking?",
    )
    expect(grantTitle({ ...proposal, covered: [] }, "moth")).toBe(
      "Let my team work without asking?",
    )
    expect(
      grantTitle(
        {
          ...proposal,
          withLead: true,
          covered: [1, 2, 3].map((n) => ({
            handle: `a${n}`,
            agent: "claude",
            started: false,
            plan: false,
          })),
        },
        "moth",
      ),
    ).toBe("Let @moth and its team work without asking?")
  })

  it("says in the title that the lead is included, in every form of holder count", () => {
    const covered = (count: number) =>
      Array.from({ length: count }, (_, n) => ({
        handle: `a${n}`,
        agent: "claude" as const,
        started: false,
        plan: false,
      }))
    const title = (count: number, withLead: boolean) =>
      grantTitle({ ...proposal, withLead, covered: covered(count) }, "moth")
    expect(title(0, true)).toBe("Let @moth and its team work without asking?")
    expect(title(1, true)).toBe("Let @moth and @a0 work without asking?")
    expect(title(2, true)).toBe("Let @moth, @a0 and @a1 work without asking?")
    expect(title(3, true)).toBe("Let @moth and its team work without asking?")
    expect(title(5, true)).toBe("Let @moth and its team work without asking?")
    // Without the lead, no form names it.
    expect(title(0, false)).toBe("Let my team work without asking?")
    expect(title(3, false)).toBe("Let @a0, @a1 and @a2 work without asking?")
    expect(title(4, false)).toBe("Let my team work without asking?")
  })

  it("words the body from the presets and the repos it ticks, never the lead's reason", () => {
    expect(grantBody(proposal)).toEqual([
      { text: "They'd push their branches and open pull requests in " },
      { code: "acme/shop" },
      { text: " without asking you each time. Merges and pushes to main still need you." },
    ])
    expect(grantBody({ ...proposal, presets: ["pr"] })[0]).toEqual({
      text: "They'd open and edit pull requests in ",
    })
    expect(JSON.stringify(grantBody(proposal))).not.toContain("ignored")
  })

  it("counts the other repos ticked, and says when none is", () => {
    const two = {
      ...proposal,
      repos: proposal.repos.map((each) => ({ ...each, ticked: true })),
    }
    expect(grantBody(two)[2]).toEqual({
      text: " and 2 more without asking you each time. Merges and pushes to main still need you.",
    })
    const none = { ...proposal, repos: proposal.repos.map((each) => ({ ...each, ticked: false })) }
    expect(grantBody(none)).toEqual([
      {
        text: "They'd push their branches and open pull requests in a repo you tick under Review without asking you each time. Merges and pushes to main still need you.",
      },
    ])
  })

  it("lists every command and each unticked repo as an extra, with its reason", () => {
    expect(grantExtras(proposal)).toEqual([
      { kind: "command", at: 0, reason: "This isn't pushing or a pull request" },
      { kind: "repo", url: "github.com/acme/ui", reason: "This repo was just created or changed" },
      {
        kind: "repo",
        url: "github.com/x/shop",
        reason: "This remote was added recently and isn't yours",
      },
    ])
    expect(askedFor(1, proposal)).toBe("also asked for 1 more thing")
    expect(askedFor(3, proposal)).toBe("also asked for 3 more things")
    expect(askedFor(2, { ...proposal, presets: [] })).toBe("asked for 2 things")
  })

  it("follows the repos ticked now, and offers no repo where there is no preset", () => {
    const ticked = ["github.com/acme/shop", "github.com/acme/ui"]
    expect(grantBody(proposal, ticked)[2]).toEqual({
      text: " and 1 more without asking you each time. Merges and pushes to main still need you.",
    })
    expect(grantExtras({ ...proposal, presets: [] })).toEqual([
      { kind: "command", at: 0, reason: "This isn't pushing or a pull request" },
    ])
  })

  it("says the lifetime in a sentence", () => {
    expect(lifetimeWords("until-done")).toBe("until it's done")
    expect(lifetimeWords("hour")).toBe("for 1 hour")
  })
})
