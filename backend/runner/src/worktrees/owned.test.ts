import type { PullRequest } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { ownedWorktrees, type WorktreesWiring } from "./calls.js"
import type { WorktreeRecord } from "./records.js"
import type { Worktrees } from "./worktrees.js"

const row = (branch: string): WorktreeRecord => ({
  path: `/w/${branch}`,
  commonDir: "/repo/.git",
  branch,
  base: "abc",
  projectId: "p",
  terminalId: "t1",
  adopted: false,
  branchMade: true,
  createdAt: 1,
})

const request: PullRequest = {
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "Paging",
  state: "open",
  ci: "passed",
}

const wiring = (
  rows: readonly WorktreeRecord[],
  pullRequest?: WorktreesWiring["pullRequest"],
): WorktreesWiring => ({
  service: { ownedRows: () => rows } as unknown as Worktrees,
  enabled: () => true,
  ready: () => true,
  ...(pullRequest && { pullRequest }),
})

describe("the worktrees a terminal owns, as agents read them", () => {
  it("carry each branch's pull request where a forge found one", () => {
    const asked: string[] = []
    const owned = ownedWorktrees(
      wiring([row("feat/a"), row("feat/b")], (commonDir, branch) => {
        asked.push(`${commonDir} ${branch}`)
        return branch === "feat/a" ? request : undefined
      }),
      "t1",
    )
    expect(owned).toEqual([{ ...row("feat/a"), pullRequest: request }, row("feat/b")])
    expect(asked).toEqual(["/repo/.git feat/a", "/repo/.git feat/b"])
  })

  it("are the rows alone without forges, and none without the service", () => {
    expect(ownedWorktrees(wiring([row("feat/a")]), "t1")).toEqual([row("feat/a")])
    expect(ownedWorktrees(undefined, "t1")).toEqual([])
  })
})
