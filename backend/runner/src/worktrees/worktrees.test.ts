import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, relative } from "node:path"

import { git as realGit } from "../checkouts/git.js"
import { describe, expect, it as base } from "../test.js"
import { withOrigin } from "../testing/origin.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { fetchTimeoutMs, MainFetcher } from "./fetching.js"
import { finishRemoval, inRepository, nestedRepositories, repositoryKnown } from "./repo.js"
import { Worktrees, folderName } from "./worktrees.js"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  }).trim()

// A path as `git worktree list` prints it: with `/` on Windows too.
const asGit = (path: string): string => path.replaceAll("\\", "/")

const temporary = (resources: { defer: (cleanup: () => void) => void }, name: string): string => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), `novadeck-${name}-`)))
  resources.defer(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5 }))
  return folder
}

// A repository named `name` with a commit on main and a file AGENTS.md.
const repository = (parent: string, name: string): string => {
  const repo = join(parent, name)
  mkdirSync(repo)
  git(repo, "init", "--quiet", "-b", "main")
  writeFileSync(join(repo, "AGENTS.md"), "rules\n")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "--quiet", "-m", "first")
  return repo
}

type Fixture = {
  repo: string
  project: string
  root: string
  store: WorkspaceStore
  live: Set<string>
  worktrees: Worktrees
  other: string
}

const it = base.extend<{ fx: Fixture }>({
  fx: async ({ resources }, use) => {
    const repo = repository(temporary(resources, "wt-repo"), "api")
    const root = temporary(resources, "wt-root")
    const other = temporary(resources, "wt-other")
    const live = new Set(["t1", "t2"])
    const store = new WorkspaceStore(":memory:")
    resources.defer(() => store.close())
    const project = randomUUID()
    await store.createProject({ id: project, name: "P", cwd: repo })
    const worktrees = new Worktrees(store, {
      exists: (id) => live.has(id),
      root,
      projectFolder: () => repo,
    })
    await use({ repo, project, root, store, live, worktrees, other })
  },
})

const open = (f: Fixture, branch: string, extra: object = {}, terminalId = "t1") =>
  f.worktrees.open({
    projectId: f.project,
    terminalId,
    cwd: f.repo,
    branch,
    ...extra,
  })

describe("folderName", () => {
  it("makes a branch safe as one folder", () => {
    expect(folderName("feat/login page")).toBe("feat-login-page")
    expect(folderName("../../etc")).toBe("etc")
    expect(folderName("...")).toBe("")
  })
})

