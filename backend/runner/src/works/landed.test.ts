import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { timing } from "../checkouts/git.js"
import { describe, expect, it as base } from "../test.js"
import { landedByReflog } from "./landed.js"

// An empty global config of the tests' own: Windows git can't open the null device as one.
const config = join(
  realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-landed-config-"))),
  "gitconfig",
)
writeFileSync(config, "[core]\n\tautocrlf = false\n")

const git = (root: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
    },
  ).trim()

const commit = (root: string, file: string) => {
  writeFileSync(join(root, file), `${file}\n`)
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", `add ${file}`)
}

type Repo = {
  readonly root: string
  readonly git: (...args: string[]) => string
  readonly commit: (file: string) => void
  /** Whether `branch`, at its tip now, reads as landed in `holders`. */
  readonly landed: (branch: string, holders?: readonly string[]) => Promise<boolean>
}

// A repository on main with one commit, and `feat/x` one commit ahead of it, main checked out.
const it = base.extend<{ repo: Repo }>({
  repo: async ({ resources }, use) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-landed-")))
    resources.defer(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
    git(root, "init", "--quiet", "-b", "main")
    commit(root, "a.txt")
    git(root, "switch", "--quiet", "-c", "feat/x")
    commit(root, "x.txt")
    git(root, "switch", "--quiet", "main")
    await use({
      root,
      git: (...args) => git(root, ...args),
      commit: (file) => commit(root, file),
      landed: (branch, holders = ["main"]) =>
        landedByReflog(
          root,
          join(root, ".git"),
          holders,
          branch,
          git(root, "rev-parse", branch),
          undefined,
        ),
    })
  },
})

