import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { vi } from "vitest"

import { describe, expect, it as base } from "../test.js"
import { WorkspaceStore } from "../workspaces/store.js"
import type { OwnerState } from "./cleanup.js"
import { Worktrees } from "./worktrees.js"

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

const repository = (parent: string, name: string): string => {
  const repo = join(parent, name)
  mkdirSync(repo)
  git(repo, "init", "--quiet", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "--quiet", "-m", "first")
  return repo
}

type Fixture = {
  repo: string
  project: string
  store: WorkspaceStore
  /** Where each terminal is; one not listed is gone. */
  owners: Map<string, OwnerState>
  /** The worktrees an agent is working in. */
  busy: Set<string>
  worktrees: Worktrees
  /** Makes a worktree owned by `t1` with a commit on its branch. */
  work: (branch: string, committed?: boolean) => Promise<string>
}

const it = base.extend<{ fx: Fixture }>({
  fx: async ({ resources }, use) => {
    const repo = repository(temporary(resources, "cl-repo"), "api")
    const root = temporary(resources, "cl-root")
    const owners = new Map<string, OwnerState>([["t1", "open"]])
    const busy = new Set<string>()
    const store = new WorkspaceStore(":memory:")
    resources.defer(() => store.close())
    const project = randomUUID()
    await store.createProject({ id: project, name: "P", cwd: repo })
    const worktrees = new Worktrees(store, {
      exists: (id) => owners.has(id),
      owner: (id) => owners.get(id) ?? "gone",
      busy: (row) =>
        Promise.resolve(busy.has(row.path) ? "An agent is working in that worktree." : undefined),
      root,
      projectFolder: () => repo,
    })
    resources.defer(() => worktrees.stop())
    const work = async (branch: string, committed = true): Promise<string> => {
      const opened = await worktrees.open({
        projectId: project,
        terminalId: "t1",
        cwd: repo,
        branch,
      })
      if (!opened.ok) throw new Error(opened.reason)
      if (committed) {
        writeFileSync(join(opened.path, `${branch}.txt`), "w\n")
        git(opened.path, "add", "-A")
        git(opened.path, "commit", "--quiet", "-m", `work on ${branch}`)
      }
      return opened.path
    }
    await use({ repo, project, store, owners, busy, worktrees, work })
  },
})

// Waits for a look that nothing asked for by name (a timer's, a close's) to remove the folder.
const goes = async (path: string): Promise<boolean> => {
  // eslint-disable-next-line no-await-in-loop -- Polling, one wait after another.
  for (let tries = 0; tries < 100 && existsSync(path); tries += 1) await sleep(50)
  return !existsSync(path)
}

const squashIntoMain = (f: Fixture, branch: string) => {
  git(f.repo, "merge", "--quiet", "--squash", branch)
  git(f.repo, "commit", "--quiet", "-m", `squash ${branch}`)
}