describe("opening a worktree", () => {
  it("makes a new branch from HEAD in the project's group folder, owned by the caller", async ({
    fx: f,
  }) => {
    const head = git(f.repo, "rev-parse", "HEAD")
    const opened = await open(f, "feat/login")
    if (!opened.ok) throw new Error(opened.reason)
    expect(opened.path).toBe(join(f.root, f.project, "feat-login", "api"))
    expect(opened.existing).toBe(false)
    expect(opened.base).toBe(head)
    expect(opened.instructions).toEqual([join(opened.path, "AGENTS.md")])
    expect(git(opened.path, "branch", "--show-current")).toBe("feat/login")
    expect(f.store.worktree(opened.path)).toMatchObject({
      branch: "feat/login",
      base: head,
      terminalId: "t1",
      adopted: false,
      projectId: f.project,
    })
  })

  it("starts from `from` and takes the group it is given", async ({ fx: f }) => {
    writeFileSync(join(f.repo, "b.txt"), "b\n")
    git(f.repo, "add", "-A")
    git(f.repo, "commit", "--quiet", "-m", "second")
    const first = git(f.repo, "rev-parse", "HEAD~1")
    const opened = await open(f, "old", { from: first, group: "work one" })
    if (!opened.ok) throw new Error(opened.reason)
    expect(opened.path).toBe(join(f.root, f.project, "work-one", "api"))
    expect(existsSync(join(opened.path, "b.txt"))).toBe(false)
    expect(opened.base).toBe(first)
  })

  it("checks out a branch that exists, and refuses `from` with it", async ({ fx: f }) => {
    git(f.repo, "branch", "side")
    const refusal = await open(f, "side", { from: "main" })
    expect(refusal).toMatchObject({ ok: false })
    const opened = await open(f, "side")
    if (!opened.ok) throw new Error(opened.reason)
    expect(opened.existing).toBe(true)
    expect(git(opened.path, "branch", "--show-current")).toBe("side")
  })

  // A fetcher that records the fetches it runs, which `every` makes due always when 0.
  const recordingFetcher = (
    resources: { defer: (cleanup: () => void) => void },
    every?: number,
  ) => {
    const fetches: string[] = []
    const fetcher = new MainFetcher({
      environment: {},
      ...(every !== undefined && { every }),
      run: (cwd, args, limit) => {
        if (args.includes("fetch")) fetches.push(cwd)
        return realGit(cwd, args, limit)
      },
    })
    resources.defer(() => fetcher.abort())
    return { fetches, fetcher }
  }

  // A service whose fetcher records the fetches it runs, and what time limit each had.
  const recording = (
    resources: { defer: (cleanup: () => void) => void },
    f: Fixture,
    freshMainMs?: number,
  ) => {
    const fetches: { args: readonly string[]; ms: number | undefined }[] = []
    const fetcher = new MainFetcher({
      environment: {},
      run: (cwd, args, limit) => {
        if (args.includes("fetch")) fetches.push({ args, ms: limit.ms })
        return realGit(cwd, args, limit)
      },
    })
    const worktrees = new Worktrees(f.store, {
      exists: (id) => f.live.has(id),
      root: f.root,
      projectFolder: () => f.repo,
      cleanup: { fetcher },
      ...(freshMainMs !== undefined && { freshMainMs }),
    })
    resources.defer(() => {
      fetcher.abort()
      void worktrees.stop()
    })
    return { fetches, fetcher, worktrees }
  }

  it("starts from the remote's main when the checkout is on a main that is behind it", async ({
    resources,
    fx: f,
  }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    await f.store.createProject({ id: "p2", name: "Q", cwd: origin.repo })
    // A change of its own keeps the checkout where it is, though main is fetched meanwhile.
    writeFileSync(join(origin.repo, "a.txt"), "mine\n")
    const landed = origin.land("b.txt")
    const { fetches, fetcher, worktrees } = recording(resources, f)
    // Fetched a moment ago, so opening doesn't fetch again, and doesn't wait on the network.
    await fetcher.fetchNow([join(origin.repo, ".git")])
    await fetcher.idle()
    const opened = await worktrees.open({
      projectId: "p2",
      terminalId: "t1",
      cwd: origin.repo,
      branch: "feat/new",
    })
    if (!opened.ok) throw new Error(opened.reason)
    expect(fetches).toHaveLength(1)
    expect(opened.base).toBe(landed)
    expect(existsSync(join(opened.path, "b.txt"))).toBe(true)
    // The checkout itself is left alone.
    expect(existsSync(join(origin.repo, "b.txt"))).toBe(false)
  })

  it("checks out origin's branch of that name, tracking it, where only origin has it", async ({
    resources,
    fx: f,
  }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    await f.store.createProject({ id: "p2", name: "Q", cwd: origin.repo })
    // A teammate's pull request branch, pushed since the checkout last fetched.
    const pushed = origin.branch("feat")
    const { worktrees } = recording(resources, f)
    const opened = await worktrees.open({
      projectId: "p2",
      terminalId: "t1",
      cwd: origin.repo,
      branch: "feat",
    })
    if (!opened.ok) throw new Error(opened.reason)
    expect(opened).toMatchObject({
      existing: false,
      base: pushed,
      origin: "current",
      tracking: true,
    })
    expect(git(opened.path, "rev-parse", "HEAD")).toBe(pushed)
    expect(git(opened.path, "rev-parse", "--abbrev-ref", "feat@{upstream}")).toBe("origin/feat")
    // Novadeck made the local branch, so it may go once main holds it.
    expect(f.store.worktree(opened.path)?.branchMade).toBe(true)
  })

  it("passes over a branch origin no longer has, which an earlier fetch left behind", async ({
    resources,
    fx: f,
  }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    await f.store.createProject({ id: "p2", name: "Q", cwd: origin.repo })
    const pushed = origin.branch("merged")
    origin.fetch()
    // Deleted on origin after its merge; the checkout's fetches never prune it, so its ref stays.
    git(origin.repo, "push", "--quiet", "origin", "--delete", "merged")
    git(origin.repo, "update-ref", "refs/remotes/origin/merged", pushed)
    const head = git(origin.repo, "rev-parse", "HEAD")
    const { worktrees } = recording(resources, f)
    const opened = await worktrees.open({
      projectId: "p2",
      terminalId: "t1",
      cwd: origin.repo,
      branch: "merged",
    })
    if (!opened.ok) throw new Error(opened.reason)
    expect(opened).toMatchObject({ existing: false, base: head, origin: "gone" })
    expect(opened).not.toHaveProperty("tracking")
    expect(git(opened.path, "rev-parse", "HEAD")).toBe(head)
  })

  it("uses origin's branch as last fetched where origin can't be asked, and says so", async ({
    resources,
    fx: f,
  }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    await f.store.createProject({ id: "p2", name: "Q", cwd: origin.repo })
    const pushed = origin.branch("cached")
    origin.fetch()
    // Offline: origin is a folder that no longer exists.
    git(origin.repo, "remote", "set-url", "origin", join(f.other, "gone.git"))
    const { worktrees } = recording(resources, f)
    const opened = await worktrees.open({
      projectId: "p2",
      terminalId: "t1",
      cwd: origin.repo,
      branch: "cached",
    })
    if (!opened.ok) throw new Error(opened.reason)
    expect(opened).toMatchObject({ base: pushed, origin: "unchecked", tracking: true })
    expect(git(opened.path, "rev-parse", "HEAD")).toBe(pushed)
  })

  it("fetches nothing for a branch name git refuses", async ({ resources, fx: f }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    await f.store.createProject({ id: "p2", name: "Q", cwd: origin.repo })
    const { fetches, worktrees } = recording(resources, f)
    const opened = await worktrees.open({
      projectId: "p2",
      terminalId: "t1",
      cwd: origin.repo,
      branch: "x~1",
    })
    expect(opened).toMatchObject({ ok: false, reason: expect.stringContaining("isn't a branch") })
    expect(fetches).toHaveLength(0)
  })

  it("leaves origin's branch alone when from is given, or the branch exists here", async ({
    resources,
    fx: f,
  }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    await f.store.createProject({ id: "p2", name: "Q", cwd: origin.repo })
    origin.branch("theirs")
    origin.fetch()
    const head = git(origin.repo, "rev-parse", "HEAD")
    const { worktrees } = recording(resources, f)
    const given = await worktrees.open({
      projectId: "p2",
      terminalId: "t1",
      cwd: origin.repo,
      branch: "theirs",
      from: "main",
    })
    if (!given.ok) throw new Error(given.reason)
    expect(given).toMatchObject({ base: head })
    expect(given).not.toHaveProperty("origin")
    expect(given).not.toHaveProperty("tracking")
  })

  it.skipIf(process.platform === "win32")(
    "doesn't wait past its bound for a remote that hangs, and doesn't cut the fetch short",
    async ({ resources, fx: f }) => {
      const origin = withOrigin((cleanup) => resources.defer(cleanup))
      await f.store.createProject({ id: "p2", name: "Q", cwd: origin.repo })
      const cached = git(origin.repo, "rev-parse", "origin/main")
      // A remote that is a program which never answers.
      git(origin.repo, "config", "protocol.ext.allow", "always")
      git(origin.repo, "remote", "set-url", "origin", "ext::sleep 30")
      const { fetches, fetcher, worktrees } = recording(resources, f, 400)
      const started = Date.now()
      const opened = await worktrees.open({
        projectId: "p2",
        terminalId: "t1",
        cwd: origin.repo,
        branch: "feat/hung",
      })
      if (!opened.ok) throw new Error(opened.reason)
      expect(Date.now() - started).toBeLessThan(5000)
      expect(opened.base).toBe(cached)
      // The fetch went on with the usual limit, not the caller's, and is still going.
      expect(fetches).toHaveLength(1)
      expect(fetches[0]?.ms).toBe(fetchTimeoutMs)
      expect(fetcher.fetchedAt(join(origin.repo, ".git"))).toBeUndefined()
      // Still under way: asking again waits for it the whole bound, and starts no second one.
      const asked = Date.now()
      await fetcher.fetchBriefly(join(origin.repo, ".git"), 300)
      expect(Date.now() - asked).toBeGreaterThanOrEqual(250)
      expect(fetches).toHaveLength(1)
    },
  )

  it("keeps a repository with no worktree on the fetch schedule while something asks for it, not moving its checkout", async ({
    resources,
    fx: f,
  }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    const common = join(origin.repo, ".git")
    let wanted: string[] = [common]
    const { fetches, fetcher } = recordingFetcher(resources, 0)
    const worktrees = new Worktrees(f.store, {
      exists: (id) => f.live.has(id),
      root: f.root,
      cleanup: { fetcher },
      repositories: () => Promise.resolve(wanted),
    })
    resources.defer(() => void worktrees.stop())
    const before = git(origin.repo, "rev-parse", "HEAD")
    origin.land("b.txt")
    await worktrees.tidy(true)
    expect(fetches).toHaveLength(1)
    expect(fetcher.fetchedAt(common)).toBeTypeOf("number")
    // Fetched for a compare's sake alone, so the checkout stays where the person has it.
    await fetcher.idle()
    expect(git(origin.repo, "rev-parse", "HEAD")).toBe(before)
    // Asked for no more (its compare closed): forgotten, and not fetched again.
    wanted = []
    await worktrees.tidy(true)
    expect(fetches).toHaveLength(1)
    expect(fetcher.fetchedAt(common)).toBeUndefined()
  })

  it("moves the checkout of a repository that also has a tracked worktree, on the schedule", async ({
    resources,
    fx: f,
  }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    await f.store.createProject({ id: "p2", name: "Q", cwd: origin.repo })
    const common = join(origin.repo, ".git")
    const { fetcher } = recordingFetcher(resources, 0)
    const worktrees = new Worktrees(f.store, {
      exists: (id) => f.live.has(id),
      root: f.root,
      cleanup: { fetcher },
      repositories: () => Promise.resolve([common]),
    })
    resources.defer(() => void worktrees.stop())
    const opened = await worktrees.open({
      projectId: "p2",
      terminalId: "t1",
      cwd: origin.repo,
      branch: "feat/x",
      from: "main",
    })
    if (!opened.ok) throw new Error(opened.reason)
    const landed = origin.land("c.txt")
    await worktrees.tidy(true)
    await fetcher.idle()
    expect(git(origin.repo, "rev-parse", "HEAD")).toBe(landed)
  })

  it("keeps the state of a repository whose fetch is under way when a look forgets the rest", async ({
    resources,
  }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    const common = join(origin.repo, ".git")
    git(origin.repo, "config", "protocol.ext.allow", "always")
    git(origin.repo, "remote", "set-url", "origin", "ext::sleep 30")
    const { fetches, fetcher } = recordingFetcher(resources)
    await fetcher.fetchBriefly(common, 200)
    expect(fetches).toHaveLength(1)
    await fetcher.fetchDue([])
    // Still the same state, and the one fetch: a second ask is shared with it.
    await fetcher.fetchBriefly(common, 100)
    expect(fetches).toHaveLength(1)
  })

  it("keeps what a brief fetch found when a look forgets the repositories nobody listed", async ({
    resources,
  }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    const common = join(origin.repo, ".git")
    const { fetcher } = recordingFetcher(resources)
    await fetcher.fetchBriefly(common, 10_000, false)
    const at = fetcher.fetchedAt(common)
    expect(at).toBeTypeOf("number")
    // A compare not saved yet is no one's, but fetched a moment ago it is kept.
    await fetcher.fetchDue([])
    expect(fetcher.fetchedAt(common)).toBe(at)
  })

  it("starts from the cached main when the remote can't be reached", async ({
    resources,
    fx: f,
  }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    await f.store.createProject({ id: "p2", name: "Q", cwd: origin.repo })
    const landed = origin.land("b.txt")
    origin.fetch()
    origin.land("c.txt")
    git(origin.repo, "remote", "set-url", "origin", join(f.root, "nowhere.git"))
    const opened = await f.worktrees.open({
      projectId: "p2",
      terminalId: "t1",
      cwd: origin.repo,
      branch: "feat/offline",
    })
    if (!opened.ok) throw new Error(opened.reason)
    expect(opened.base).toBe(landed)
  })

  it("starts from HEAD when it is on a feature branch, ahead of main, diverged, or there is no main", async ({
    resources,
    fx: f,
  }) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    await f.store.createProject({ id: "p2", name: "Q", cwd: origin.repo })
    const from = async (branch: string) => {
      const opened = await f.worktrees.open({
        projectId: "p2",
        terminalId: "t1",
        cwd: origin.repo,
        branch,
      })
      if (!opened.ok) throw new Error(opened.reason)
      return opened.base
    }
    origin.land("b.txt")
    origin.fetch()
    // A feature branch behind main.
    git(origin.repo, "checkout", "--quiet", "-b", "side")
    expect(await from("one")).toBe(git(origin.repo, "rev-parse", "HEAD"))
    // Main with a commit of its own: diverged from origin's.
    git(origin.repo, "checkout", "--quiet", "main")
    writeFileSync(join(origin.repo, "mine.txt"), "mine\n")
    git(origin.repo, "add", "-A")
    git(origin.repo, "commit", "--quiet", "-m", "mine")
    expect(await from("two")).toBe(git(origin.repo, "rev-parse", "HEAD"))
    // Main ahead of origin's, as when everything is pushed and then some.
    git(origin.repo, "reset", "--quiet", "--hard", "origin/main")
    git(origin.repo, "push", "--quiet", "origin", "main")
    writeFileSync(join(origin.repo, "c.txt"), "c\n")
    git(origin.repo, "add", "-A")
    git(origin.repo, "commit", "--quiet", "-m", "c")
    expect(await from("three")).toBe(git(origin.repo, "rev-parse", "HEAD"))
    // No remote main at all: the plain repository of the fixture is on its own main.
    const plain = await open(f, "four")
    if (!plain.ok) throw new Error(plain.reason)
    expect(plain.base).toBe(git(f.repo, "rev-parse", "HEAD"))
  })

  it("finds the repository from a folder inside it, relative to the caller's", async ({
    fx: f,
  }) => {
    mkdirSync(join(f.repo, "src"))
    const opened = await f.worktrees.open({
      projectId: f.project,
      terminalId: "t1",
      cwd: f.repo,
      repo: "src",
      branch: "x",
    })
    expect(opened).toMatchObject({ ok: true })
    const nowhere = await f.worktrees.open({
      projectId: f.project,
      terminalId: "t1",
      cwd: f.other,
      branch: "y",
    })
    expect(nowhere).toMatchObject({ ok: false, reason: expect.stringContaining("git repository") })
  })

  it("refuses a name git doesn't accept, and a group that is taken", async ({ fx: f }) => {
    const refusals = await Promise.all(
      ["bad name", "-x", "a..b", "x.lock"].map((branch) => open(f, branch)),
    )
    for (const refusal of refusals) expect(refusal).toMatchObject({ ok: false })
    expect(await open(f, "one", { group: "g" })).toMatchObject({ ok: true })
    expect(await open(f, "two", { group: "g" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("already a worktree of api"),
    })
  })

  it("refuses two repositories with one folder name in a group", async ({ fx: f }) => {
    const elsewhere = repository(temporary({ defer: () => {} }, "wt-twin"), "api")
    expect(await open(f, "one", { group: "g" })).toMatchObject({ ok: true })
    const twin = await f.worktrees.open({
      projectId: f.project,
      terminalId: "t1",
      cwd: elsewhere,
      branch: "two",
      group: "g",
    })
    expect(twin).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Another repository named api"),
    })
    rmSync(join(elsewhere, ".."), { recursive: true, force: true })
  })
})

