import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { treeGone } from "./repository.js"
import { Snapshots } from "./snapshots.js"

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

type Fixture = {
  readonly holder: string
  /** A repository on main with one commit. */
  readonly root: string
  readonly git: (cwd: string, ...args: string[]) => string
}

const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    const holder = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-snapshots-test-")))
    resources.defer(() =>
      rmSync(holder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    )
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=T",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd, encoding: "utf8" },
      ).trim()
    const root = join(holder, "repo")
    git(holder, "init", "--quiet", "-b", "main", root)
    writeFileSync(join(root, "a.txt"), "a\n")
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", "first")
    await use({ holder, root, git })
  },
})

const none = (): boolean => false

describe.skipIf(!hasGit)("the snapshots of checkouts", () => {
  it("serves a snapshot while it is fresh, and takes one when asked", async ({
    fixture,
    resources,
  }) => {
    let now = 1_000
    const snapshots = new Snapshots({ held: () => none, freshMs: 500, now: () => now })
    resources.defer(() => snapshots.close())
    const take = (fresh?: boolean) =>
      snapshots.use(fixture.root, (checkout) => checkout.take(fresh))
    const first = await take()
    writeFileSync(join(fixture.root, "a.txt"), "changed\n")
    now = 1_400
    expect(await take()).toBe(first)
    const fresh = await take(true)
    expect(fresh?.tree).not.toBe(first?.tree)
    now = 2_000
    writeFileSync(join(fixture.root, "a.txt"), "again\n")
    expect((await take())?.tree).not.toBe(fresh?.tree)
  })

  it("keeps one object folder for a repository's worktrees, beside its home", async ({
    fixture,
    resources,
  }) => {
    const home = join(fixture.holder, "state", "works-objects")
    const snapshots = new Snapshots({ held: () => none, freshMs: 0, home })
    resources.defer(() => snapshots.close())
    const other = join(fixture.holder, "other")
    fixture.git(fixture.root, "worktree", "add", "--quiet", "-b", "other", other)
    writeFileSync(join(fixture.root, "a.txt"), "main\n")
    writeFileSync(join(other, "a.txt"), "other\n")
    const [one, two] = await Promise.all(
      [fixture.root, other].map((root) => snapshots.use(root, (checkout) => checkout.take())),
    )
    expect(readdirSync(home)).toHaveLength(1)
    // Either's objects are readable where the other's are.
    expect(await treeGone(fixture.root, two!.tree, one!.env)).toBe(false)
    // The person's own store holds neither.
    expect(await treeGone(fixture.root, one!.tree)).toBe(true)
  })

  it("rebuilds a folder that took many snapshots, keeping the trees kept", async ({
    fixture,
    resources,
  }) => {
    const snapshots = new Snapshots({ held: () => none, freshMs: 0, repackAfter: 3 })
    resources.defer(() => snapshots.close())
    const take = () => snapshots.use(fixture.root, (checkout) => checkout.take())
    writeFileSync(join(fixture.root, "a.txt"), "kept\n")
    const kept = (await take())!
    snapshots.keep(() => [kept.tree])
    writeFileSync(join(fixture.root, "a.txt"), "dropped\n")
    const dropped = (await take())!
    await take()
    writeFileSync(join(fixture.root, "a.txt"), "after\n")
    // The next use waits for the rebuild.
    const after = (await take())!
    expect(after.generation).toBe(kept.generation + 1)
    expect(await treeGone(fixture.root, kept.tree, after.env)).toBe(false)
    expect(await treeGone(fixture.root, dropped.tree, after.env)).toBe(true)
  })

  it("refuses uses once closed, and removes its own folder", async ({ fixture }) => {
    const snapshots = new Snapshots({ held: () => none })
    await snapshots.use(fixture.root, (checkout) => checkout.take())
    const folder = await (snapshots as unknown as { temporary: Promise<string> }).temporary
    await snapshots.close()
    expect(existsSync(folder)).toBe(false)
    await expect(snapshots.use(fixture.root, async () => 1)).rejects.toThrow("closing")
  })
})
