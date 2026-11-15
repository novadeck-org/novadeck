import type { PullRequest } from "@novadeck/core/forges"
import type { Work } from "@novadeck/core/works"

import { describe, expect, it } from "../../test"
import { pullRequestAt, samePullRequest } from "./pull-requests"

const pull = (rest: Partial<PullRequest> = {}): PullRequest => ({
  number: 812,
  url: "https://github.com/acme/shop/pull/812",
  title: "Checkout",
  state: "open",
  ...rest,
})

const work = (root: string, pullRequest?: PullRequest): Work => ({
  root,
  terminalId: null,
  projectId: "p",
  working: false,
  branch: "agent/checkout",
  base: "main",
  firstSeenAt: 1,
  merged: false,
  added: 1,
  removed: 0,
  unreadAdded: 0,
  unreadRemoved: 0,
  files: [],
  truncated: false,
  conflicts: [],
  ...(pullRequest && { pullRequest }),
})

describe("a changes item's pull request", () => {
  it("is the one of the work at its root", () => {
    const works = [work("/a"), work("/b", pull())]
    expect(pullRequestAt(works, "/b")).toEqual(pull())
    expect(pullRequestAt(works, "/a")).toBeUndefined()
    expect(pullRequestAt(works, "/gone")).toBeUndefined()
  })

  it("is the same while its number, page, title and state are", () => {
    expect(samePullRequest(pull(), pull())).toBe(true)
    expect(samePullRequest(undefined, undefined)).toBe(true)
    expect(samePullRequest(pull(), undefined)).toBe(false)
    expect(samePullRequest(pull(), pull({ state: "merged" }))).toBe(false)
    expect(samePullRequest(pull(), pull({ title: "Checkout, again" }))).toBe(false)
    expect(samePullRequest(pull(), pull({ number: 813 }))).toBe(false)
    expect(samePullRequest(pull(), pull({ url: "https://github.com/acme/shop/pull/9" }))).toBe(
      false,
    )
  })
})