describe("taking a worktree", () => {
  it("records one some other tool made, as adopted", async ({ fx: f }) => {
    const path = join(f.other, "made-elsewhere")
    git(f.repo, "worktree", "add", "-b", "scripted", path)
    const taken = await f.worktrees.take({
      projectId: f.project,
      terminalId: "t1",
      cwd: f.repo,
      path,
    })
    expect(taken).toMatchObject({ ok: true, path, branch: "scripted" })
    expect(f.store.worktree(path)).toMatchObject({
      adopted: true,
      terminalId: "t1",
      branch: "scripted",
      base: git(f.repo, "rev-parse", "HEAD"),
    })
  })

  it("refuses the main checkout, a folder in no repository, and a detached worktree", async ({
    fx: f,
  }) => {
    const take = (path: string) =>
      f.worktrees.take({ projectId: f.project, terminalId: "t1", cwd: f.repo, path })
    expect(await take(f.repo)).toMatchObject({ ok: false })
    expect(await take(f.other)).toMatchObject({ ok: false })
    const detached = join(f.other, "detached")
    git(f.repo, "worktree", "add", "--detach", detached)
    expect(await take(detached)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("detached"),
    })
  })

  it("takes an orphaned worktree, and one whose owner is gone, at once", async ({ fx: f }) => {
    const a = await open(f, "a")
    const b = await open(f, "b")
    if (!a.ok || !b.ok) throw new Error("open")
    f.store.orphanWorktree(a.path)
    f.live.delete("t1")
    const take = (path: string) =>
      f.worktrees.take({ projectId: f.project, terminalId: "t2", cwd: f.repo, path })
    expect(await take(a.path)).toMatchObject({ ok: true, path: a.path })
    expect(await take(b.path)).toMatchObject({ ok: true, path: b.path })
    expect(f.store.worktree(a.path)?.terminalId).toBe("t2")
    expect(f.store.worktree(b.path)?.terminalId).toBe("t2")
  })

  it("is a no-op on the caller's own, and refuses another project's", async ({ fx: f }) => {
    const a = await open(f, "a")
    if (!a.ok) throw new Error("open")
    expect(
      await f.worktrees.take({ projectId: f.project, terminalId: "t1", cwd: f.repo, path: a.path }),
    ).toMatchObject({ ok: true, already: true })
    expect(
      await f.worktrees.take({ projectId: "other", terminalId: "t2", cwd: f.repo, path: a.path }),
    ).toMatchObject({ ok: false })
  })

  it("leaves another live terminal's to the person, and moves it once they allow", async ({
    fx: f,
  }) => {
    const a = await open(f, "a")
    if (!a.ok) throw new Error("open")
    const taken = await f.worktrees.take({
      projectId: f.project,
      terminalId: "t2",
      cwd: f.repo,
      path: a.path,
    })
    expect(taken).toMatchObject({ ok: true, approval: { path: a.path, terminalId: "t1" } })
    expect(f.store.worktree(a.path)?.terminalId).toBe("t1")
    expect(await f.worktrees.transfer(a.path, "t1", "t2")).toBe(true)
    expect(f.store.worktree(a.path)?.terminalId).toBe("t2")
    // It moved meanwhile: the approval no longer applies.
    expect(await f.worktrees.transfer(a.path, "t1", "t3")).toBe(false)
    expect(f.store.worktree(a.path)?.terminalId).toBe("t2")
  })
})

