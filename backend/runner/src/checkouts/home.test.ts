import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { gitIn, withOrigin } from "../testing/origin.js"
import { keysOf, keysOfBranch, parseKeys, targetOf, writeKeys } from "./home.js"

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd: root,
    encoding: "utf8",
  }).trim()

const commit = (root: string, file: string) => {
  writeFileSync(join(root, file), `${file}\n`)
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", `add ${file}`)
  return git(root, "rev-parse", "HEAD")
}

// A repository with a commit on main and no remote.
const it = base.extend<{ root: string }>({
  root: async ({ resources }, use) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-home-")))
    resources.defer(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
    git(root, "init", "--quiet", "-b", "main")
    commit(root, "a.txt")
    await use(root)
  },
})

describe("a branch's keys, parsed", () => {
  it("splits the branch at the key's last dot and reads git's lowercased names", () => {
    const keys = parseKeys(
      "branch.feat/v1.2.novadeckhome\nJIRA-123\0" +
        "branch.feat/v1.2.novadeckbase\nabc123\0" +
        "branch.feat/v1.2.novadeckmade\ntrue\0" +
        "branch.other.novadeckmade\0" +
        "branch.off.novadeckmade\nno\0" +
        "branch.feat/v1.2.novadecktitle\nFix the: rounding\0",
    )
    expect(keys.get("feat/v1.2")).toEqual({
      home: "JIRA-123",
      base: "abc123",
      made: true,
      title: "Fix the: rounding",
    })
    // A boolean set with no value is true, as git reads it.
    expect(keys.get("other")).toEqual({ made: true })
    expect(keys.get("off")).toEqual({ made: false })
  })

  it("passes over keys that aren't Novadeck's, and empty values", () => {
    const keys = parseKeys("branch.x.novadeckhome\n\0branch.x.remote\norigin\0core.bare\nfalse\0")
    expect(keys.size).toBe(0)
  })
})

describe("a branch's keys in git config", () => {
  it("writes them where every worktree of the repository reads them, and unsets them", async ({
    root,
    resources,
  }) => {
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-home-wt-")))
    resources.defer(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
    const worktree = join(elsewhere, "w")
    git(root, "worktree", "add", "--quiet", "-b", "agent", worktree)
    expect(await keysOfBranch(worktree, "agent")).toEqual({})
    expect(await writeKeys(worktree, "agent", { home: "main", base: "abc", made: true })).toBe(true)
    expect(await keysOfBranch(root, "agent")).toEqual({ home: "main", base: "abc", made: true })
    expect(git(root, "config", "--get", "branch.agent.novadeckHome")).toBe("main")
    expect(await writeKeys(root, "agent", { home: null })).toBe(true)
    expect(await keysOfBranch(worktree, "agent")).toEqual({ base: "abc", made: true })
    // Unsetting what isn't there leaves it as asked.
    expect(await writeKeys(root, "agent", { home: null })).toBe(true)
    expect(await writeKeys(worktree, "agent", { title: "Rounding fix · ünïcode" })).toBe(true)
    expect(git(root, "config", "--get", "branch.agent.novadeckTitle")).toBe(
      "Rounding fix · ünïcode",
    )
    expect((await keysOfBranch(root, "agent")).title).toBe("Rounding fix · ünïcode")
  })

  it("reads a change made by hand, and follows a renamed branch", async ({ root }) => {
    git(root, "branch", "agent")
    await writeKeys(root, "agent", { home: "main" })
    expect((await keysOf(root)).get("agent")).toEqual({ home: "main" })
    git(root, "config", "branch.agent.novadeckHome", "trunk")
    expect((await keysOf(root)).get("agent")).toEqual({ home: "trunk" })
    git(root, "branch", "-m", "agent", "renamed")
    expect((await keysOf(root)).get("renamed")).toEqual({ home: "trunk" })
    git(root, "branch", "-D", "renamed")
    expect((await keysOf(root)).size).toBe(0)
  })

  it("waits out another writer's lock on the config", async ({ root }) => {
    git(root, "branch", "agent")
    const lock = join(root, ".git", "config.lock")
    writeFileSync(lock, "")
    const writing = writeKeys(root, "agent", { home: "main" })
    setTimeout(() => rmSync(lock, { force: true }), 100)
    expect(await writing).toBe(true)
    expect(await keysOfBranch(root, "agent")).toEqual({ home: "main" })
  })
})

describe("what a checkout is measured against", () => {
  it("is the repository's main where its branch has no home", async ({ root }) => {
    const main = git(root, "rev-parse", "main")
    git(root, "checkout", "--quiet", "-b", "agent")
    const target = await targetOf(root, "agent")
    expect(target?.main).toMatchObject({ name: "main", commit: main })
    expect(target?.holders.map((each) => each.name)).toEqual(["main"])
    expect(target?.home).toBeUndefined()
  })

  it("is home where its branch names one, with main among the holders", async ({ root }) => {
    git(root, "checkout", "--quiet", "-b", "JIRA-123")
    const jira = commit(root, "j.txt")
    git(root, "checkout", "--quiet", "-b", "agent")
    await writeKeys(root, "agent", { home: "JIRA-123", base: jira })
    const target = await targetOf(root, "agent")
    expect(target).toMatchObject({ home: "JIRA-123", base: jira })
    expect(target?.main).toMatchObject({ name: "JIRA-123", commit: jira })
    expect(target?.holders.map((each) => each.name)).toEqual(["JIRA-123", "main"])
  })

  it("falls back to main once home is gone", async ({ root }) => {
    git(root, "branch", "JIRA-123")
    git(root, "checkout", "--quiet", "-b", "agent")
    await writeKeys(root, "agent", { home: "JIRA-123" })
    git(root, "branch", "-D", "JIRA-123")
    const target = await targetOf(root, "agent")
    expect(target?.main.name).toBe("main")
    expect(target?.home).toBeUndefined()
  })

  it("measures by home's remote branch where it holds local home, else by local home", async ({
    resources,
  }) => {
    const origin = withOrigin(resources.defer.bind(resources))
    const { repo } = origin
    gitIn(repo, "checkout", "--quiet", "-b", "JIRA-123")
    commit(repo, "j.txt")
    gitIn(repo, "push", "--quiet", "-u", "origin", "JIRA-123")
    gitIn(repo, "checkout", "--quiet", "-b", "agent")
    await writeKeys(repo, "agent", { home: "JIRA-123" })
    // Pushed: both hold the same, and the remote one is measured by, as main's is today.
    expect((await targetOf(repo, "agent"))?.main.name).toBe("origin/JIRA-123")
    // A landing ahead of the remote: local home has more, and is measured by.
    gitIn(repo, "checkout", "--quiet", "JIRA-123")
    const landed = commit(repo, "landed.txt")
    gitIn(repo, "checkout", "--quiet", "agent")
    const target = await targetOf(repo, "agent")
    expect(target?.main).toMatchObject({ name: "JIRA-123", commit: landed })
    expect(target?.holders.map((each) => each.name)).toEqual([
      "JIRA-123",
      "origin/JIRA-123",
      "origin/main",
    ])
  })

  it("is nothing for a detached checkout of a repository with no main", async ({ root }) => {
    git(root, "branch", "-m", "main", "trunk")
    git(root, "checkout", "--quiet", "--detach")
    expect(await targetOf(root, null)).toBeUndefined()
  })
})
