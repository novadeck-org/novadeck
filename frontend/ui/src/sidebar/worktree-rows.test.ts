import type { PullRequest, PullRequestCheck } from "@novadeck/core/forges"
import type { Work, WorkFile } from "@novadeck/core/works"

import { describe, expect, it } from "../test"
import {
  chainOf,
  checksBar,
  closeMode,
  conflictWords,
  descendantsOf,
  dormantMs,
  litOf,
  needOf,
  orderedWorks,
  ownerOpen,
  pullMark,
  roleOf,
  selectedRoot,
  stateOf,
  targetOf,
  worktreeRows,
  worktreeTeams,
} from "./worktree-rows"

const file = (path: string, added: number, removed: number): WorkFile => ({
  path,
  status: "modified",
  changedAt: 1,
  added,
  removed,
  unreadAdded: added,
  unreadRemoved: removed,
  conflict: false,
})

// A work whose root is `/r/<name>`, owned by the terminal `t-<name>` unless said otherwise, with
// one uncommitted file.
const work = (name: string, firstSeenAt: number, extra: Partial<Work> = {}): Work => ({
  root: `/r/${name}`,
  terminalId: `t-${name}`,
  projectId: "p",
  working: false,
  branch: `feat/${name}`,
  base: "main",
  firstSeenAt,
  merged: false,
  added: 1,
  removed: 0,
  unreadAdded: 1,
  unreadRemoved: 0,
  files: [file("a.ts", 1, 0)],
  truncated: false,
  conflicts: [],
  uncommitted: 1,
  unpushed: 0,
  ...extra,
})

const pull = (state: PullRequest["state"], extra: Partial<PullRequest> = {}): PullRequest => ({
  number: 812,
  url: "https://github.com/acme/shop/pull/812",
  title: "Checkout",
  state,
  ...extra,
})

const checks = (...states: PullRequestCheck["state"][]): PullRequestCheck[] =>
  states.map((state, index) => ({ name: `job ${index}`, state }))

const now = 100 * dormantMs

describe("the Worktrees panel's rows", () => {
  it("lists works newest first, by when they were first seen", () => {
    expect(orderedWorks([work("a", 1), work("c", 3), work("b", 2)]).map((w) => w.root)).toEqual([
      "/r/c",
      "/r/b",
      "/r/a",
    ])
  })

  it("lists works first seen together newest first too, the runner sending the oldest first", () => {
    expect(orderedWorks([work("a", 1), work("b", 1)]).map((w) => w.root)).toEqual(["/r/b", "/r/a"])
  })

  it("names a row by its title, else its branch, and a detached one's as detached", () => {
    const [titled, plain, detached] = worktreeRows(
      [work("a", 3, { title: "Rounding fix" }), work("b", 2), work("c", 1, { branch: null })],
      new Map(),
      now,
    )
    expect([titled!.name, titled!.untitled]).toEqual(["Rounding fix", false])
    expect([plain!.name, plain!.untitled]).toEqual(["feat/b", true])
    expect([detached!.name, detached!.branch]).toEqual(["detached", "detached"])
  })

  it("carries its owner's handle, unread lines and whether it is safe", () => {
    const [row] = worktreeRows(
      [work("a", 1, { safe: true })],
      new Map([["t-a", "A"]]),
      now,
      new Map([["t-a", "moth"]]),
    )
    expect([row!.handle, row!.owner, row!.unread, row!.safe]).toEqual(["moth", "A", true, true])
  })

  it("says it all in its accessible label", () => {
    const [row] = worktreeRows(
      [
        work("a", 1, {
          title: "Rounding fix",
          working: true,
          pullRequest: pull("open", {
            ci: "running",
            checks: checks("passed", "running"),
            review: "required",
          }),
        }),
      ],
      new Map([["t-a", "A"]]),
      now,
      new Map([["t-a", "moth"]]),
    )
    expect(row!.label).toBe(
      "Rounding fix, #812, open pull request, 1 of 2 checks passed, 1 running; approval missing, files changing, feat/a into main, @moth",
    )
  })
})

describe("where a work goes", () => {
  it("is its pull request's target, else its home, else main without its remote", () => {
    expect(
      targetOf(work("a", 1, { home: "dev", pullRequest: pull("open", { base: "release" }) })),
    ).toBe("release")
    expect(targetOf(work("a", 1, { home: "dev", base: "origin/dev" }))).toBe("dev")
    expect(targetOf(work("a", 1, { base: "origin/main" }))).toBe("main")
    expect(targetOf(work("a", 1, { base: "trunk" }))).toBe("trunk")
  })
})

