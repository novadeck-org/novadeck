import {
  commandText,
  grantBody,
  grantExtras,
  grantTitle,
  lifetimeWords,
  moreThings,
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
    commands: [{ argv: ["uberepo", "ship"], rest: true }],
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
    covered: [
      { handle: "fox", agent: "codex" },
      { handle: "owl", agent: "claude" },
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
          covered: [1, 2, 3].map((n) => ({ handle: `a${n}`, agent: "claude" })),
        },
        "moth",
      ),
    ).toBe("Let my team work without asking?")
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
      { kind: "command", at: 0, reason: "This could do more than pushing" },
      { kind: "repo", url: "github.com/acme/ui", reason: "This repo was just created or changed" },
      {
        kind: "repo",
        url: "github.com/x/shop",
        reason: "This remote was added recently and isn't yours",
      },
    ])
    expect(moreThings(1)).toBe("1 more thing")
    expect(moreThings(3)).toBe("3 more things")
  })

  it("says the lifetime in a sentence", () => {
    expect(lifetimeWords("until-done")).toBe("until it's done")
    expect(lifetimeWords("hour")).toBe("for 1 hour")
  })
})
