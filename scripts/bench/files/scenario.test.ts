import { describe, expect, it } from "vitest"

import {
  changedIn,
  changedPaths,
  configProblem,
  defaults,
  makeProject,
  seedPaths,
  workOf,
} from "./scenario.ts"

describe("the synthetic project", () => {
  const project = makeProject({ folders: 300, files: 3000 })

  it("has the folders and the files asked for, each file listed once in its folder", () => {
    expect(project.folders).toHaveLength(300)
    expect(project.files).toHaveLength(3000)
    const listed = [...project.listings.values()].flatMap((listing) =>
      listing.entries.filter((entry) => !entry.folder),
    )
    expect(listed).toHaveLength(3000)
  })

  it("lists every folder under its parent", () => {
    const parents = new Set(
      [...project.listings.entries()].flatMap(([path, listing]) =>
        listing.entries
          .filter((entry) => entry.folder)
          .map((entry) => (path ? `${path}/` : "") + entry.name),
      ),
    )

    expect(parents).toEqual(new Set(project.folders))
  })

  it("seeds a change in every folder, the root's too, so each opens", () => {
    expect(seedPaths(project)).toHaveLength(301)
  })

  it("is the same project and the same edits for the same seed", () => {
    expect(changedPaths(project, defaults)).toEqual(changedPaths(project, defaults))
    expect(changedPaths(project, { ...defaults, seed: 2 })).not.toEqual(
      changedPaths(project, defaults),
    )
  })
})

describe("the polls", () => {
  it("change the configured number of worktrees, rotating through all of them", () => {
    const config = { ...defaults, worktrees: 5, changed: 2 }

    expect([0, 1, 2, 3].map((poll) => changedIn(poll, config))).toEqual([
      [0, 1],
      [2, 3],
      [4, 0],
      [1, 2],
    ])
  })

  it("make a work of a worktree's files, each once, stamped with the time", () => {
    const work = workOf(0, ["a.ts", "a.ts", "b.ts"], 42, "p")

    expect(work.files.map((file) => [file.path, file.changedAt])).toEqual([
      ["a.ts", 42],
      ["b.ts", 42],
    ])
  })
})

describe("a config", () => {
  it("holds with the defaults", () => {
    expect(configProblem(defaults)).toBeUndefined()
  })

  it("is refused where it can't make a project that opens every folder", () => {
    expect(configProblem({ ...defaults, files: defaults.folders })).toMatch(/exceed/)
    expect(configProblem({ ...defaults, changed: defaults.worktrees + 1 })).toMatch(/exceed/)
    expect(configProblem({ ...defaults, polls: 0 })).toMatch(/1 or more/)
  })
})
