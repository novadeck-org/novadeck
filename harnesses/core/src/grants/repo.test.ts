import { describe, expect, it } from "vitest"

import { normalizeRepoUrl } from "../grants.js"
import { ghRepoKey, repoKey } from "./repo.js"

describe("a repo URL", () => {
  it.each([
    ["https://github.com/o/n", "github.com/o/n"],
    ["https://github.com/o/n.git", "github.com/o/n"],
    ["git@github.com:o/n", "github.com/o/n"],
    ["git@github.com:o/n.git", "github.com/o/n"],
    ["ssh://git@github.com/o/n", "github.com/o/n"],
    ["ssh://git@github.com/o/n.git", "github.com/o/n"],
    ["https://github.com/My-Org/my.repo_1.git", "github.com/My-Org/my.repo_1"],
  ])("%s normalizes to %s", (url, key) => {
    expect(normalizeRepoUrl(url)).toBe(key)
  })

  it.each([
    "http://github.com/o/n",
    "https://gitlab.com/o/n",
    "https://github.com.evil.com/o/n",
    "https://evil.com/github.com/o/n",
    "https://user@github.com/o/n",
    "https://github.com/o/n/extra",
    "https://github.com/o",
    "https://github.com/o/..",
    "git@github.com:o/n/x",
    "ssh://git@github.com:22/o/n",
    "github.com/o/n",
    "o/n",
    "/tmp/repo",
    "origin",
    "",
  ])("%s is not one", (url) => {
    expect(normalizeRepoUrl(url)).toBeUndefined()
  })

  it("keys compare without case, and -R also reads owner/name", () => {
    expect(repoKey("github.com/O/N")).toBe("github.com/o/n")
    expect(ghRepoKey("O/N")).toBe("github.com/o/n")
    expect(ghRepoKey("https://github.com/o/n.git")).toBe("github.com/o/n")
    expect(ghRepoKey("other.com/o/n")).toBeUndefined()
  })
})
