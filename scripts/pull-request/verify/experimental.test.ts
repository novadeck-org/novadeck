import { describe, expect, it } from "vitest"

import { type Experimental } from "../../release-notes/experimental.ts"
import { experimentalErrors, pullRequestFiles } from "./experimental.ts"

const listed: Experimental = new Map([
  ["onboarding-tour", { scopes: ["tour"], paths: ["frontend/tour/", "backend/runner/src/tour/"] }],
  ["shipping-gate", { scopes: ["shipping"], paths: ["backend/runner/src/shipping/"] }],
])
const tourFile = ["frontend/tour/src/acts.ts", "frontend/ui/src/app/App.tsx"]

describe("a pull request that changes an Experimental feature's code", () => {
  it("has to say whether people without the feature see the change", () => {
    const errors = experimentalErrors("feat(ui): a thing", "## What\n\nIt.", tourFile, listed)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("onboarding-tour's own code (frontend/tour/src/acts.ts)")
    expect(errors[0]).toContain("`Experimental: onboarding-tour`")
    expect(errors[0]).toContain("`Experimental: none`")
  })

  it("passes once it says, either way", () => {
    for (const line of ["Experimental: onboarding-tour", "Experimental: none"])
      expect(
        experimentalErrors("feat(ui): a thing", `## What\n\nIt.\n\n${line}\n`, tourFile, listed),
      ).toEqual([])
  })

  it("needs nothing under the feature's own scope, which the notes hold back already", () => {
    expect(experimentalErrors("fix(tour): a thing", "", tourFile, listed)).toEqual([])
  })

  it("needs nothing when the notes would never tell it: another type, or a scope they skip", () => {
    for (const title of ["refactor(ui): a thing", "test: a spec", "fix(e2e): a spec", "ci: a job"])
      expect(experimentalErrors(title, "", tourFile, listed)).toEqual([])
  })

  it("asks about each feature it changes", () => {
    const files = ["backend/runner/src/tour/a.ts", "backend/runner/src/shipping/b.ts"]
    expect(experimentalErrors("fix(runner): a thing", "", files, listed)).toHaveLength(2)
    expect(
      experimentalErrors("fix(runner): a thing", "", ["backend/runner/src/x.ts"], listed),
    ).toEqual([])
  })

  it("refuses a line that names no listed feature, a typo or one that left", () => {
    const [error] = experimentalErrors("feat(ui): a thing", "Experimental: tour", [], listed)
    expect(error).toContain("`Experimental: tour` names no feature still behind Experimental")
    expect(error).toContain(
      "`Experimental: onboarding-tour`, `Experimental: shipping-gate` or `Experimental: none`",
    )
  })
})

describe("the files a pull request changes", () => {
  it("come from GitHub, every page", () => {
    const asked: string[][] = []
    const files = pullRequestFiles({ PR_NUMBER: "7", GITHUB_REPOSITORY: "o/r" }, (args) => {
      asked.push(args)
      return "a.ts\nb/c.ts\n"
    })
    expect(files).toEqual(["a.ts", "b/c.ts"])
    expect(asked[0]).toEqual([
      "api",
      "--paginate",
      "repos/o/r/pulls/7/files",
      "--jq",
      ".[].filename",
    ])
  })

  it("are none outside a pull request's run, and a run without its number fails", () => {
    expect(pullRequestFiles({})).toEqual([])
    expect(() => pullRequestFiles({ GITHUB_ACTIONS: "true" })).toThrow(/PR_NUMBER/)
  })
})