describe("what a worktree is doing", () => {
  it("is changing while its agent works, whatever else holds", () => {
    expect(stateOf(work("a", 1, { working: true, merged: true }), now)).toBe("changing")
  })

  it("is over once its pull request closed unmerged, landed once merged by git or the forge", () => {
    expect(stateOf(work("a", 1, { pullRequest: pull("closed") }), now)).toBe("over")
    expect(stateOf(work("a", 1, { merged: true, files: [] }), now)).toBe("landed")
    expect(stateOf(work("a", 1, { pullRequest: pull("merged") }), now)).toBe("landed")
  })

  it("follows its open pull request's checks", () => {
    expect(stateOf(work("a", 1, { pullRequest: pull("open", { ci: "failing" }) }), now)).toBe(
      "failed",
    )
    expect(stateOf(work("a", 1, { pullRequest: pull("draft", { ci: "running" }) }), now)).toBe(
      "checks",
    )
    expect(stateOf(work("a", 1, { pullRequest: pull("open", { ci: "passed" }) }), now)).toBe("rest")
  })

  it("can't be read where git's standing is missing", () => {
    const { uncommitted: _, ...unread } = work("a", 1)
    expect(stateOf(unread, now)).toBe("unknown")
  })

  it("is dormant once untouched a day, empty with nothing in it, else at rest", () => {
    expect(stateOf(work("a", 1, { changedAt: now - dormantMs }), now)).toBe("dormant")
    expect(stateOf(work("a", 1, { changedAt: now - dormantMs + 1 }), now)).toBe("rest")
    expect(stateOf(work("a", 1, { files: [], uncommitted: 0 }), now)).toBe("empty")
    expect(stateOf(work("a", 1, { files: [], uncommitted: 0, unpushed: 2 }), now)).toBe("rest")
    expect(
      stateOf(work("a", 1, { files: [], uncommitted: 0, pullRequest: pull("draft") }), now),
    ).toBe("rest")
  })
})

describe("what a worktree needs of the person", () => {
  const titles = new Map([["t-a", "A"]])

  it("is ! for a conflict, named by the branch git measured it against", () => {
    expect(
      needOf(
        work("a", 1, { home: "dev", base: "origin/dev", conflicts: [{ with: "main" }] }),
        titles,
        [],
      ),
    ).toEqual({ need: "unblock", why: "Conflicts with dev" })
    // A stacked pull request without a recorded home targets its base, but git measured main.
    expect(
      needOf(
        work("a", 1, {
          base: "origin/main",
          conflicts: [{ with: "main" }],
          pullRequest: pull("open", { base: "feat/x" }),
        }),
        titles,
        [],
      )?.why,
    ).toBe("Conflicts with main")
  })

  it("is ! for what landed or closed but left work here", () => {
    expect(needOf(work("a", 1, { merged: true, safe: false, uncommitted: 2 }), titles, [])).toEqual(
      {
        need: "unblock",
        why: "Landed in main; 2 files not committed here",
      },
    )
    expect(
      needOf(
        work("a", 1, { pullRequest: pull("closed"), safe: false, uncommitted: 0, unpushed: 1 }),
        titles,
        [],
      ),
    ).toEqual({ need: "unblock", why: "Pull request closed; 1 commit not pushed here" })
  })

  it("is ! for work only here with no agent on it", () => {
    expect(needOf(work("b", 1, { terminalId: null, uncommitted: 3 }), titles, [])).toEqual({
      need: "unblock",
      why: "3 files only here, and no agent on it",
    })
    // Its owner in History keeps its handle on the row.
    expect(needOf(work("b", 1, { uncommitted: 3 }), titles, [])?.why).toBe(
      "3 files only here, and its agent's terminal is closed",
    )
    expect(needOf(work("b", 1, { uncommitted: 0 }), titles, [])).toBeUndefined()
  })

  it("is ? once an open pull request's checks passed", () => {
    expect(
      needOf(work("a", 1, { pullRequest: pull("open", { ci: "passed" }) }), titles, []),
    ).toEqual({
      need: "ask",
      why: "Checks passed: yours to merge",
    })
    expect(
      needOf(work("a", 1, { pullRequest: pull("draft", { ci: "passed" }) }), titles, []),
    ).toBeUndefined()
    expect(
      needOf(
        work("a", 1, {
          conflicts: [{ with: "main" }],
          pullRequest: pull("open", { ci: "passed" }),
        }),
        titles,
        [],
      )?.need,
    ).toBe("unblock")
  })

  it("is nothing for a landed work's leftover conflict", () => {
    expect(
      needOf(work("a", 1, { merged: true, safe: true, conflicts: [{ with: "main" }] }), titles, []),
    ).toBeUndefined()
  })
})

