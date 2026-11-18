import { describe, expect, it } from "vitest"

import {
  checksLine,
  coordinationLines,
  partiesOf,
  pullsOf,
  statedLine,
  unnamedRunner,
  type Party,
} from "./coordination.js"
import { peerOf } from "./peers.js"

const now = Date.parse("2026-01-01T12:00:00Z")
const ago = (min: number): number => now - min * 60_000

const party = (handle: string, pulls: Party["pulls"], more: Partial<Party> = {}): Party => ({
  terminalId: `t-${handle}`,
  handle,
  pulls,
  stacks: [],
  ...more,
})

describe("runner lines", () => {
  const fox = party("fox", [
    {
      number: 10,
      branch: "a",
      checks: [
        { name: "mac", state: "running", since: ago(9), runner: "macos-latest" },
        { name: "mac 2", state: "running", since: ago(12), runner: "macos-latest" },
        { name: "lint", state: "running", since: ago(1), runner: "ubuntu-latest" },
      ],
    },
  ])
  const owl = party("owl", [
    {
      number: 11,
      branch: "b",
      checks: [{ name: "mac", state: "queued", since: ago(14), runner: "macos-latest" }],
    },
  ])
  const me = party(
    "moth",
    [{ number: 12, branch: "c", checks: [{ name: "x", state: "queued" }] }],
    {
      you: true,
    },
  )

  it("says who holds each kind of runner and who is queued for it, with how long", () => {
    expect(coordinationLines([me, fox, owl], now)).toEqual([
      "CI checks running or queued in this project and session, by kind of runner (from the forge, as of its last look):",
      "- macos-latest: running: @fox's PR #10 (2 checks, 12 min) · queued: @owl's PR #11 (14 min)",
      "- ubuntu-latest: running: @fox's PR #10 (1 min)",
      `- ${unnamedRunner}: queued: your PR #12`,
    ])
  })

  it("says nothing without unfinished checks", () => {
    expect(coordinationLines([party("fox", [])], now)).toEqual([])
  })
})

describe("a terminal's checks line", () => {
  it("names each unfinished check, its state, how long and its runner", () => {
    expect(
      checksLine(
        [
          {
            number: 12,
            branch: "b",
            checks: [
              { name: "mac", state: "queued", since: ago(14), runner: "macos-latest" },
              { name: "linux", state: "running" },
            ],
          },
        ],
        now,
      ),
    ).toBe("  checks: PR #12: mac queued 14 min (macos-latest), linux running")
  })

  it("reads the pull requests that have checks off a worktree list", () => {
    const pullRequest = {
      number: 3,
      url: "https://example.com/3",
      title: "T",
      state: "open" as const,
      ci: "running" as const,
      checks: [{ name: "mac", state: "queued" as const }],
    }
    expect(pullsOf([{ branch: "b", pullRequest }, { branch: "c" }])).toEqual([
      { number: 3, branch: "b", checks: pullRequest.checks },
    ])
  })
})

describe("what waits on what", () => {
  it("names work based on another terminal's, from both pull requests and commits", () => {
    const fox = party("fox", [], { terminalId: "t-fox" })
    const owl = party("owl", [], {
      stacks: [
        { onTerminalId: "t-fox", onHandle: "fox", branch: "feat/a", via: "pull-request", pull: 12 },
      ],
    })
    const me = party("moth", [], {
      you: true,
      stacks: [{ onTerminalId: "t-owl", onHandle: "owl", branch: "feat/b", via: "commits" }],
    })
    expect(coordinationLines([me, fox, owl], now)).toEqual([
      "Work based on another terminal's work:",
      "- you wait on @owl's branch feat/b (its worktree started from that branch's commits)",
      "- @owl waits on @fox's branch feat/a (its PR #12 targets that branch)",
    ])
  })

  it("quotes what an agent says it waits on, with when", () => {
    expect(statedLine({ text: "the review\nof PR 9", at: ago(5) }, now)).toBe(
      '  says it waits on: "the review of PR 9" (5 min ago)',
    )
    expect(statedLine(null, now)).toBeNull()
  })

  it("builds parties from a listing's peers and its reader's own work", () => {
    const peer = peerOf({
      terminalId: "t-fox",
      handle: "fox",
      agent: "claude",
      expecting: null,
      busy: false,
      lead: null,
      where: {
        title: null,
        summary: null,
        git: null,
        working: false,
        since: null,
        waiting: null,
        waitsOn: null,
        startup: null,
        happenings: [],
        standing: false,
        shell: { running: false, command: null },
        background: null,
        shown: [],
        worktrees: [],
        stacks: [{ onTerminalId: "t-moth", onHandle: "moth", branch: "x", via: "commits" }],
      },
    })
    const parties = partiesOf({ terminalId: "t-moth", handle: "moth" }, undefined, [peer])
    expect(parties.map(({ handle, you }) => [handle, you ?? false])).toEqual([
      ["moth", true],
      ["fox", false],
    ])
    expect(coordinationLines(parties, now)).toEqual([
      "Work based on another terminal's work:",
      "- @fox waits on your branch x (its worktree started from that branch's commits)",
    ])
  })
})