describe("closing a worktree", () => {
  it("removes a clean one and deletes its branch, as the main branch holds it", async ({
    fx: f,
  }) => {
    const a = await open(f, "clean")
    if (!a.ok) throw new Error("open")
    const row = f.store.worktree(a.path)!
    const closed = await f.worktrees.remove(row, false)
    expect(closed).toMatchObject({ ok: true, branchDeleted: true })
    expect(existsSync(a.path)).toBe(false)
    expect(git(f.repo, "branch", "--list", "clean")).toBe("")
    expect(f.store.worktree(a.path)).toBeUndefined()
  })

  it("refuses one with uncommitted or untracked files, or commits main lacks", async ({
    fx: f,
  }) => {
    const a = await open(f, "busy")
    if (!a.ok) throw new Error("open")
    const row = f.store.worktree(a.path)!
    writeFileSync(join(a.path, "new.txt"), "x\n")
    expect(await f.worktrees.remove(row, false)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("1 uncommitted or untracked path"),
    })
    git(a.path, "add", "-A")
    git(a.path, "commit", "--quiet", "-m", "work")
    expect(await f.worktrees.remove(row, false)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("1 commit the main branch doesn't have"),
    })
    expect(existsSync(a.path)).toBe(true)
    expect(f.store.worktree(a.path)).toBeDefined()
  })

  it("closes a safe one on the person's say without asking about commits main lacks, but still asks about uncommitted files; the branch stays", async ({
    fx: f,
  }) => {
    const a = await open(f, "closed-pr")
    if (!a.ok) throw new Error("open")
    writeFileSync(join(a.path, "w.txt"), "w\n")
    git(a.path, "add", "-A")
    git(a.path, "commit", "--quiet", "-m", "work")
    writeFileSync(join(a.path, "late.txt"), "x\n")
    expect(await f.worktrees.closeAt(a.path, false, undefined, true)).toMatchObject({
      ok: false,
      holds: "1 uncommitted or untracked path",
    })
    rmSync(join(a.path, "late.txt"))
    // Without the mark, the agent's and the person's own unsafe close, main's lack refuses.
    expect(await f.worktrees.closeAt(a.path, false)).toMatchObject({ ok: false })
    const closed = await f.worktrees.closeAt(a.path, false, undefined, true)
    expect(closed).toMatchObject({ ok: true, branchDeleted: false })
    expect(existsSync(a.path)).toBe(false)
    expect(git(f.repo, "branch", "--list", "closed-pr")).toContain("closed-pr")
  })

  it("says what it holds, apart from the agent's wording, where only force stands in the way", async ({
    fx: f,
  }) => {
    const a = await open(f, "busy")
    if (!a.ok) throw new Error("open")
    writeFileSync(join(a.path, "new.txt"), "x\n")
    const refused = await f.worktrees.remove(f.store.worktree(a.path)!, false)
    expect(refused).toMatchObject({ ok: false, holds: "1 uncommitted or untracked path" })
  })

  it("closes a squash-merged worktree without force, deleting its branch with -D", async ({
    fx: f,
  }) => {
    const a = await open(f, "squashed")
    if (!a.ok) throw new Error("open")
    writeFileSync(join(a.path, "s.txt"), "s\n")
    git(a.path, "add", "-A")
    git(a.path, "commit", "--quiet", "-m", "work")
    git(f.repo, "merge", "--quiet", "--squash", "squashed")
    git(f.repo, "commit", "--quiet", "-m", "squash")
    // Git calls the branch unmerged (main has other hashes), but merging it changes nothing.
    expect(git(f.repo, "rev-list", "--count", "main..squashed")).toBe("1")
    const closed = await f.worktrees.remove(f.store.worktree(a.path)!, false)
    expect(closed).toMatchObject({ ok: true, branchDeleted: true })
    expect(existsSync(a.path)).toBe(false)
    expect(git(f.repo, "branch", "--list", "squashed")).toBe("")
  })

  it("closes a rebase-merged worktree without force too", async ({ fx: f }) => {
    const a = await open(f, "rebased")
    if (!a.ok) throw new Error("open")
    writeFileSync(join(a.path, "r.txt"), "r\n")
    git(a.path, "add", "-A")
    git(a.path, "commit", "--quiet", "-m", "work")
    // Main moved on first, so the cherry-picked commit has another hash.
    writeFileSync(join(f.repo, "other.txt"), "o\n")
    git(f.repo, "add", "-A")
    git(f.repo, "commit", "--quiet", "-m", "other")
    git(f.repo, "cherry-pick", "rebased")
    expect(await f.worktrees.remove(f.store.worktree(a.path)!, false)).toMatchObject({
      ok: true,
      branchDeleted: true,
    })
  })

  it("still refuses a squash-merged worktree with loose files, or work main doesn't hold", async ({
    fx: f,
  }) => {
    const a = await open(f, "squashed")
    if (!a.ok) throw new Error("open")
    writeFileSync(join(a.path, "s.txt"), "s\n")
    git(a.path, "add", "-A")
    git(a.path, "commit", "--quiet", "-m", "work")
    git(f.repo, "merge", "--quiet", "--squash", "squashed")
    git(f.repo, "commit", "--quiet", "-m", "squash")
    writeFileSync(join(a.path, "loose.txt"), "l\n")
    expect(await f.worktrees.remove(f.store.worktree(a.path)!, false)).toMatchObject({
      ok: false,
      holds: "1 uncommitted or untracked path",
    })
    rmSync(join(a.path, "loose.txt"))
    // A commit after the squash is work main lacks.
    writeFileSync(join(a.path, "more.txt"), "m\n")
    git(a.path, "add", "-A")
    git(a.path, "commit", "--quiet", "-m", "more")
    expect(await f.worktrees.remove(f.store.worktree(a.path)!, false)).toMatchObject({
      ok: false,
      holds: expect.stringContaining("commit"),
    })
  })

  it("closes at a path on the person's say, in the queue: a row gone meanwhile is already closed", async ({
    fx: f,
  }) => {
    const a = await open(f, "queued")
    if (!a.ok) throw new Error("open")
    const first = f.worktrees.closeAt(a.path, false)
    // Asked behind the first, which has removed the row by then.
    const second = f.worktrees.closeAt(a.path, false)
    // Each with its whole answer on failure, a refusal's reason too, which a match leaves out.
    const [closed, again] = [await first, await second]
    expect(closed, JSON.stringify(closed)).toMatchObject({ ok: true, branchDeleted: true })
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true, already: true })
  })

  it("lets a guard keep a worktree at the moment of removal, inside the queue", async ({
    fx: f,
  }) => {
    const a = await open(f, "guarded")
    if (!a.ok) throw new Error("open")
    let busy = false
    const closing = f.worktrees.closeAt(a.path, true, async () =>
      busy ? "An agent is working in that worktree." : undefined,
    )
    busy = true
    // The guard ran when the queue reached it, not when the close was asked.
    expect(await closing).toMatchObject({
      ok: false,
      reason: "An agent is working in that worktree.",
    })
    expect(existsSync(a.path)).toBe(true)
    expect(f.store.worktree(a.path)).toBeDefined()
    busy = false
    expect(await f.worktrees.closeAt(a.path, true, async () => undefined)).toMatchObject({
      ok: true,
    })
  })

  it("forced, keeps uncommitted files on a ref, removes the folder, and keeps a branch with commits", async ({
    fx: f,
  }) => {
    const a = await open(f, "busy")
    if (!a.ok) throw new Error("open")
    const row = f.store.worktree(a.path)!
    writeFileSync(join(a.path, "committed.txt"), "c\n")
    git(a.path, "add", "-A")
    git(a.path, "commit", "--quiet", "-m", "work")
    writeFileSync(join(a.path, "loose.txt"), "loose\n")
    writeFileSync(join(a.path, "a.txt"), "changed\n")
    const closed = await f.worktrees.remove(row, true)
    if (!closed.ok) throw new Error(closed.reason)
    expect(closed).toMatchObject({
      kept: expect.stringMatching(/^refs\/novadeck\/kept\/busy-work-[0-9a-f]{8}$/),
      branchDeleted: false,
    })
    expect(existsSync(a.path)).toBe(false)
    expect(git(f.repo, "show", `${closed.kept}:loose.txt`)).toBe("loose")
    expect(git(f.repo, "show", `${closed.kept}:a.txt`)).toBe("changed")
    expect(git(f.repo, "show", `${closed.kept}:committed.txt`)).toBe("c")
    // On top of the branch, which stays with its commit.
    expect(git(f.repo, "rev-parse", `${closed.kept}~1`)).toBe(git(f.repo, "rev-parse", "busy"))
    expect(git(f.repo, "log", "-1", "--format=%s", "busy")).toBe("work")
    expect(f.store.worktree(a.path)).toBeUndefined()
  })

  it("forced with only loose files, deletes the branch main holds", async ({ fx: f }) => {
    const a = await open(f, "loose")
    if (!a.ok) throw new Error("open")
    writeFileSync(join(a.path, "x.txt"), "x\n")
    const closed = await f.worktrees.remove(f.store.worktree(a.path)!, true)
    expect(closed).toMatchObject({ ok: true, branchDeleted: true })
    if (!closed.ok) throw new Error(closed.reason)
    expect(git(f.repo, "show", `${closed.kept}:x.txt`)).toBe("x")
    expect(git(f.repo, "branch", "--list", "loose")).toBe("")
  })

  it("only the owner may close it, and a folder inside the worktree names it", async ({
    fx: f,
  }) => {
    const a = await open(f, "mine")
    if (!a.ok) throw new Error("open")
    mkdirSync(join(a.path, "src"))
    const close = (terminalId: string, path: string) =>
      f.worktrees.closeOwned({ terminalId, cwd: f.repo, path, force: false })
    expect(await close("t2", a.path)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("another terminal's"),
    })
    expect(await close("t1", f.other)).toMatchObject({ ok: false })
    expect(await close("t1", join(a.path, "src"))).toMatchObject({ ok: true })
    expect(existsSync(a.path)).toBe(false)
  })

  it("never removes a worktree git couldn't read, forced or not, or on a project's removal", async ({
    fx: f,
  }) => {
    const a = await open(f, "unreadable")
    if (!a.ok) throw new Error("open")
    // A damaged index makes git status fail, as a timeout or too long an output would.
    const index = git(a.path, "rev-parse", "--path-format=absolute", "--git-path", "index")
    writeFileSync(index, "not an index at all")
    // eslint-disable-next-line no-await-in-loop -- Two closes, one after the other.
    for (const force of [false, true])
      expect(
        // eslint-disable-next-line no-await-in-loop -- As above.
        await f.worktrees.closeOwned({ terminalId: "t1", cwd: f.repo, path: a.path, force }),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("couldn't read what the worktree holds"),
      })
    await f.worktrees.removeProject(f.project)
    expect(existsSync(a.path)).toBe(true)
    expect(git(f.repo, "branch", "--list", "unreadable")).toContain("unreadable")
    expect(git(f.repo, "for-each-ref", "refs/novadeck")).toBe("")
  })

  it("keeps commits only a detached HEAD reaches, and refuses it unforced", async ({ fx: f }) => {
    const a = await open(f, "stray")
    if (!a.ok) throw new Error("open")
    git(a.path, "checkout", "--quiet", "--detach")
    writeFileSync(join(a.path, "lost.txt"), "lost\n")
    git(a.path, "add", "-A")
    git(a.path, "commit", "--quiet", "-m", "only on HEAD")
    const head = git(a.path, "rev-parse", "HEAD")
    const close = (force: boolean) =>
      f.worktrees.closeOwned({ terminalId: "t1", cwd: f.repo, path: a.path, force })
    expect(await close(false)).toMatchObject({ ok: false })
    const closed = await close(true)
    if (!closed.ok) throw new Error(closed.reason)
    expect(closed.keptHead).toMatch(/^refs\/novadeck\/kept\/stray-head-/)
    expect(git(f.repo, "rev-parse", closed.keptHead!)).toBe(head)
    expect(existsSync(a.path)).toBe(false)
  })

  it("deletes only a branch Novadeck made, not one it checked out or adopted", async ({
    fx: f,
  }) => {
    git(f.repo, "branch", "side")
    const side = await open(f, "side")
    if (!side.ok) throw new Error("open")
    expect(f.store.worktree(side.path)?.branchMade).toBe(false)
    expect(await f.worktrees.remove(f.store.worktree(side.path)!, false)).toMatchObject({
      ok: true,
      branchDeleted: false,
    })
    expect(git(f.repo, "branch", "--list", "side")).toContain("side")
    const path = join(f.other, "adopted")
    git(f.repo, "worktree", "add", "-b", "theirs", path)
    await f.worktrees.take({ projectId: f.project, terminalId: "t1", cwd: f.repo, path })
    expect(await f.worktrees.remove(f.store.worktree(path)!, false)).toMatchObject({
      ok: true,
      branchDeleted: false,
    })
    expect(git(f.repo, "branch", "--list", "theirs")).toContain("theirs")
  })

  it("keeps work under ref names that never clash, whatever the branches are called", async ({
    fx: f,
  }) => {
    const refs: string[] = []
    for (const branch of ["a", "a/b"]) {
      // eslint-disable-next-line no-await-in-loop -- Each closes before the next opens.
      const opened = await open(f, branch)
      if (!opened.ok) throw new Error(opened.reason)
      writeFileSync(join(opened.path, "x.txt"), branch)
      // eslint-disable-next-line no-await-in-loop -- As above.
      const closed = await f.worktrees.remove(f.store.worktree(opened.path)!, true)
      if (!closed.ok) throw new Error(closed.reason)
      refs.push(closed.kept!)
    }
    expect(new Set(refs).size).toBe(2)
  })

  it("refuses to close a worktree with submodules", async ({ fx: f }) => {
    const sub = repository(f.other, "sub")
    const a = await open(f, "subbed")
    if (!a.ok) throw new Error("open")
    git(a.path, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sub, "lib")
    git(a.path, "commit", "--quiet", "-am", "with a submodule")
    expect(
      await f.worktrees.closeOwned({ terminalId: "t1", cwd: f.repo, path: a.path, force: true }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("submodules") })
    expect(existsSync(a.path)).toBe(true)
  })

  it("never removes a worktree holding an untracked repository of its own, forced or not, or on a project's removal", async ({
    fx: f,
  }) => {
    const a = await open(f, "cloned")
    if (!a.ok) throw new Error("open")
    // An agent's clone of a library, in a folder nothing tracks, with a fix committed there and
    // more not yet: a commit could keep it only as a gitlink.
    const lib = join(a.path, "vendor", "deep", "lib")
    mkdirSync(lib, { recursive: true })
    git(lib, "init", "--quiet", "-b", "main")
    writeFileSync(join(lib, "fix.c"), "the fix\n")
    git(lib, "add", "-A")
    git(lib, "commit", "--quiet", "-m", "fix")
    writeFileSync(join(lib, "more.c"), "more\n")
    // eslint-disable-next-line no-await-in-loop -- Two closes, one after the other.
    for (const force of [false, true])
      expect(
        // eslint-disable-next-line no-await-in-loop -- As above.
        await f.worktrees.closeOwned({ terminalId: "t1", cwd: f.repo, path: a.path, force }),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining(
          "a git repository of its own, not tracked, at vendor/deep/lib, with uncommitted or untracked files",
        ),
      })
    await f.worktrees.removeProject(f.project)
    expect(readFileSync(join(lib, "more.c"), "utf8")).toBe("more\n")
    expect(git(lib, "log", "-1", "--format=%s")).toBe("fix")
    expect(git(f.repo, "for-each-ref", "refs/novadeck")).toBe("")
  })

  it("finds a repository deep in an untracked folder among more untracked files than its cap holds", async ({
    fx: f,
  }) => {
    const a = await open(f, "built")
    if (!a.ok) throw new Error("open")
    const out = join(a.path, "build", "out")
    mkdirSync(out, { recursive: true })
    // Their names alone pass the cap many times over, as a big build's or a dataset's would.
    for (let index = 0; index < 2000; index += 1)
      writeFileSync(join(out, `artifact-${index}.o`), "")
    const lib = join(a.path, "build", "deep", "a", "b")
    mkdirSync(lib, { recursive: true })
    git(lib, "init", "--quiet", "-b", "main")
    expect(await nestedRepositories(a.path, 1024)).toEqual(["build/deep/a/b"])
  })

  it("removes a worktree whose nested repositories hold nothing a remote lacks, when forced", async ({
    fx: f,
  }) => {
    const a = await open(f, "reading")
    if (!a.ok) throw new Error("open")
    // A clone made to read a library: clean, its HEAD and branches on its origin.
    const library = repository(f.other, "library")
    git(a.path, "clone", "--quiet", library, join("vendor", "library"))
    const unforced = await f.worktrees.closeOwned({
      terminalId: "t1",
      cwd: f.repo,
      path: a.path,
      force: false,
    })
    // Unforced it holds an untracked path, as any untracked folder does.
    expect(unforced).toMatchObject({ ok: false, holds: expect.stringContaining("untracked") })
    const forced = await f.worktrees.closeOwned({
      terminalId: "t1",
      cwd: f.repo,
      path: a.path,
      force: true,
    })
    expect(forced).toMatchObject({ ok: true })
    expect(existsSync(a.path)).toBe(false)
  })

  it("keeps a worktree whose nested repository has a commit, a stash or a branch no remote has, and says which", async ({
    fx: f,
  }) => {
    const library = repository(f.other, "library")
    const cases: [string, (clone: string) => void, string][] = [
      [
        "committed",
        (clone) => {
          writeFileSync(join(clone, "fix.c"), "fix\n")
          git(clone, "add", "-A")
          git(clone, "commit", "--quiet", "-m", "fix")
        },
        "commits no remote has",
      ],
      [
        "stashed",
        (clone) => {
          writeFileSync(join(clone, "a.txt"), "changed\n")
          git(clone, "stash", "--quiet")
        },
        "a stash",
      ],
      [
        "branched",
        (clone) => {
          git(clone, "checkout", "--quiet", "-b", "side")
          writeFileSync(join(clone, "side.c"), "side\n")
          git(clone, "add", "-A")
          git(clone, "commit", "--quiet", "-m", "side")
          git(clone, "checkout", "--quiet", "main")
        },
        "commits no remote has",
      ],
    ]
    for (const [branch, make, said] of cases) {
      // eslint-disable-next-line no-await-in-loop -- One worktree after another.
      const a = await open(f, branch)
      if (!a.ok) throw new Error("open")
      const clone = join(a.path, "lib")
      git(a.path, "clone", "--quiet", library, "lib")
      make(clone)
      expect(
        // eslint-disable-next-line no-await-in-loop -- As above.
        await f.worktrees.closeOwned({ terminalId: "t1", cwd: f.repo, path: a.path, force: true }),
      ).toMatchObject({ ok: false, reason: expect.stringContaining(`at lib, with ${said}`) })
      expect(existsSync(clone)).toBe(true)
    }
  })
})

