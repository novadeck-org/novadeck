import { describe, expect, it } from "vitest"

import { parseCommit, parseCommits, whatOf } from "./commits.ts"
import { commit, commits } from "./fixtures.ts"

describe("the commits a release is written from", () => {
  it("keeps the features, fixes and speedups that are the app's, each with its pull request", () => {
    expect(parseCommits(commits).map((each) => each.pr)).toEqual([
      181, 188, 195, 330, 328, 203, 198, 261, 282, 126,
    ])
  })

  it("drops other types and the scopes of the demo, wire, atlas, release, scripts, harnesses, chat and CI", () => {
    const dropped = commits.filter((raw) => !parseCommit(raw))
    expect(dropped.map((raw) => raw.subject.replace(/:.*/, ""))).toEqual([
      "refactor(runner)",
      "fix(scripts)",
      "fix(harnesses)",
      "feat(demo)",
      "feat(wire)",
      "feat(chat)",
      "fix(ci)",
      "feat(release)",
    ])
  })

  it("drops the scopes of tests, dependencies and benchmarks, so their fixes are not counted", () => {
    for (const scope of ["test", "tests", "e2e", "deps", "bench", "specs", "flakes"])
      expect(
        parseCommit({ sha: "a", subject: `fix(${scope}): a thing (#1)`, body: "" }),
      ).toBeUndefined()
  })

  it("drops a commit whose subject names the chat, and the sentences of a What that do", () => {
    expect(
      parseCommit({ sha: "a", subject: "feat(ui): chat shows plans (#1)", body: "" }),
    ).toBeUndefined()
    const what = parseCommit({
      sha: "a",
      subject: "feat(ui): plans open beside the terminal (#2)",
      body: "## What\n\nPlans open on their own. The chat view shows them too. They can be edited.\n- The chat renders it.\n- Notes work.\n\n## Why\n\nx",
    })!.what
    expect(what).toBe("Plans open on their own. They can be edited.\n- Notes work.")
  })

  it("removes a whole sentence about chats or demos from a hard-wrapped What, plurals included", () => {
    const what = parseCommit({
      sha: "a",
      subject: "feat(ui): answer agents from the Inbox (#3)",
      body: [
        "## What",
        "",
        "Agents are answered from the Inbox. A permission can also be answered from the",
        "chat box, without switching terminals. Rows clear themselves.",
        "",
        "- The demos show the same rows",
        "  on a fake runner.",
        "- Held messages wait for the agent.",
        "1. Open the Inbox. Chats stay out of it.",
        "",
        "## Why",
        "",
        "x",
      ].join("\n"),
    })!.what
    expect(what).toBe(
      "Agents are answered from the Inbox. Rows clear themselves.\n\n- Held messages wait for the agent.\n1. Open the Inbox.",
    )
    expect(
      parseCommit({ sha: "a", subject: "feat(ui): two chats side by side (#4)", body: "" }),
    ).toBeUndefined()
    expect(
      parseCommit({ sha: "a", subject: "fix(ui): demos load faster (#5)", body: "" }),
    ).toBeUndefined()
  })

  it("strips URLs from the What, and keeps the words around them", () => {
    const what = parseCommit({
      sha: "a",
      subject: "feat(ui): a thing (#7)",
      body: "## What\n\nSee https://example.com/x?y=1 and www.example.org now. It works.",
    })!.what
    expect(what).not.toMatch(/example|http|www/)
    expect(what).toContain("It works.")
  })

  it("leaves out a commit and the revert that undoes it, by quoted subject, typed subject or number", () => {
    const raw = (subject: string, body = "") => ({ sha: subject, subject, body })
    const kept = raw("feat(ui): keep me (#1)")
    const quoted = parseCommits([
      raw("feat(ui): add a thing (#2)"),
      kept,
      raw('Revert "feat(ui): add a thing (#2)" (#3)'),
    ])
    expect(quoted.map((each) => each.pr)).toEqual([1])
    const typed = parseCommits([
      raw("fix(runner): stop a loop (#4)"),
      kept,
      raw("revert(runner): stop a loop (#5)"),
    ])
    expect(typed.map((each) => each.pr)).toEqual([1])
    const numbered = parseCommits([
      raw("feat: first (#6)"),
      kept,
      raw("revert: undo the change", "This reverts #6, which broke it."),
    ])
    expect(numbered.map((each) => each.pr)).toEqual([1])
    // A revert of a revert brings the original back: both reverts and the commit's fate follow order.
    const restored = parseCommits([
      raw("feat(ui): add a thing (#2)"),
      raw('Revert "feat(ui): add a thing (#2)" (#3)'),
      raw('Revert "Revert "feat(ui): add a thing (#2)" (#3)" (#4)'),
    ])
    expect(restored.map((each) => each.pr)).toEqual([2])
    // A typed revert names a type-less subject: another scope's commit is not its target.
    const other = parseCommits([
      raw("fix(ui): stop a loop (#4)"),
      raw("revert(runner): stop a loop (#5)"),
    ])
    expect(other.map((each) => each.pr)).toEqual([4])
    // A quoted revert matches the whole subject, type and scope included.
    const quotedOther = parseCommits([
      raw("fix(ui): stop a loop (#4)"),
      raw('Revert "fix(runner): stop a loop" (#5)'),
    ])
    expect(quotedOther.map((each) => each.pr)).toEqual([4])
    // A revert of something outside the range cancels nothing in it.
    expect(parseCommits([kept, raw('Revert "feat: old thing (#9)" (#10)')])).toHaveLength(1)
  })

  it("takes the type, scope and pull request number off the subject", () => {
    expect(parseCommit(commit(330))).toMatchObject({
      type: "feat",
      scope: "ui",
      pr: 330,
      subject: "assistive technology hears who leads whom in a team's tab descriptions",
    })
    expect(parseCommit(commit(181))).toMatchObject({
      scope: undefined,
      subject: "word handles for terminals, shown as @moth",
    })
  })

  it("drops a commit that merely names the chat view among several scopes", () => {
    const raw = { sha: "a", subject: "feat(ui,chat): a thing (#1)", body: "" }
    expect(parseCommit(raw)).toBeUndefined()
  })

  it("keeps a subject without a pull request number, and drops one that is not conventional", () => {
    expect(
      parseCommit({ sha: "a", subject: "fix(ui): refine workspace header", body: "" }),
    ).toMatchObject({
      pr: undefined,
    })
    expect(parseCommit({ sha: "a", subject: "Merge branch 'main'", body: "" })).toBeUndefined()
  })

  it("reads only the What of the body", () => {
    const what = parseCommit(commit(330))!.what
    expect(what).toMatch(/^Each team member's sidebar tab now names its team/)
    expect(what).not.toMatch(/Follow-up to #328/)
    expect(what).not.toMatch(/## /)
  })

  it("has no What for a body without one, and cuts a long one", () => {
    expect(whatOf("Just a note.\n\n## Why\n\nBecause.")).toBe("")
    expect(whatOf("## What\n\nShort.\n")).toBe("Short.")
    const long = whatOf(`## What\n\n${"word ".repeat(400)}\n\n## Why\n\nno`)
    expect(long.length).toBeLessThan(710)
    expect(long.endsWith("...")).toBe(true)
  })
})
