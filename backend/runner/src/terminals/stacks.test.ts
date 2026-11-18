import { describe, expect, it } from "vitest"

import { stacksOf, type Ancestor, type StackTerminal } from "./stacks.js"

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

describe("work based on another terminal's", () => {
  // Commits by name: `c2` lies in fox's branch, after the `c1` it started from.
  const inside: Ancestor = async (_cwd, commit, ref) =>
    (commit === "c2" && ref === "feat/a") || (commit === "c1" && ref === "c1") || commit === "c1"

  it("reads a pull request that targets another terminal's branch", async () => {
    const found = await stacksOf(
      [terminal("fox", "feat/a", "c1"), terminal("owl", "feat/b", "c1", pull(12, "feat/a"))],
      async () => false,
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
        async () => true,
      ),
    ).toEqual(new Map())
    // c3 is in fox's branch but also before where fox started: it is the default branch's.
    expect(
      await stacksOf(
        [terminal("fox", "feat/a", "c1"), terminal("owl", "feat/b", "c3")],
        async () => true,
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
})
