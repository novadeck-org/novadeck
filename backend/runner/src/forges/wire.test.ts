import type { Check } from "@novadeck/forges"
import { forgeLimits, pullRequest } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import { wirePullRequest } from "./wire.js"

const found = {
  number: 3,
  url: "https://github.com/o/r/pull/3",
  title: "Add",
  state: "open",
} as const

describe("a forge's pull request on the wire", () => {
  it("keeps only the contract's fields, each check's state in its words", () => {
    const wired = wirePullRequest({
      ...found,
      ci: "running",
      base: "main",
      review: "changes_requested",
      checks: [
        { name: "a", state: "passed" },
        { name: "b", state: "failed" },
        { name: "c", state: "running", since: 5, runner: "ubuntu-latest" },
        { name: "d", state: "queued", runner: "macos-latest" },
        { name: "e", state: "held", hold: "concurrency" },
        { name: "f", state: "held", hold: "earlier" },
        { name: "g", state: "held", hold: "downstream" },
      ],
    })
    expect(wired).toEqual({
      ...found,
      ci: "running",
      base: "main",
      review: "changes_requested",
      checks: [
        { name: "a", state: "passed" },
        { name: "b", state: "failed" },
        { name: "c", state: "running" },
        { name: "d", state: "waiting" },
        { name: "e", state: "waiting" },
        { name: "f", state: "waiting" },
        { name: "g", state: "running" },
      ],
    })
    expect(pullRequest.safeParse(wired).success).toBe(true)
  })

  it("cuts long names and caps the checks, so a big answer still fits the contract", () => {
    const many: Check[] = Array.from({ length: 150 }, (_, at) => ({
      name: `${"x".repeat(300)}${at}`,
      state: "passed",
    }))
    const wired = wirePullRequest({ ...found, title: "t".repeat(600), checks: many })
    expect(wired.title).toHaveLength(forgeLimits.title)
    expect(wired.checks).toHaveLength(forgeLimits.checks)
    expect(wired.checks?.every(({ name }) => name.length === forgeLimits.check)).toBe(true)
    expect(pullRequest.safeParse(wired).success).toBe(true)
  })

  it("leaves out a nameless check, an empty check list, and a base too long to be a branch", () => {
    const wired = wirePullRequest({
      ...found,
      base: "b".repeat(forgeLimits.branch + 1),
      checks: [{ name: "", state: "passed" }],
    })
    expect(wired).toEqual(found)
    expect(wirePullRequest({ ...found, base: "", checks: [] })).toEqual(found)
  })

  it("keeps a merged pull request's target", () => {
    expect(wirePullRequest({ ...found, state: "merged", base: "feature" })).toEqual({
      ...found,
      state: "merged",
      base: "feature",
    })
  })
})