describe("what take may adopt", () => {
  it("resolves a folder inside a tracked worktree to it, and never overwrites its owner", async ({
    fx: f,
  }) => {
    const a = await open(f, "owned")
    if (!a.ok) throw new Error("open")
    mkdirSync(join(a.path, "src"))
    const taken = await f.worktrees.take({
      projectId: f.project,
      terminalId: "t2",
      cwd: f.repo,
      path: join(a.path, "src"),
    })
    expect(taken).toMatchObject({ ok: true, approval: { path: a.path, terminalId: "t1" } })
    expect(f.store.worktree(a.path)?.terminalId).toBe("t1")
    expect(
      await f.worktrees.take({
        projectId: "another",
        terminalId: "t2",
        cwd: f.repo,
        path: join(a.path, "src"),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("another project") })
    expect(f.store.worktree(a.path)?.terminalId).toBe("t1")
  })

  it("refuses a repository outside the project, and a locked worktree", async ({ fx: f }) => {
    const elsewhere = repository(temporary({ defer: () => {} }, "wt-foreign"), "foreign")
    const foreign = join(f.other, "foreign-wt")
    git(elsewhere, "worktree", "add", "-b", "f", foreign)
    const take = (path: string, cwd = f.repo) =>
      f.worktrees.take({ projectId: f.project, terminalId: "t1", cwd, path })
    expect(await take(foreign)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("outside this project"),
    })
    const locked = join(f.other, "locked-wt")
    git(f.repo, "worktree", "add", "-b", "l", locked)
    git(f.repo, "worktree", "lock", locked)
    expect(await take(locked)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("locked"),
    })
    expect(f.store.worktrees()).toEqual([])
    rmSync(join(elsewhere, ".."), { recursive: true, force: true })
  })

  it("keeps the owner when two takes meet a close", async ({ fx: f }) => {
    const a = await open(f, "race")
    if (!a.ok) throw new Error("open")
    const moved = f.worktrees.transfer(a.path, "t1", "t2")
    const closed = f.worktrees.closeOwned({
      terminalId: "t1",
      cwd: f.repo,
      path: a.path,
      force: true,
    })
    expect(await moved).toBe(true)
    expect(await closed).toMatchObject({ ok: false })
    expect(existsSync(a.path)).toBe(true)
  })
})