describe("cleaning up merged worktrees", () => {
  it("leaves a merged worktree while its owner is open, and removes it once the owner closed", async ({
    fx: f,
  }) => {
    const path = await f.work("squashed")
    squashIntoMain(f, "squashed")
    await f.worktrees.tidy()
    expect(existsSync(path)).toBe(true)
    // asleep (hibernated) reads as open too
    f.owners.set("t1", "history")
    await f.worktrees.tidy()
    expect(existsSync(path)).toBe(false)
    expect(f.store.worktree(path)).toBeUndefined()
    expect(git(f.repo, "branch", "--list", "squashed")).toBe("")
  })

  it("removes a merged worktree with no owner, or whose owner is gone from both places", async ({
    fx: f,
  }) => {
    const orphaned = await f.work("orphaned")
    const gone = await f.work("gone")
    // Both are merged by fast-forward: nothing beyond main.
    git(f.repo, "merge", "--quiet", "orphaned", "gone")
    f.store.orphanWorktree(orphaned)
    f.owners.clear()
    await f.worktrees.tidy()
    expect(existsSync(orphaned)).toBe(false)
    expect(existsSync(gone)).toBe(false)
  })

  it("keeps an unmerged worktree whose owner closed, and an orphaned one, until told otherwise", async ({
    fx: f,
  }) => {
    const closed = await f.work("closed")
    const orphaned = await f.work("orphaned")
    f.owners.set("t1", "history")
    f.store.orphanWorktree(orphaned)
    await f.worktrees.tidy()
    expect(existsSync(closed)).toBe(true)
    expect(existsSync(orphaned)).toBe(true)
    expect(f.store.worktree(orphaned)?.terminalId).toBeNull()
  })

  it("keeps a merged worktree with uncommitted files after its owner closed", async ({ fx: f }) => {
    const path = await f.work("dirty")
    git(f.repo, "merge", "--quiet", "dirty")
    writeFileSync(join(path, "loose.txt"), "x\n")
    f.owners.set("t1", "history")
    await f.worktrees.tidy()
    expect(existsSync(path)).toBe(true)
  })

  it("never removes one an agent works in, until it stops", async ({ fx: f }) => {
    const path = await f.work("busy")
    git(f.repo, "merge", "--quiet", "busy")
    f.owners.set("t1", "history")
    f.busy.add(path)
    await f.worktrees.tidy()
    expect(existsSync(path)).toBe(true)
    f.busy.delete(path)
    await f.worktrees.tidy()
    expect(existsSync(path)).toBe(false)
  })

  it("never removes one whose status git couldn't read", async ({ fx: f }) => {
    const path = await f.work("unreadable")
    git(f.repo, "merge", "--quiet", "unreadable")
    writeFileSync(
      git(path, "rev-parse", "--path-format=absolute", "--git-path", "index"),
      "not an index",
    )
    f.owners.set("t1", "history")
    await f.worktrees.tidy()
    expect(existsSync(path)).toBe(true)
    expect(f.store.worktree(path)).toBeDefined()
  })

  it("does nothing for an owner restored from History: the worktree stays, unmerged", async ({
    fx: f,
  }) => {
    const path = await f.work("restored")
    f.owners.set("t1", "history")
    await f.worktrees.tidy()
    // Restored as another terminal: the History row went, nothing is pruned.
    f.owners.delete("t1")
    f.owners.set("t2", "open")
    await f.worktrees.tidy()
    expect(existsSync(path)).toBe(true)
    expect(f.store.worktree(path)).toBeDefined()
  })

  it("looks again on a timer, and when a terminal closes", async ({ fx: f }) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    try {
      const path = await f.work("timed")
      git(f.repo, "merge", "--quiet", "timed")
      f.worktrees.start()
      // The first look, as it starts: the owner is open.
      await sleep(300)
      expect(existsSync(path)).toBe(true)
      f.owners.set("t1", "history")
      vi.advanceTimersByTime(59_000)
      await sleep(300)
      expect(existsSync(path)).toBe(true)
      vi.advanceTimersByTime(1_000)
      expect(await goes(path)).toBe(true)
      // And on a close, without waiting for the timer.
      f.owners.set("t3", "open")
      const second = await f.work("closing")
      f.store.setWorktreeOwner(second, "t3")
      git(f.repo, "merge", "--quiet", "closing")
      f.owners.set("t3", "history")
      f.worktrees.ownerClosed()
      expect(await goes(second)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("cleaning up when History lets a terminal go", () => {
  it("removes an unmerged worktree, keeping loose files on a ref and the branch", async ({
    fx: f,
  }) => {
    const path = await f.work("unmerged")
    writeFileSync(join(path, "loose.txt"), "keep me\n")
    f.owners.set("t1", "history")
    await f.worktrees.tidy()
    expect(existsSync(path)).toBe(true)
    f.owners.delete("t1")
    await f.worktrees.ownersPruned(["t1"])
    expect(existsSync(path)).toBe(false)
    expect(f.store.worktree(path)).toBeUndefined()
    expect(git(f.repo, "branch", "--list", "unmerged")).toContain("unmerged")
    const refs = git(f.repo, "for-each-ref", "--format=%(refname)", "refs/novadeck/kept")
    expect(refs).toContain("unmerged-work")
    expect(git(f.repo, "show", `${refs.split("\n")[0]}:loose.txt`)).toBe("keep me")
  })

  it("keeps a detached HEAD's commits on a ref", async ({ fx: f }) => {
    const path = await f.work("detached")
    git(path, "checkout", "--quiet", "--detach")
    writeFileSync(join(path, "d.txt"), "d\n")
    git(path, "add", "-A")
    git(path, "commit", "--quiet", "-m", "only HEAD has this")
    f.owners.clear()
    await f.worktrees.ownersPruned(["t1"])
    expect(existsSync(path)).toBe(false)
    expect(git(f.repo, "for-each-ref", "--format=%(refname)", "refs/novadeck/kept")).toContain(
      "detached-head",
    )
  })

  it("orphans a worktree it can't read and leaves its folder", async ({ fx: f }) => {
    const path = await f.work("stuck")
    writeFileSync(
      git(path, "rev-parse", "--path-format=absolute", "--git-path", "index"),
      "not an index",
    )
    f.owners.clear()
    await f.worktrees.ownersPruned(["t1"])
    expect(existsSync(path)).toBe(true)
    expect(f.store.worktree(path)?.terminalId).toBeNull()
  })

  it("leaves one an agent works in, orphaned", async ({ fx: f }) => {
    const path = await f.work("busy")
    f.busy.add(path)
    f.owners.clear()
    await f.worktrees.ownersPruned(["t1"])
    expect(existsSync(path)).toBe(true)
    expect(f.store.worktree(path)?.terminalId).toBeNull()
  })

  it("leaves a worktree another terminal took meanwhile", async ({ fx: f }) => {
    const path = await f.work("taken")
    f.store.setWorktreeOwner(path, "t2")
    f.owners.set("t2", "open")
    await f.worktrees.ownersPruned(["t1"])
    expect(existsSync(path)).toBe(true)
    expect(f.store.worktree(path)?.terminalId).toBe("t2")
  })
})
