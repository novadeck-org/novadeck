import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { gitAncestry, stacksOf, type Ancestry, type StackTerminal } from "./stacks.js"

const pull = (number: number, base: string) => ({
  number,
  url: "https://example.com",
  title: "T",
  state: "open" as const,
  base,
})

const terminal = (
  handle: string,
  branch: string,
  base: string,
  pullRequest?: ReturnType<typeof pull>,
): StackTerminal => ({
  terminalId: `t-${handle}`,
  handle,
  worktrees: [{ path: `/w/${handle}`, branch, commonDir: "/repo/.git", base, pullRequest }],
})

/** Ancestry from a table: the commits each ref holds, and the default branch's refs. */
const ancestry = (
  holds: Record<string, readonly string[]>,
  seen: { within: string[][]; defaults: string[] } = { within: [], defaults: [] },
): Ancestry => ({
  within: async (cwd, commit, ref) => {
    seen.within.push([cwd, commit, ref])
    return holds[ref]?.includes(commit) ?? false
  },
  defaults: async (cwd) => {
    seen.defaults.push(cwd)
    return ["refs/heads/main", "refs/remotes/origin/main"]
  },
})

describe("work based on another terminal's", () => {
  // Commits by name: `c1` is in the default branch; `c2` lies in fox's branch, which started
  // from c1, and not in the default branch.
  const inside = ancestry({
    "refs/heads/main": ["c1"],
    "feat/a": ["c1", "c2"],
    "feat/b": ["c1", "c2"],
  })

  it("reads a pull request that targets another terminal's branch", async () => {
    const found = await stacksOf(
      [terminal("fox", "feat/a", "c1"), terminal("owl", "feat/b", "c1", pull(12, "feat/a"))],
      ancestry({}),
    )
    expect(found.get("t-owl")).toEqual([
      { onTerminalId: "t-fox", onHandle: "fox", branch: "feat/a", via: "pull-request", pull: 12 },
    ])
    expect(found.get("t-fox")).toBeUndefined()
  })

  it("reads a worktree started from commits inside another's branch", async () => {
    const found = await stacksOf(
      [terminal("fox", "feat/a", "c1"), terminal("owl", "feat/b", "c2")],
      inside,
    )
    expect(found.get("t-owl")).toEqual([
      { onTerminalId: "t-fox", onHandle: "fox", branch: "feat/a", via: "commits" },
    ])
  })

  it("reads nothing of worktrees started from the same commit, or from the default branch", async () => {
    expect(
      await stacksOf(
        [terminal("fox", "feat/a", "c1"), terminal("owl", "feat/b", "c1")],
        ancestry({ "feat/a": ["c1"], "refs/heads/main": ["c1"] }),
      ),
    ).toEqual(new Map())
    // c3 is in fox's branch but also in the default branch (its remote-tracking ref).
    expect(
      await stacksOf(
        [terminal("fox", "feat/a", "c1"), terminal("owl", "feat/b", "c3")],
        ancestry({ "feat/a": ["c1", "c3"], "refs/remotes/origin/main": ["c3"] }),
      ),
    ).toEqual(new Map())
  })

  it("reads nothing across repositories", async () => {
    const other = terminal("owl", "feat/b", "c2", pull(12, "feat/a"))
    const found = await stacksOf(
      [
        terminal("fox", "feat/a", "c1"),
        { ...other, worktrees: [{ ...other.worktrees[0]!, commonDir: "/other/.git" }] },
      ],
      inside,
    )
    expect(found.size).toBe(0)
  })

  it("reads nothing of a worktree opened from newer main than a branch that merged main in", async () => {
    // fox's branch merged main (c5) into it; owl opened from that newer main.
    const found = await stacksOf(
      [terminal("fox", "feat/a", "c1"), terminal("owl", "feat/b", "c5")],
      ancestry({ "refs/heads/main": ["c1", "c5"], "feat/a": ["c1", "c5"] }),
    )
    expect(found.size).toBe(0)
  })

  it("asks whether a worktree's base is in the default branch once, then each other branch once", async () => {
    const seen = { within: [] as string[][], defaults: [] as string[] }
    await stacksOf(
      [
        terminal("fox", "feat/a", "c1"),
        terminal("owl", "feat/b", "c2"),
        terminal("elk", "feat/c", "c2"),
      ],
      ancestry({ "refs/heads/main": ["c1"], "feat/a": ["c1", "c2"] }, seen),
    )
    // Each worktree reads the default branch once (two refs), then one ancestry per other branch.
    for (const path of ["/w/owl", "/w/elk"])
      expect(seen.defaults.filter((cwd) => cwd === path)).toHaveLength(1)
    const ofOwl = seen.within.filter(([, commit]) => commit === "c2")
    expect(ofOwl.filter(([, , ref]) => ref?.startsWith("refs/"))).toHaveLength(4)
  })
})

describe("git's ancestry of the default branch", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-stacks-")))
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()

  it("finds a base the default branch holds, which a branch that merged it in holds too", async () => {
    git("init", "--quiet", "-b", "main")
    writeFileSync(join(root, "a"), "1\n")
    git("add", ".")
    git("commit", "-m", "c1")
    git("switch", "-c", "feat/a")
    writeFileSync(join(root, "b"), "1\n")
    git("add", ".")
    git("commit", "-m", "work")
    git("switch", "main")
    writeFileSync(join(root, "c"), "1\n")
    git("add", ".")
    git("commit", "-m", "newer main")
    const newer = git("rev-parse", "HEAD")
    git("switch", "feat/a")
    git("merge", "--no-edit", "main")
    const work = git("rev-parse", "feat/a")
    const reading = gitAncestry()
    const refs = await reading.defaults(root)
    expect(refs).toContain("refs/heads/main")
    // Newer main is in the branch that merged it, and in main: not work waiting on that branch.
    expect(await reading.within(root, newer, "feat/a")).toBe(true)
    expect(await reading.within(root, newer, "refs/heads/main")).toBe(true)
    // The branch's own commit is in the branch only.
    expect(await reading.within(root, work, "feat/a")).toBe(true)
    expect(await reading.within(root, work, "refs/heads/main")).toBe(false)
  })
})