describe("opening, crashes and pruning", () => {
  it("leaves no row when git refuses the worktree", async ({ fx: f }) => {
    // main is checked out in the repository's own folder.
    expect(await open(f, "main")).toMatchObject({ ok: false })
    expect(f.store.worktrees()).toEqual([])
  })

  it("forgets only its own entry, not a person's worktree whose folder is away", async ({
    fx: f,
  }) => {
    const away = join(f.other, "away")
    git(f.repo, "worktree", "add", "-b", "away", away)
    rmSync(away, { recursive: true, force: true })
    const a = await open(f, "ours")
    if (!a.ok) throw new Error("open")
    rmSync(a.path, { recursive: true, force: true })
    await f.worktrees.reconcile()
    const listed = git(f.repo, "worktree", "list", "--porcelain")
    expect(f.store.worktree(a.path)).toBeUndefined()
    expect(listed).toContain(asGit(away))
    expect(listed).not.toContain(asGit(a.path))
  })
})

describe("reconciling at the runner's start", () => {
  it("drops a row whose folder is gone and prunes its repository", async ({ fx: f }) => {
    const a = await open(f, "gone")
    if (!a.ok) throw new Error("open")
    rmSync(a.path, { recursive: true, force: true })
    await f.worktrees.reconcile()
    expect(f.store.worktree(a.path)).toBeUndefined()
    expect(git(f.repo, "worktree", "list", "--porcelain")).not.toContain(asGit(a.path))
  })

  it("forgets the entry of a folder gone where git keeps its path relative", async ({ fx: f }) => {
    const a = await open(f, "relative")
    if (!a.ok) throw new Error("open")
    // As git 2.48's worktree.useRelativePaths writes it: from the entry's own folder.
    const entry = join(f.repo, ".git", "worktrees", basename(a.path))
    const gitdir = join(entry, "gitdir")
    expect(readFileSync(gitdir, "utf8").trim()).toBe(asGit(join(a.path, ".git")))
    writeFileSync(gitdir, `${asGit(relative(entry, join(a.path, ".git")))}\n`)
    rmSync(a.path, { recursive: true, force: true })
    await f.worktrees.reconcile()
    expect(f.store.worktree(a.path)).toBeUndefined()
    expect(existsSync(entry)).toBe(false)
  })

  it("orphans a worktree whose owner is gone, and leaves the rest, and again", async ({
    fx: f,
  }) => {
    const a = await open(f, "a", {}, "t1")
    const b = await open(f, "b", {}, "t2")
    if (!a.ok || !b.ok) throw new Error("open")
    f.live.delete("t1")
    await f.worktrees.reconcile()
    await f.worktrees.reconcile()
    expect(f.store.worktree(a.path)?.terminalId).toBeNull()
    expect(f.store.worktree(b.path)?.terminalId).toBe("t2")
    expect(existsSync(a.path)).toBe(true)
  })

  it("finishes a close that stopped after the folder went", async ({ fx: f }) => {
    const a = await open(f, "half")
    if (!a.ok) throw new Error("open")
    git(f.repo, "worktree", "remove", "--force", a.path)
    // The row stays: the crash came before it was deleted.
    expect(f.store.worktree(a.path)).toBeDefined()
    await f.worktrees.reconcile()
    expect(f.store.worktree(a.path)).toBeUndefined()
  })
})

describe("removing a project", () => {
  it("removes its worktrees, keeping loose work on a ref, before its rows cascade", async ({
    fx: f,
  }) => {
    const a = await open(f, "p1")
    const b = await open(f, "p2")
    if (!a.ok || !b.ok) throw new Error("open")
    writeFileSync(join(a.path, "loose.txt"), "keep me\n")
    const keptBefore = git(f.repo, "for-each-ref", "refs/novadeck")
    expect(keptBefore).toBe("")
    await f.worktrees.removeProject(f.project)
    expect(existsSync(a.path)).toBe(false)
    expect(existsSync(b.path)).toBe(false)
    const ref = git(f.repo, "for-each-ref", "--format=%(refname)", "refs/novadeck/kept/p1-*")
    expect(git(f.repo, "show", `${ref}:loose.txt`)).toBe("keep me")
    expect(f.store.worktreesOfProject(f.project)).toEqual([])
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("a\n")
  })
})

// A folder it can't write keeps git from deleting what is in it, as a file Windows still holds
// does there; root, and Windows itself, delete it all the same.
const partway = process.platform === "win32" || process.getuid?.() === 0

describe.skipIf(partway)("a removal git stopped partway", () => {
  it("deletes what is left once git has forgotten the worktree, and nothing while it hasn't", async ({
    fx: f,
  }) => {
    const a = await open(f, "partway")
    const b = await open(f, "listed")
    if (!a.ok || !b.ok) throw new Error("open")
    const held = join(a.path, "held")
    mkdirSync(held)
    writeFileSync(join(held, "file.txt"), "held\n")
    git(a.path, "add", "-A")
    git(a.path, "commit", "-q", "-m", "held")
    chmodSync(held, 0o555)
    try {
      expect(() => git(f.repo, "worktree", "remove", a.path)).toThrow()
    } finally {
      chmodSync(held, 0o755)
    }
    // Git forgot it, and left part of its folder.
    expect(existsSync(held)).toBe(true)
    expect(git(f.repo, "worktree", "list", "--porcelain")).not.toContain(asGit(a.path))
    // One git still lists stays, under another spelling of its path too.
    await expect(finishRemoval(f.repo, b.path)).resolves.toBe(false)
    await expect(finishRemoval(f.repo, join(b.path, "..", basename(b.path)))).resolves.toBe(false)
    expect(existsSync(b.path)).toBe(true)
    // Where git can't list its worktrees, nothing is touched.
    await expect(finishRemoval(f.other, a.path)).resolves.toBe(false)
    expect(existsSync(held)).toBe(true)
    await expect(finishRemoval(f.repo, a.path)).resolves.toBe(true)
    expect(existsSync(a.path)).toBe(false)
  })
})

