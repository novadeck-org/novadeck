import { describe, expect, it } from "vitest"

import { isBranchName } from "./refname.js"

describe("a branch name", () => {
  it.each(["fix", "feat/a-b", "task/x@auth", "v1.2", "a+b", "a.b/c"])("%s is valid", (name) => {
    expect(isBranchName(name)).toBe(true)
  })

  it.each([
    "",
    "@",
    "@{-1}",
    "a@{b}",
    "-x",
    "a..b",
    "a b",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[",
    "a\\b",
    "/a",
    "a/",
    "a//b",
    ".a",
    "a/.b",
    "a.",
    "a.lock",
    "a/b.lock/c",
    "a\u0001",
  ])("%j is not", (name) => {
    expect(isBranchName(name)).toBe(false)
  })
})
