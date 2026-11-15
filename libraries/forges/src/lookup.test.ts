import { describe, expect, it } from "vitest"

import { isProblem } from "./forge.js"
import { repositoryOf } from "./lookup.js"
import { parseRemote } from "./remote.js"

const of = (
  url: string,
  ...rest: [Parameters<typeof repositoryOf>[1]?, Parameters<typeof repositoryOf>[2]?]
) => repositoryOf(parseRemote(url)!, ...rest)

describe("repositoryOf", () => {
  it("names each forge by its known hosts", () => {
    expect(of("git@github.com:o/r.git")?.forge).toBe("github")
    expect(of("https://gitlab.com/g/s/p")?.forge).toBe("gitlab")
    expect(of("https://dev.azure.com/org/proj/_git/repo")?.forge).toBe("azure")
  })
  it("gives a self-managed host to the forge signed in there", () => {
    const url = "https://code.example.com/g/p.git"
    expect(of(url)).toBeUndefined()
    expect(of(url, { gitlab: ["code.example.com"] })?.forge).toBe("gitlab")
    expect(of(url, { github: ["code.example.com"] })?.forge).toBe("github")
  })
  it("looks only among the forges asked", () => {
    expect(of("https://github.com/o/r", {}, ["gitlab", "azure"])).toBeUndefined()
  })
  it("claims a known host before a signed-in one", () => {
    expect(of("https://github.com/o/r", { gitlab: ["github.com"] })?.forge).toBe("github")
  })
})

describe("isProblem", () => {
  it("tells a Problem from a token and a map", () => {
    expect(isProblem({ kind: "missing" })).toBe(true)
    expect(isProblem({ value: "t" })).toBe(false)
    expect(isProblem(new Map())).toBe(false)
  })
})