describe("telling that a worktree changed hands or went", () => {
  it("tells of each give, transfer, take of one with no owner and restore, and of each removal", async ({
    fx: f,
  }) => {
    const changes: unknown[] = []
    const stop = f.worktrees.onChanged((one) => changes.push(one))
    const a = await open(f, "a")
    const b = await open(f, "b")
    if (!a.ok || !b.ok) throw new Error("open")
    // Opening is making, not changing hands.
    expect(changes).toEqual([])

    await f.worktrees.give({ terminalId: "t1", cwd: f.repo, path: a.path, to: "t2" })
    expect(await f.worktrees.transfer(a.path, "t2", "t1")).toBe(true)
    f.live.delete("t1")
    await f.worktrees.take({ projectId: f.project, terminalId: "t2", cwd: f.repo, path: b.path })
    expect(changes).toEqual([
      { type: "moved", root: a.path, from: "t1", to: "t2" },
      { type: "moved", root: a.path, from: "t2", to: "t1" },
      { type: "moved", root: b.path, from: "t1", to: "t2" },
    ])

    // A restore from History moves what its terminal owned; a refused give and an orphaning don't.
    await f.worktrees.ownerRestored("t2", "t3")
    expect(changes).toHaveLength(4)
    expect(changes[3]).toEqual({ type: "moved", root: b.path, from: "t2", to: "t3" })
    const refused = await f.worktrees.give({
      terminalId: "t2",
      cwd: f.repo,
      path: a.path,
      to: "t2",
    })
    expect(refused.ok).toBe(false)
    await f.worktrees.orphanIf(b.path, "t3")
    expect(changes).toHaveLength(4)

    changes.length = 0
    await f.worktrees.closeOwned({ terminalId: "t1", cwd: f.repo, path: a.path, force: false })
    rmSync(b.path, { recursive: true, force: true })
    await f.worktrees.reconcile()
    expect(changes).toEqual([
      { type: "removed", root: a.path },
      { type: "removed", root: b.path },
    ])
    stop()
  })
})

describe("telling that a worktree was made", () => {
  it("tells of one opened and of one adopted, once each, and of nothing else", async ({
    fx: f,
  }) => {
    const made: unknown[] = []
    const stop = f.worktrees.onMade((one) => made.push(one))
    const a = await open(f, "a")
    if (!a.ok) throw new Error("open")
    expect(made).toEqual([{ root: a.path, projectId: f.project }])

    const path = join(f.other, "made-elsewhere")
    git(f.repo, "worktree", "add", "-b", "scripted", path)
    const take = (terminalId: string, at: string) =>
      f.worktrees.take({ projectId: f.project, terminalId, cwd: f.repo, path: at })
    await take("t1", path)
    expect(made).toHaveLength(2)
    expect(made[1]).toEqual({ root: path, projectId: f.project })

    // Owning it already, taking it from another, giving and restoring are not making.
    await take("t1", path)
    await take("t2", a.path)
    await f.worktrees.transfer(a.path, "t1", "t2")
    await f.worktrees.ownerRestored("t2", "t3")
    await f.worktrees.orphanIf(a.path, "t3")
    f.live.delete("t1")
    await take("t2", path)
    expect(made).toHaveLength(2)

    // A refused open is not making either, and a stopped listener hears nothing more.
    await open(f, "a")
    expect(made).toHaveLength(2)
    stop()
    await open(f, "b")
    expect(made).toHaveLength(2)
  })
})

// Commits a file on the checkout's own branch.
const commitIn = (folder: string, file: string): string => {
  writeFileSync(join(folder, file), `${file}\n`)
  git(folder, "add", "-A")
  git(folder, "commit", "--quiet", "-m", `add ${file}`)
  return git(folder, "rev-parse", "HEAD")
}

const keyOf = (folder: string, branch: string, key: string): string => {
  try {
    return git(folder, "config", "--get", `branch.${branch}.${key}`)
  } catch {
    return ""
  }
}

describe("a folder that is in no git repository", () => {
  it("is refused by open and take with the fact, that its files are changed in place", async ({
    fx: f,
  }) => {
    const plain = join(f.other, "notes")
    mkdirSync(plain)
    const opened = await f.worktrees.open({
      projectId: f.project,
      terminalId: "t1",
      cwd: plain,
      branch: "feat",
    })
    expect(opened).toMatchObject({
      ok: false,
      reason: expect.stringContaining("isn't in a git repository"),
    })
    expect(opened.ok ? "" : opened.reason).toContain("changed in place")
    const taken = await f.worktrees.take({
      projectId: f.project,
      terminalId: "t1",
      cwd: plain,
      path: plain,
    })
    expect(taken).toMatchObject({
      ok: false,
      reason: expect.stringContaining("isn't in a git repository"),
    })
    expect(taken.ok ? "" : taken.reason).toContain("changed in place")
  })

  it("says git's own words, with no advice, for an error that is no missing repository", async ({
    fx: f,
  }) => {
    const broken = join(f.other, "broken")
    mkdirSync(broken)
    writeFileSync(join(broken, ".git"), "gitdir: /nowhere/at/all\n")
    const opened = await f.worktrees.open({
      projectId: f.project,
      terminalId: "t1",
      cwd: broken,
      branch: "feat",
    })
    expect(opened).toMatchObject({
      ok: false,
      reason: expect.stringContaining("git couldn't read"),
    })
    expect(opened.ok ? "" : opened.reason).not.toContain("changed in place")
    const typo = await f.worktrees.open({
      projectId: f.project,
      terminalId: "t1",
      cwd: f.repo,
      repo: join(f.other, "no-such-folder"),
      branch: "feat",
    })
    expect(typo.ok ? "" : typo.reason).not.toContain("changed in place")
  })

  it("is told apart from a repository's folder by its .git, in it or a parent", async ({
    fx: f,
  }) => {
    const plain = join(f.other, "notes")
    mkdirSync(join(plain, "deeper"), { recursive: true })
    expect(await inRepository(plain)).toBe(false)
    expect(await inRepository(f.repo)).toBe(true)
    const lead = await open(f, "feat-x")
    if (!lead.ok) throw new Error(lead.reason)
    // A linked worktree has a .git file.
    expect(await inRepository(lead.path)).toBe(true)
    mkdirSync(join(f.repo, "sub"))
    expect(await inRepository(join(f.repo, "sub"))).toBe(true)
  })

  it("follows a symlink into a repository, and can't tell for no folder, a missing one or a bare repository", async ({
    fx: f,
  }) => {
    const link = join(f.other, "link")
    symlinkSync(join(f.repo, "sub-link-target"), link)
    mkdirSync(join(f.repo, "sub-link-target"))
    expect(await inRepository(link)).toBe(true)
    expect(await inRepository("")).toBeUndefined()
    expect(await inRepository(join(f.other, "missing"))).toBeUndefined()
    const bare = join(f.other, "bare.git")
    git(f.other, "init", "--quiet", "--bare", bare)
    expect(await inRepository(bare)).toBeUndefined()
    // An empty .git folder is none, as git goes on looking above it.
    const empty = join(f.other, "empty")
    mkdirSync(join(empty, ".git"), { recursive: true })
    expect(await inRepository(empty)).toBe(false)
  })

  it("keeps an answer a few seconds, and a turn that waits on nothing gets only what is kept", async ({
    fx: f,
  }) => {
    const folder = join(f.other, "kept-folder")
    mkdirSync(folder)
    // Not kept yet, and not waited for.
    expect(await repositoryKnown(folder, false)).toBeUndefined()
    expect(await repositoryKnown(folder, true)).toBe(false)
    expect(await repositoryKnown(folder, false)).toBe(false)
  })
})