describe("a pull request's checks bar", () => {
  it("draws each check, passed, failed, running then waiting, and its review", () => {
    const bar = checksBar(
      pull("open", {
        checks: checks("waiting", "passed", "running", "failed", "passed"),
        review: "approved",
      }),
    )!
    expect(bar.segments.map((each) => each.state)).toEqual([
      "passed",
      "passed",
      "failed",
      "running",
      "waiting",
    ])
    expect(bar.review).toBe("approved")
    expect(bar.words).toBe("2 of 5 checks passed, 1 failed, 1 running, 1 waiting; approved")
  })

  it("draws one segment per state past twelve checks, as wide as its share", () => {
    const bar = checksBar(
      pull("open", {
        checks: [
          ...checks(...Array(10).fill("passed")),
          ...checks("running", "running", "waiting"),
        ],
      }),
    )!
    expect(bar.segments.map(({ state, weight }) => ({ state, weight }))).toEqual([
      { state: "passed", weight: 10 },
      { state: "running", weight: 2 },
      { state: "waiting", weight: 1 },
    ])
    expect(bar.words).toBe("10 of 13 checks passed, 2 running, 1 waiting")
  })

  it("is the review alone where no check ran, and none without either or once done", () => {
    expect(checksBar(pull("draft", { review: "none" }))).toEqual({
      segments: [],
      review: "none",
      words: "no review asked for",
    })
    expect(checksBar(pull("open"))).toBeUndefined()
    expect(
      checksBar(pull("merged", { checks: checks("passed"), review: "approved" })),
    ).toBeUndefined()
  })
})

describe("what a row's trash button does", () => {
  it("asks the runner to close, whatever the work holds: its standing is the runner's to say", () => {
    expect(closeMode(work("a", 1, { files: [] }))).toBe("close")
    expect(closeMode(work("a", 1))).toBe("close")
  })

  it("waits while the owner's agent is working in it", () => {
    expect(closeMode(work("a", 1, { working: true }))).toBe("busy")
  })
})

describe("a row's pull request mark", () => {
  it("reads its number, and says its state in words", () => {
    expect(pullMark(pull("draft"))).toEqual({
      state: "draft",
      text: "#812",
      label: "#812, draft pull request",
      url: "https://github.com/acme/shop/pull/812",
    })
  })

  it("opens only a web page", () => {
    expect(pullMark({ ...pull("open"), url: "javascript:alert(1)" }).url).toBeUndefined()
  })
})

describe("whether an owner has a bar", () => {
  it("is so for a terminal of any project, not for none or one in History", () => {
    const titles = new Map([["t", "Open"]])
    expect(ownerOpen("t", titles)).toBe(true)
    expect(ownerOpen("gone", titles)).toBe(false)
    expect(ownerOpen(null, titles)).toBe(false)
  })
})

describe("the selected row", () => {
  const works = [
    work("a", 1, { terminalId: "t" }),
    work("b", 2, { terminalId: "t" }),
    work("o", 3, { terminalId: null }),
  ]

  it("is none while no terminal is selected", () => {
    expect(selectedRoot(works, undefined, { root: "/r/a", on: "t" })).toBeUndefined()
  })

  it("is the first worktree the selected terminal owns", () => {
    expect(selectedRoot(works, "t", undefined)).toBe("/r/a")
    expect(selectedRoot(works, "other", undefined)).toBeUndefined()
  })

  it("is the one last clicked while the terminal it was shown on is selected", () => {
    expect(selectedRoot(works, "t", { root: "/r/b", on: "t" })).toBe("/r/b")
    // A worktree with no owner, shown on the selected terminal's bar.
    expect(selectedRoot(works, "t", { root: "/r/o", on: "t" })).toBe("/r/o")
  })

  it("falls back once the click was on another terminal, or its worktree is gone", () => {
    expect(selectedRoot(works, "t", { root: "/r/o", on: "u" })).toBe("/r/a")
    expect(selectedRoot(works, "t", { root: "/r/zzz", on: "t" })).toBe("/r/a")
  })
})