describe("a branch landed, as git's reflog says", () => {
  it("reads a plain merge that fast-forwarded, and --ff-only", async ({ repo }) => {
    expect(await repo.landed("feat/x")).toBe(false)
    repo.git("merge", "--quiet", "--ff-only", "feat/x")
    expect(repo.git("reflog", "-1", "--format=%gs")).toBe("merge feat/x: Fast-forward")
    expect(await repo.landed("feat/x")).toBe(true)
  })

  it("reads a merge commit, with --no-ff or because main moved", async ({ repo }) => {
    repo.git("merge", "--quiet", "--no-ff", "-m", "land", "feat/x")
    expect(await repo.landed("feat/x")).toBe(true)
    repo.git("switch", "--quiet", "-c", "feat/y", "HEAD~1")
    repo.commit("y.txt")
    repo.git("switch", "--quiet", "main")
    repo.commit("m.txt")
    repo.git("merge", "--quiet", "feat/y")
    expect(await repo.landed("feat/y")).toBe(true)
  })

  it("reads `git pull . <branch>`, fast-forward or merge commit", async ({ repo }) => {
    repo.git("pull", "--quiet", ".", "feat/x")
    expect(await repo.landed("feat/x")).toBe(true)
    repo.git("switch", "--quiet", "-c", "feat/y", "HEAD")
    repo.commit("y.txt")
    repo.git("switch", "--quiet", "main")
    repo.commit("m.txt")
    repo.git("pull", "--quiet", "--no-rebase", "--no-edit", ".", "feat/y")
    expect(await repo.landed("feat/y")).toBe(true)
  })

  it("reads a rebase onto main followed by a fast-forward", async ({ repo }) => {
    repo.commit("m.txt")
    repo.git("switch", "--quiet", "feat/x")
    repo.git("rebase", "--quiet", "main")
    repo.git("switch", "--quiet", "main")
    repo.git("merge", "--quiet", "--ff-only", "feat/x")
    expect(await repo.landed("feat/x")).toBe(true)
  })

  it("reads a merge that named the branch by its full ref or its tip", async ({ repo }) => {
    repo.git("merge", "--quiet", "refs/heads/feat/x")
    expect(await repo.landed("feat/x")).toBe(true)
    repo.git("reset", "--quiet", "--hard", "HEAD~1")
    repo.git("merge", "--quiet", repo.git("rev-parse", "feat/x"))
    expect(await repo.landed("feat/x")).toBe(true)
  })

  it("reads a landing on home, which isn't main", async ({ repo }) => {
    repo.git("branch", "JIRA-123")
    repo.git("switch", "--quiet", "JIRA-123")
    repo.git("merge", "--quiet", "--ff-only", "feat/x")
    repo.git("switch", "--quiet", "main")
    // Main never saw it: only home's reflog does.
    expect(await repo.landed("feat/x", ["main"])).toBe(false)
    expect(await repo.landed("feat/x", ["JIRA-123", "main"])).toBe(true)
  })

  it("reads a landing in the local side of a remote-tracking main", async ({ repo }) => {
    repo.git("merge", "--quiet", "--ff-only", "feat/x")
    expect(await repo.landed("feat/x", ["origin/main"])).toBe(true)
  })

  it("doesn't read a branch that only caught up with main", async ({ repo }) => {
    // Another branch lands (a fast-forward, which main's log says as `merge other`), and this
    // one takes it in: its head is main's, which no merge line names it for.
    repo.git("switch", "--quiet", "-c", "caught-up", "main")
    repo.git("switch", "--quiet", "main")
    repo.git("merge", "--quiet", "--ff-only", "feat/x")
    repo.git("switch", "--quiet", "caught-up")
    repo.git("merge", "--quiet", "--ff-only", "main")
    expect(await repo.landed("caught-up")).toBe(false)
  })

  it("doesn't read a squash, a reset or a moved ref, which name no merge", async ({ repo }) => {
    repo.git("merge", "--quiet", "--squash", "feat/x")
    repo.git("commit", "--quiet", "-m", "squashed")
    expect(await repo.landed("feat/x")).toBe(false)
    repo.git("reset", "--quiet", "--hard", "feat/x")
    expect(await repo.landed("feat/x")).toBe(false)
    repo.git("update-ref", "refs/heads/main", "feat/x")
    expect(await repo.landed("feat/x")).toBe(false)
  })

  it("doesn't read a branch that went on after it landed", async ({ repo }) => {
    repo.git("merge", "--quiet", "--ff-only", "feat/x")
    // The branch went on after it landed: its tip is no longer what the merge brought in.
    repo.git("switch", "--quiet", "feat/x")
    repo.commit("more.txt")
    repo.git("switch", "--quiet", "main")
    expect(await repo.landed("feat/x")).toBe(false)
  })

  it("doesn't read a landing that home no longer holds", async ({ repo }) => {
    repo.git("merge", "--quiet", "--ff-only", "feat/x")
    repo.git("reset", "--quiet", "--hard", "HEAD~1")
    expect(await repo.landed("feat/x")).toBe(false)
  })

  it("doesn't read a name reused for another branch", async ({ repo }) => {
    repo.git("merge", "--quiet", "--ff-only", "feat/x")
    repo.git("branch", "--quiet", "-D", "feat/x")
    repo.git("branch", "feat/x", "HEAD~1")
    expect(await repo.landed("feat/x")).toBe(false)
  })

  it("reads as not landed where the reflog expired, there is none, or the branch is at its start", async ({
    repo,
  }) => {
    repo.git("merge", "--quiet", "--ff-only", "feat/x")
    expect(await repo.landed("feat/x")).toBe(true)
    repo.git("reflog", "expire", "--expire=now", "--all")
    expect(await repo.landed("feat/x")).toBe(false)
    // A branch still at its start has done nothing to land.
    const head = repo.git("rev-parse", "feat/x")
    expect(
      await landedByReflog(repo.root, join(repo.root, ".git"), ["main"], "feat/x", head, head),
    ).toBe(false)
    expect(await landedByReflog(repo.root, undefined, ["main"], "feat/x", head, undefined)).toBe(
      false,
    )
  })

  it("runs no git where no merge line names the branch", async ({ repo }) => {
    repo.git("merge", "--quiet", "--ff-only", "feat/x")
    repo.git("switch", "--quiet", "-c", "other", "HEAD~1")
    repo.commit("o.txt")
    const runs: string[][] = []
    const before = timing.saw
    timing.saw = (args) => runs.push([...args])
    try {
      expect(await repo.landed("other")).toBe(false)
      expect(runs).toEqual([])
      expect(await repo.landed("feat/x")).toBe(true)
      // The three questions of its one candidate, no more.
      expect(runs).toHaveLength(3)
    } finally {
      timing.saw = before
    }
  })
})