describe("a worktree's home", () => {
  it("is main for a worktree opened from main, said and never written", async ({ fx: f }) => {
    const a = await open(f, "plain")
    if (!a.ok) throw new Error(a.reason)
    expect(a.home).toBe("main")
    expect(keyOf(f.repo, "plain", "novadeckHome")).toBe("")
    // What git now keeps of the branch: where it started, and that Novadeck made it.
    expect(keyOf(f.repo, "plain", "novadeckBase")).toBe(a.base)
    expect(keyOf(f.repo, "plain", "novadeckMade")).toBe("true")
  })

  it("is the branch `from` names, or `home`, here or as origin's", async ({ fx: f }) => {
    git(f.repo, "branch", "JIRA-123")
    const a = await open(f, "agent-1", { from: "JIRA-123" })
    if (!a.ok) throw new Error(a.reason)
    expect(a.home).toBe("JIRA-123")
    expect(keyOf(f.repo, "agent-1", "novadeckHome")).toBe("JIRA-123")
    const b = await open(f, "agent-2", { home: "JIRA-123" })
    if (!b.ok) throw new Error(b.reason)
    expect(b.home).toBe("JIRA-123")
    // A commit is no branch: home stays main.
    const c = await open(f, "agent-3", { from: git(f.repo, "rev-parse", "HEAD") })
    if (!c.ok) throw new Error(c.reason)
    expect(c.home).toBe("main")
  })

  it("is the branch the new branch starts from when from is left out, as in a lead's worktree", async ({
    fx: f,
  }) => {
    const lead = await open(f, "feat-x")
    if (!lead.ok) throw new Error(lead.reason)
    // A teammate opened from inside the lead's worktree: it starts from feat-x's HEAD.
    writeFileSync(join(lead.path, "lead.txt"), "lead\n")
    git(lead.path, "add", "-A")
    git(lead.path, "commit", "--quiet", "-m", "lead")
    const mate = await f.worktrees.open({
      projectId: f.project,
      terminalId: "t2",
      cwd: lead.path,
      branch: "mate-1",
    })
    if (!mate.ok) throw new Error(mate.reason)
    expect(mate.base).toBe(git(lead.path, "rev-parse", "HEAD"))
    expect(mate.home).toBe("feat-x")
    expect(keyOf(f.repo, "mate-1", "novadeckHome")).toBe("feat-x")
    // Said by the open's own answer, and a home that can be changed later by its owner.
    expect(
      await f.worktrees.take({
        projectId: f.project,
        terminalId: "t2",
        cwd: mate.path,
        path: mate.path,
        home: "main",
      }),
    ).toMatchObject({ ok: true, already: true, home: "main" })
    expect(keyOf(f.repo, "mate-1", "novadeckHome")).toBe("")
  })

  it("is the checkout's branch when that is where it starts from, as from HEAD says too", async ({
    fx: f,
  }) => {
    git(f.repo, "checkout", "--quiet", "-b", "person-feature")
    for (const [name, extra] of [
      ["left-out", {}],
      ["from-head", { from: "HEAD" }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- One open at a time, in one repository.
      const opened = await open(f, name, extra)
      if (!opened.ok) throw new Error(opened.reason)
      expect(opened.home).toBe("person-feature")
    }
    // A commit spelled as a revision of it is no branch.
    for (const from of ["@", "person-feature~0"]) {
      // eslint-disable-next-line no-await-in-loop -- As above.
      const opened = await open(f, `from-${from.replaceAll(/\W/g, "")}`, { from })
      if (!opened.ok) throw new Error(opened.reason)
      expect(opened.home).toBe("main")
    }
  })

  it("is main where the start has no branch: a detached HEAD, or main itself", async ({
    fx: f,
  }) => {
    const plain = await open(f, "from-main")
    if (!plain.ok) throw new Error(plain.reason)
    expect(plain.home).toBe("main")
    git(f.repo, "checkout", "--quiet", "--detach")
    const opened = await open(f, "from-detached")
    if (!opened.ok) throw new Error(opened.reason)
    expect(opened.home).toBe("main")
    expect(keyOf(f.repo, "from-detached", "novadeckHome")).toBe("")
  })

  it("is main for an existing branch checked out, and for a given tag", async ({ fx: f }) => {
    git(f.repo, "branch", "existing")
    git(f.repo, "tag", "v1")
    git(f.repo, "checkout", "--quiet", "-b", "person-feature")
    const existing = await open(f, "existing")
    if (!existing.ok) throw new Error(existing.reason)
    expect(existing.home).toBe("main")
    const tagged = await open(f, "from-tag", { from: "v1" })
    if (!tagged.ok) throw new Error(tagged.reason)
    expect(tagged.home).toBe("main")
  })

  it("refuses its own branch, and a branch that isn't here or on origin", async ({ fx: f }) => {
    expect(await open(f, "self", { home: "self" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("another branch than its own"),
    })
    expect(await open(f, "lost", { home: "nowhere" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("nowhere isn't a branch here or on origin"),
    })
    expect(f.store.worktree(join(f.root, f.project, "lost", "api"))).toBeUndefined()
  })

  it("forgets what a deleted branch of that name left in git config", async ({ fx: f }) => {
    git(f.repo, "branch", "JIRA-123")
    git(f.repo, "config", "branch.reused.novadeckHome", "JIRA-123")
    const a = await open(f, "reused")
    if (!a.ok) throw new Error(a.reason)
    expect(a.home).toBe("main")
    expect(keyOf(f.repo, "reused", "novadeckHome")).toBe("")
  })

  it("closes a worktree whose work landed on home, deleting the branch it made", async ({
    fx: f,
  }) => {
    git(f.repo, "branch", "JIRA-123")
    const a = await open(f, "agent", { from: "JIRA-123" })
    if (!a.ok) throw new Error(a.reason)
    commitIn(a.path, "fix.txt")
    const row = f.store.worktree(a.path)!
    // Not on home yet: what it holds is named by home.
    expect(await f.worktrees.remove(row, false)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("1 commit JIRA-123 doesn't have"),
    })
    // Landed: home fast-forwarded to it, as a local landing does, with main left behind.
    git(f.repo, "branch", "-f", "JIRA-123", "agent")
    expect(await f.worktrees.remove(row, false)).toMatchObject({ ok: true, branchDeleted: true })
    expect(git(f.repo, "branch", "--list", "agent")).toBe("")
  })

  it("closes one whose work reached main instead of home, as a retargeted stack does", async ({
    fx: f,
  }) => {
    git(f.repo, "branch", "JIRA-123")
    const a = await open(f, "child", { from: "JIRA-123" })
    if (!a.ok) throw new Error(a.reason)
    commitIn(a.path, "child.txt")
    git(f.repo, "merge", "--quiet", "--squash", "child")
    git(f.repo, "commit", "--quiet", "-m", "squash child")
    expect(await f.worktrees.remove(f.store.worktree(a.path)!, false)).toMatchObject({
      ok: true,
    })
  })

  it("changes on take, for a worktree that is the caller's by it, and is said", async ({
    fx: f,
  }) => {
    git(f.repo, "branch", "JIRA-123")
    const a = await open(f, "agent")
    if (!a.ok) throw new Error(a.reason)
    expect(
      await f.worktrees.take({
        projectId: f.project,
        terminalId: "t1",
        cwd: f.repo,
        path: a.path,
        home: "JIRA-123",
      }),
    ).toMatchObject({ ok: true, already: true, home: "JIRA-123" })
    expect(keyOf(f.repo, "agent", "novadeckHome")).toBe("JIRA-123")
    // Back to main: the key goes, as main is measured by without one.
    expect(
      await f.worktrees.take({
        projectId: f.project,
        terminalId: "t1",
        cwd: f.repo,
        path: a.path,
        home: "main",
      }),
    ).toMatchObject({ ok: true, home: "main" })
    expect(keyOf(f.repo, "agent", "novadeckHome")).toBe("")
  })

  it("keeps what a script set on a worktree it made, when adopted", async ({ fx: f }) => {
    git(f.repo, "branch", "JIRA-123")
    const path = join(f.other, "scripted")
    git(f.repo, "worktree", "add", "--quiet", "-b", "scripted", path)
    git(f.repo, "config", "branch.scripted.novadeckHome", "JIRA-123")
    expect(
      await f.worktrees.take({ projectId: f.project, terminalId: "t1", cwd: f.repo, path }),
    ).toMatchObject({ ok: true, home: "JIRA-123" })
  })
})

describe("carrying rows into git config at the runner's start", () => {
  it("writes the start and who made the branch, only while the row's branch is checked out", async ({
    fx: f,
  }) => {
    const a = await open(f, "older")
    const b = await open(f, "moved")
    if (!a.ok || !b.ok) throw new Error("open")
    // As a build before this one left them: no keys.
    for (const branch of ["older", "moved"])
      for (const key of ["novadeckBase", "novadeckMade"])
        git(f.repo, "config", "--unset", `branch.${branch}.${key}`)
    // An agent moved one worktree to another branch since: its row's branch name may be reused.
    git(b.path, "checkout", "--quiet", "-b", "elsewhere")
    await f.worktrees.reconcile()
    expect(keyOf(f.repo, "older", "novadeckBase")).toBe(a.base)
    expect(keyOf(f.repo, "older", "novadeckMade")).toBe("true")
    expect(keyOf(f.repo, "moved", "novadeckBase")).toBe("")
    expect(keyOf(f.repo, "elsewhere", "novadeckBase")).toBe("")
    // Again: nothing more to carry.
    await f.worktrees.reconcile()
    expect(keyOf(f.repo, "older", "novadeckBase")).toBe(a.base)
  })
})
