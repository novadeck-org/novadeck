import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { Worktrees, folderName } from "./worktrees.js"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  }).trim()

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
    expect(listed).toContain(away)
    expect(listed).not.toContain(a.path)
  })
})

describe("reconciling at the runner's start", () => {
  it("drops a row whose folder is gone and prunes its repository", async ({ fx: f }) => {
    const a = await open(f, "gone")
    if (!a.ok) throw new Error("open")
    rmSync(a.path, { recursive: true, force: true })
    await f.worktrees.reconcile()
    expect(f.store.worktree(a.path)).toBeUndefined()
    expect(git(f.repo, "worktree", "list", "--porcelain")).not.toContain(a.path)
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