describe("what a work conflicts with", () => {
  const titles = new Map([["t-b", "Dark mode"]])
  it("says nothing for a work that is fine", () => {
    expect(conflictWords(work("a", 1), titles)).toBeUndefined()
  })

  it("names main and another work's owner's title", () => {
    const both = work("a", 1, {
      conflicts: [{ with: "main" }, { with: "work", root: "/r/b", terminalId: "t-b" }],
    })
    expect(conflictWords(both, titles)).toBe("Conflicts with main, Dark mode")
  })

  it("names a worktree with no owner by its branch", () => {
    const other = work("o", 2, { terminalId: null, branch: "feat/old" })
    const one = work("a", 1, {
      conflicts: [{ with: "work", root: "/r/o", terminalId: null }],
    })
    expect(conflictWords(one, titles, [one, other])).toBe("Conflicts with feat/old")
    expect(conflictWords(one, titles)).toBe("Conflicts with another worktree")
  })
})

describe("teams of worktrees", () => {
  // `lead` on main; `a` and `b` head to its branch, `c` to `a`'s; `x` stands alone.
  const works = [
    work("lead", 1),
    work("a", 4, { home: "feat/lead", base: "origin/feat/lead" }),
    work("x", 5),
    work("b", 2, { pullRequest: pull("open", { base: "feat/lead" }) }),
    work("c", 3, { home: "feat/a", base: "origin/feat/a" }),
  ]
  const teams = worktreeTeams(works)
  const roots = (list: readonly string[]) => list.map((root) => root.slice(3))

  it("hangs a worktree under the one whose branch it heads to, its members newest first", () => {
    expect(roots(teams.order.map((each) => each.root))).toEqual(["x", "lead", "a", "c", "b"])
    expect(teams.teams.map(({ lead, workers }) => [lead.slice(3), roots(workers)])).toEqual([
      ["lead", ["a", "b"]],
      ["a", ["c"]],
    ])
  })

  it("knows the leads above a worktree and those under it", () => {
    expect(roots(chainOf(teams, "/r/c"))).toEqual(["a", "lead"])
    expect(chainOf(teams, "/r/x")).toEqual([])
    expect(roots(descendantsOf(teams, "/r/lead"))).toEqual(["a", "c", "b"])
  })

  it("lights the selected worktree's teams and the way up", () => {
    const lit = litOf(teams, "/r/a")
    expect(lit.full.map((team) => team.lead.slice(3))).toEqual(["lead", "a"])
    expect(litOf(teams, "/r/c").path).toEqual([{ lead: "/r/lead", child: "/r/a" }])
    expect(litOf(teams, undefined)).toEqual({ full: [], path: [] })
  })

  it("tints the selected worktree's whole tree, leads as leads", () => {
    expect(roleOf(teams, "/r/lead", "/r/c")).toBe("lead")
    expect(roleOf(teams, "/r/a", "/r/c")).toBe("lead")
    expect(roleOf(teams, "/r/b", "/r/c")).toBe("worker")
    expect(roleOf(teams, "/r/x", "/r/c")).toBeUndefined()
    expect(roleOf(teams, "/r/lead", "/r/x")).toBeUndefined()
  })

  it("leaves a target no worktree has open as it is", () => {
    const alone = worktreeTeams([work("a", 1, { home: "release", base: "origin/release" })])
    expect(alone.teams).toEqual([])
  })

  it("breaks a ring of worktrees heading to each other at its newest", () => {
    const ring = worktreeTeams([
      work("a", 1, { home: "feat/b", base: "origin/feat/b" }),
      work("b", 2, { home: "feat/a", base: "origin/feat/a" }),
    ])
    expect(roots(ring.order.map((each) => each.root))).toEqual(["b", "a"])
    expect(ring.teams.map(({ lead, workers }) => [lead.slice(3), roots(workers)])).toEqual([
      ["b", ["a"]],
    ])
  })

  it("gives each row the leads above it", () => {
    expect(
      worktreeRows(works, new Map(), now).map((row) => [row.work.root.slice(3), roots(row.above)]),
    ).toEqual([
      ["x", []],
      ["lead", []],
      ["a", ["lead"]],
      ["c", ["a", "lead"]],
      ["b", ["lead"]],
    ])
  })
})
