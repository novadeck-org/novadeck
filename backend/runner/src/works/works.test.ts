import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { Work } from "@novadeck/protocol"
import { afterEach } from "vitest"

import { Snapshots } from "../checkouts/snapshots.js"
import { DomainError } from "../errors.js"
import { describe, expect, it as base } from "../test.js"
import { Works, type Removal, type Tracked } from "./works.js"

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const project = "22222222-2222-4222-8222-222222222222"
const terminal = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

type Checkout = {
  readonly root: string
  readonly git: (...args: string[]) => string
  readonly write: (path: string, text: string) => void
  readonly read: (path: string) => string
}

type Fixture = {
  /** The repository, on main with one commit holding `a.txt` (ten lines) and `b.txt`. */
  readonly main: Checkout
  /** Another worktree of it on a branch, made from the first commit. */
  readonly worktree: (name: string) => Checkout
  /** Where a test may keep files of its own. */
  readonly holder: string
}

const ten = Array.from({ length: 10 }, (_, at) => `line ${at + 1}`).join("\n") + "\n"

// A repository of its own in a temporary folder, with an identity and no global config.
const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    const holder = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-works-test-")))
    resources.defer(() =>
      rmSync(holder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    )
    const config = join(holder, "gitconfig")
    writeFileSync(config, "[core]\n\tautocrlf = false\n")
    const checkout = (root: string): Checkout => ({
      root,
      git: (...args) =>
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
          {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
          },
        ),
      write: (path, text) => {
        const full = join(root, path)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, text)
      },
      read: (path) => readFileSync(join(root, path), "utf8"),
    })
    const root = join(holder, "repo")
    mkdirSync(root)
    const main = checkout(root)
    main.git("init", "--quiet", "-b", "main")
    main.write("a.txt", ten)
    main.write("b.txt", "b\n")
    main.git("add", "-A")
    main.git("commit", "--quiet", "-m", "first")
    await use({
      main,
      holder,
      worktree: (name) => {
        const path = join(holder, name)
        main.git("worktree", "add", "--quiet", "-b", name, path)
        return checkout(realpathSync.native(path))
      },
    })
  },
})

// A tracked worktree: its owner (null for none), and whether the owner's agent is mid-turn in it.
type Where = {
  readonly terminalId: string | null
  readonly root: string
  readonly working?: boolean
  /** When its repository's origin was last fetched. */
  readonly fetchedAt?: number
  /** The commit it started from; unknown when left out. */
  readonly base?: string
}

// A watch tells `synced` without the checkouts not read within 1.5 s, which three can take on a
// loaded Windows runner. The tests wait for every one, as `current` counts on.
const everything = 60_000

// Snapshots as the runner makes them (beside the memory where there is one), each taken afresh:
// a test reads right after an edit. Closed after each test, after its works.
const made: Snapshots[] = []
const snapshotsFor = (memory?: string, repackAfter?: number): Snapshots => {
  const snapshots = new Snapshots({
    // Which files may hold secrets is the companions' rule, tested there.
    held: () => () => false,
    freshMs: 0,
    ...(memory !== undefined && { home: join(dirname(memory), "works-objects") }),
    ...(repackAfter !== undefined && { repackAfter }),
  })
  made.push(snapshots)
  return snapshots
}
afterEach(async () => {
  await Promise.all(made.splice(0).map((each) => each.close()))
})

// The row of a tracked worktree, as the runner's table gives it.
const tracked = ({ terminalId, root, fetchedAt, base: start }: Where): Tracked => ({
  root,
  projectId: project,
  terminalId,
  createdAt: 50,
  ...(start !== undefined && { base: start }),
  ...(fetchedAt !== undefined && { fetchedAt }),
})

// A Works over the worktrees `where` names, read as fast as the test needs.
const open = (
  where: () => readonly Where[],
  options: {
    memory?: string
    repackAfter?: number
    remove?: (root: string, force: boolean) => Promise<Removal>
    /** Terminals in checkouts that are no tracked worktree, as plain terminals are. */
    plain?: readonly { terminalId: string; root: string }[]
    show?: (terminalId: string, root: string) => Promise<string>
  } = {},
) => {
  const shown: [string, string][] = []
  const removed: [string, boolean][] = []
  const works = new Works({
    tracked: () => where().map(tracked),
    presences: async () => [
      ...where().flatMap(({ terminalId, root, working }) =>
        terminalId === null ? [] : [{ terminalId, root, working: working === true }],
      ),
      ...(options.plain ?? []).map((each) => ({ ...each, working: false })),
    ],
    show:
      options.show ??
      (async (terminalId, root) => {
        shown.push([terminalId, root])
        return "item"
      }),
    remove:
      options.remove ??
      (async (root, force) => {
        removed.push([root, force])
        return { ok: true, branchDeleted: false }
      }),
    everyMs: 20,
    firstMs: everything,
    snapshots: snapshotsFor(options.memory, options.repackAfter),
    ...(options.memory !== undefined && { memory: options.memory }),
  })
  return { works, shown, removed }
}

// What the works are as of now, by root: a watch's first sequence, read afresh.
const current = async (works: Works): Promise<Map<string, Work>> => {
  const stop = new AbortController()
  const found = new Map<string, Work>()
  try {
    for await (const change of works.watch("owner", stop.signal)) {
      if (change.type === "synced") break
      if (change.type === "changed") found.set(change.work.root, change.work)
    }
  } finally {
    stop.abort()
  }
  return found
}

describe.skipIf(!hasGit)("the works of tracked worktrees", () => {
  it("lists a worktree identical to main as a work with no files, first seen when it was recorded", async ({
    fixture,
    resources,
  }) => {
    const { works } = open(() => [{ terminalId: terminal(1), root: fixture.main.root }])
    resources.defer(() => works.close())
    const found = await current(works)
    expect([...found.keys()]).toEqual([fixture.main.root])
    expect(found.get(fixture.main.root)).toMatchObject({
      terminalId: terminal(1),
      branch: "main",
      base: "main",
      firstSeenAt: 50,
      added: 0,
      removed: 0,
      files: [],
      conflicts: [],
      working: false,
    })
  })

  it("carries when origin was fetched where main is a remote-tracking ref, and nothing before it was", async ({
    fixture,
    resources,
  }) => {
    fixture.main.git("update-ref", "refs/remotes/origin/main", "HEAD")
    fixture.main.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    const fetched = fixture.worktree("fetched")
    const never = fixture.worktree("never")
    const { works } = open(() => [
      { terminalId: terminal(1), root: fetched.root, fetchedAt: 1_700_000_000_000 },
      { terminalId: terminal(1), root: never.root },
    ])
    resources.defer(() => works.close())
    const found = await current(works)
    expect(found.get(fetched.root)).toMatchObject({
      base: "origin/main",
      fetchedAt: 1_700_000_000_000,
    })
    expect(found.get(never.root)).not.toHaveProperty("fetchedAt")
  })

  it("says nothing of a fetch where main is the local branch, which a fetch cannot move", async ({
    fixture,
    resources,
  }) => {
    const local = fixture.worktree("local")
    const { works } = open(() => [
      { terminalId: terminal(1), root: local.root, fetchedAt: 1_700_000_000_000 },
    ])
    resources.defer(() => works.close())
    const found = await current(works)
    expect(found.get(local.root)).toMatchObject({ base: "main" })
    expect(found.get(local.root)).not.toHaveProperty("fetchedAt")
  })

  it("has no work for a checkout no worktree is tracked at", async ({ fixture, resources }) => {
    fixture.main.write("b.txt", "changed\n")
    const { works } = open(() => [])
    resources.defer(() => works.close())
    expect((await current(works)).size).toBe(0)
  })

  it("keys a work by its worktree, with its owner, or with no owner at all", async ({
    fixture,
    resources,
  }) => {
    const owned = fixture.worktree("owned")
    const orphan = fixture.worktree("orphan")
    owned.write("b.txt", "owned\n")
    orphan.write("b.txt", "orphan\n")
    const { works } = open(() => [
      { terminalId: terminal(1), root: owned.root },
      { terminalId: null, root: orphan.root },
    ])
    resources.defer(() => works.close())
    const found = await current(works)
    expect(found.get(owned.root)).toMatchObject({ terminalId: terminal(1), projectId: project })
    expect(found.get(orphan.root)).toMatchObject({
      terminalId: null,
      projectId: project,
      branch: "orphan",
    })
  })

  it("says whether the owner's agent is working in the worktree, and in no other", async ({
    fixture,
    resources,
  }) => {
    const here = fixture.worktree("here")
    const there = fixture.worktree("there")
    here.write("b.txt", "here\n")
    there.write("b.txt", "there\n")
    const state = { working: true }
    // The owner works in `here`; `there` is its worktree too, but it is elsewhere.
    const { works } = open(() => [
      { terminalId: terminal(1), root: here.root, working: state.working },
      { terminalId: terminal(1), root: there.root, working: false },
    ])
    resources.defer(() => works.close())
    let found = await current(works)
    expect(found.get(here.root)?.working).toBe(true)
    expect(found.get(there.root)?.working).toBe(false)
    state.working = false
    found = await current(works)
    expect(found.get(here.root)?.working).toBe(false)
  })

  it("lists what the working tree changes against main, untracked files too, and no index touched", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    main.write("a.txt", ten.replace("line 2\n", "two\nand a half\n"))
    main.write("new/c.txt", "c1\nc2\nc3\n")
    main.write("ignored.log", "noise\n")
    main.write(".gitignore", "*.log\n")
    main.git("add", ".gitignore")
    const before = main.git("status", "--porcelain=v2")
    const { works } = open(() => [{ terminalId: terminal(1), root: main.root }])
    resources.defer(() => works.close())
    const work = (await current(works)).get(main.root)!
    expect(work).toMatchObject({
      terminalId: terminal(1),
      projectId: project,
      root: main.root,
      branch: "main",
      base: "main",
      added: 2 + 3 + 1,
      removed: 1,
      truncated: false,
      conflicts: [],
    })
    expect(work.files.map(({ path, added, removed }) => [path, added, removed])).toEqual([
      [".gitignore", 1, 0],
      ["a.txt", 2, 1],
      ["new/c.txt", 3, 0],
    ])
    // Nothing read yet: every line is unread.
    expect([work.unreadAdded, work.unreadRemoved]).toEqual([work.added, work.removed])
    expect(main.git("status", "--porcelain=v2")).toBe(before)
  })

  it("counts as the changes item does: a rename once, re-indented lines apart", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    main.git("mv", "a.txt", "moved.txt")
    // One line changed, two only re-indented.
    main.write(
      "moved.txt",
      ten
        .replace("line 1\n", "  line 1\n")
        .replace("line 2\n", "\tline 2\n")
        .replace("line 9\n", "nine\n"),
    )
    const { works } = open(() => [{ terminalId: terminal(1), root: main.root }])
    resources.defer(() => works.close())
    const work = (await current(works)).get(main.root)!
    expect(work.files.map(({ path, added, removed }) => [path, added, removed])).toEqual([
      ["moved.txt", 1, 1],
    ])
    expect([work.added, work.removed]).toEqual([1, 1])
  })

  it("loads a works.json from before: its tracked worktree keeps its first-seen time, old checkouts are not works", async ({
    fixture,
    resources,
  }) => {
    const { main, holder } = fixture
    const memory = join(holder, "state", "works.json")
    mkdirSync(dirname(memory), { recursive: true })
    // As an earlier version wrote it: keyed by checkout, with a read file, and unrelated roots.
    writeFileSync(
      memory,
      JSON.stringify({
        version: 1,
        roots: {
          [main.root]: { firstSeenAt: 777, watermark: null, read: { "b.txt": "2".repeat(40) } },
          "/somewhere/else": { firstSeenAt: 5, watermark: null },
          "/broken": { firstSeenAt: "soon" },
        },
      }),
    )
    main.write("b.txt", "changed\n")
    const { works } = open(() => [{ terminalId: terminal(1), root: main.root }], { memory })
    resources.defer(() => works.close())
    const found = await current(works)
    expect([...found.keys()]).toEqual([main.root])
    expect(found.get(main.root)?.firstSeenAt).toBe(777)
    expect(works.marks(main.root).get("b.txt")).toBe("2".repeat(40))
  })

  it("keeps the files the person read across runs, until they change or leave the work", async ({
    fixture,
    resources,
  }) => {
    const { main, holder } = fixture
    const memory = join(holder, "state", "works.json")
    main.write("b.txt", "one\n")
    main.write("c.txt", "c\n")
    const there = [{ terminalId: terminal(1), root: main.root }]
    const first = open(() => there, { memory })
    await current(first.works)
    const blob = main.git("hash-object", "b.txt").trim()
    await first.works.markRead(main.root, "b.txt", blob)
    await first.works.markRead(main.root, "c.txt", "0".repeat(40))
    expect([...first.works.marks(main.root)]).toEqual([
      ["b.txt", blob],
      ["c.txt", "0".repeat(40)],
    ])
    await first.works.close()

    const second = open(() => there, { memory })
    resources.defer(() => second.works.close())
    await current(second.works)
    expect(second.works.marks(main.root).get("b.txt")).toBe(blob)
    // A file the work no longer changes is no longer kept.
    rmSync(join(main.root, "c.txt"))
    await current(second.works)
    expect([...second.works.marks(main.root).keys()]).toEqual(["b.txt"])
  })

  it("measures a commit on a branch against origin/HEAD when it is set", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    main.git("update-ref", "refs/remotes/origin/trunk", "HEAD")
    main.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
    main.write("a.txt", ten + "more\n")
    main.git("commit", "--quiet", "-am", "ahead")
    const { works } = open(() => [{ terminalId: terminal(1), root: main.root }])
    resources.defer(() => works.close())
    const work = (await current(works)).get(main.root)!
    expect(work.base).toBe("origin/trunk")
    expect(work.files.map((file) => file.path)).toEqual(["a.txt"])
  })

  it("falls back to master when there is no main", async ({ fixture, resources }) => {
    const { main } = fixture
    main.git("branch", "-m", "main", "master")
    main.write("b.txt", "b\nb2\n")
    const { works } = open(() => [{ terminalId: terminal(1), root: main.root }])
    resources.defer(() => works.close())
    expect((await current(works)).get(main.root)?.base).toBe("master")
  })

  it("has no work where the repository has no main branch", async ({ fixture, resources }) => {
    const { main } = fixture
    main.git("branch", "-m", "main", "trunk")
    main.write("b.txt", "changed\n")
    const { works } = open(() => [{ terminalId: terminal(1), root: main.root }])
    resources.defer(() => works.close())
    expect((await current(works)).size).toBe(0)
  })

  it("counts as unread only what changed since the person last looked", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    main.write("a.txt", ten.replace("line 2\n", "two\n"))
    const { works } = open(() => [{ terminalId: terminal(1), root: main.root }])
    resources.defer(() => works.close())
    expect((await current(works)).get(main.root)).toMatchObject({
      unreadAdded: 1,
      unreadRemoved: 1,
    })
    await works.look(main.root)
    expect((await current(works)).get(main.root)).toMatchObject({
      added: 1,
      removed: 1,
      unreadAdded: 0,
      unreadRemoved: 0,
    })
    main.write("a.txt", ten.replace("line 2\n", "two\n").replace("line 9\n", "nine\nnine+\n"))
    const after = (await current(works)).get(main.root)!
    expect(after).toMatchObject({ added: 3, removed: 2, unreadAdded: 2, unreadRemoved: 1 })
    expect(after.files[0]).toMatchObject({ unreadAdded: 2, unreadRemoved: 1 })
  })

  it("keeps when it first saw the work until nothing differs from main", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    let now = 1_000
    main.write("b.txt", "x\n")
    const works = new Works({
      tracked: () => [tracked({ terminalId: terminal(1), root: main.root })],
      presences: async () => [],
      show: async () => "item",
      remove: async () => ({ ok: true, branchDeleted: false }),
      now: () => now,
      firstMs: everything,
      snapshots: snapshotsFor(),
    })
    resources.defer(() => works.close())
    expect((await current(works)).get(main.root)?.firstSeenAt).toBe(1_000)
    now = 5_000
    main.write("b.txt", "y\n")
    expect((await current(works)).get(main.root)?.firstSeenAt).toBe(1_000)
    main.git("checkout", "--", "b.txt")
    // Nothing differs now: the work stays with no files, and starts over when it differs again.
    expect((await current(works)).get(main.root)).toMatchObject({ files: [], firstSeenAt: 50 })
    now = 9_000
    main.write("b.txt", "z\n")
    expect((await current(works)).get(main.root)?.firstSeenAt).toBe(9_000)
  })

  it("empties when the branch is merged into main, or squashed into it", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    const feature = fixture.worktree("feature")
    feature.write("b.txt", "from the branch\n")
    feature.git("commit", "--quiet", "-am", "branch work")
    const squashed = fixture.worktree("squashed")
    squashed.write("c.txt", "c\n")
    squashed.git("add", "-A")
    squashed.git("commit", "--quiet", "-m", "more")
    const { works } = open(() => [
      { terminalId: terminal(1), root: feature.root },
      { terminalId: terminal(2), root: squashed.root },
    ])
    resources.defer(() => works.close())
    const before = await current(works)
    expect(before.get(feature.root)?.files).toHaveLength(1)
    expect(before.get(squashed.root)?.files).toHaveLength(1)
    main.git("merge", "--quiet", "--no-ff", "-m", "merge", "feature")
    main.git("merge", "--quiet", "--squash", "squashed")
    main.git("commit", "--quiet", "-m", "squash")
    // Still tracked, so still listed, but nothing differs from main any more.
    const after = await current(works)
    expect([...after.keys()].toSorted()).toEqual([feature.root, squashed.root].toSorted())
    expect(after.get(feature.root)).toMatchObject({ files: [], added: 0, removed: 0 })
    expect(after.get(squashed.root)).toMatchObject({ files: [], added: 0, removed: 0 })
  })

  it("calls a work merged when nothing differs and it has commits of its own that main holds", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    const start = main.git("rev-parse", "HEAD").trim()
    const commit = (name: string, file: string) => {
      const each = fixture.worktree(name)
      each.write(file, `${name}\n`)
      each.git("add", "-A")
      each.git("commit", "--quiet", "-m", name)
      return each
    }
    const fresh = fixture.worktree("fresh")
    const squashed = commit("squashed", "c.txt")
    const rebased = commit("rebased", "d.txt")
    const merging = commit("merging", "e.txt")
    const stays = commit("stays", "f.txt")
    const { works } = open(() =>
      [fresh, squashed, rebased, merging, stays].map((each, at) => ({
        terminalId: terminal(at + 1),
        root: each.root,
        base: start,
      })),
    )
    resources.defer(() => works.close())
    const before = await current(works)
    for (const each of [fresh, squashed, rebased, merging, stays])
      expect(before.get(each.root)?.merged).toBe(false)
    main.git("merge", "--quiet", "--squash", "squashed")
    main.git("commit", "--quiet", "-m", "squash")
    // Another commit with the same change, as a rebase merge makes them.
    main.write("d.txt", "rebased\n")
    main.git("add", "-A")
    main.git("commit", "--quiet", "-m", "rebase merge")
    main.git("merge", "--quiet", "--no-ff", "-m", "merge", "merging")
    const after = await current(works)
    expect(after.get(fresh.root)).toMatchObject({ files: [], merged: false })
    // The first two are in main by content: the branch still has commits main lacks.
    expect(after.get(squashed.root)).toMatchObject({ files: [], merged: true })
    expect(after.get(rebased.root)).toMatchObject({ files: [], merged: true })
    // The third's commits are in main's history, off its first-parent line.
    expect(after.get(merging.root)).toMatchObject({ files: [], merged: true })
    expect(after.get(stays.root)).toMatchObject({ merged: false })
    expect(after.get(stays.root)?.files).toHaveLength(1)
  })

  it("does not call a worktree merged that was only fast-forwarded to main", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    const start = main.git("rev-parse", "HEAD").trim()
    const behind = fixture.worktree("behind")
    main.write("g.txt", "g\n")
    main.git("add", "-A")
    main.git("commit", "--quiet", "-m", "main moves on")
    const { works } = open(() => [{ terminalId: terminal(1), root: behind.root, base: start }])
    resources.defer(() => works.close())
    // Behind main: it differs from it, and nothing of its own to merge.
    expect((await current(works)).get(behind.root)).toMatchObject({ merged: false })
    behind.git("merge", "--quiet", "--ff-only", "main")
    expect((await current(works)).get(behind.root)).toMatchObject({ files: [], merged: false })
  })

  it("is not merged where the commit it started from is unknown or gone", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    const squashed = fixture.worktree("squashed")
    squashed.write("c.txt", "c\n")
    squashed.git("add", "-A")
    squashed.git("commit", "--quiet", "-am", "more")
    main.git("merge", "--quiet", "--squash", "squashed")
    main.git("commit", "--quiet", "-m", "squash")
    const gone = fixture.worktree("gone")
    gone.write("d.txt", "d\n")
    gone.git("add", "-A")
    gone.git("commit", "--quiet", "-m", "d")
    main.git("merge", "--quiet", "--squash", "gone")
    main.git("commit", "--quiet", "-m", "squash again")
    const { works } = open(() => [
      { terminalId: terminal(1), root: squashed.root },
      { terminalId: terminal(2), root: gone.root, base: "0".repeat(40) },
    ])
    resources.defer(() => works.close())
    const found = await current(works)
    expect(found.get(squashed.root)).toMatchObject({ files: [], merged: false })
    expect(found.get(gone.root)).toMatchObject({ files: [], merged: false })
  })

  it("names the files that conflict with main", async ({ fixture, resources }) => {
    const { main } = fixture
    const feature = fixture.worktree("feature")
    feature.write("a.txt", ten.replace("line 5\n", "feature five\n"))
    feature.write("b.txt", "b\nfeature\n")
    feature.git("commit", "--quiet", "-am", "feature")
    main.write("a.txt", ten.replace("line 5\n", "main five\n"))
    main.git("commit", "--quiet", "-am", "main moved")
    const { works } = open(() => [{ terminalId: terminal(1), root: feature.root }])
    resources.defer(() => works.close())
    const work = (await current(works)).get(feature.root)!
    expect(work.conflicts).toEqual([{ with: "main" }])
    expect(work.files.map((file) => [file.path, file.conflict])).toEqual([
      ["a.txt", true],
      ["b.txt", false],
    ])
  })

  it("flags the files two terminals' works conflict over, and only those two works", async ({
    fixture,
    resources,
  }) => {
    const first = fixture.worktree("first")
    const second = fixture.worktree("second")
    const third = fixture.worktree("third")
    first.write("a.txt", ten.replace("line 5\n", "first five\n"))
    second.write("a.txt", ten.replace("line 5\n", "second five\n"))
    second.write("b.txt", "second b\n")
    third.write("b.txt", "third b\n")
    third.write("a.txt", ten.replace("line 1\n", "third one\n"))
    const { works } = open(() => [
      { terminalId: terminal(1), root: first.root },
      { terminalId: terminal(2), root: second.root },
      { terminalId: terminal(3), root: third.root },
    ])
    resources.defer(() => works.close())
    const found = await current(works)
    expect(found.get(first.root)?.conflicts).toEqual([
      { with: "work", root: second.root, terminalId: terminal(2) },
    ])
    expect(found.get(second.root)?.conflicts).toEqual([
      { with: "work", root: first.root, terminalId: terminal(1) },
      { with: "work", root: third.root, terminalId: terminal(3) },
    ])
    expect(found.get(first.root)?.files.map((file) => file.conflict)).toEqual([true])
    expect(found.get(second.root)?.files.map((file) => [file.path, file.conflict])).toEqual([
      ["a.txt", true],
      ["b.txt", true],
    ])
    expect(found.get(third.root)?.conflicts).toEqual([
      { with: "work", root: second.root, terminalId: terminal(2) },
    ])
  })

  it("finds a conflict between a work that renamed a file and one that edited it", async ({
    fixture,
    resources,
  }) => {
    const first = fixture.worktree("first")
    const second = fixture.worktree("second")
    first.git("mv", "a.txt", "moved.txt")
    first.write("moved.txt", ten.replace("line 5\n", "first five\n"))
    second.write("a.txt", ten.replace("line 5\n", "second five\n"))
    const { works } = open(() => [
      { terminalId: terminal(1), root: first.root },
      { terminalId: terminal(2), root: second.root },
    ])
    resources.defer(() => works.close())
    const found = await current(works)
    expect(found.get(first.root)?.files.map(({ path }) => path)).toEqual(["moved.txt"])
    expect(found.get(first.root)?.conflicts).toEqual([
      { with: "work", root: second.root, terminalId: terminal(2) },
    ])
  })

  it("keeps an orphaned worktree's work when its owner goes, and the owner's when it is given", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    main.write("b.txt", "changed\n")
    const there: Where[] = [{ terminalId: terminal(1), root: main.root }]
    const { works } = open(() => there)
    resources.defer(() => works.close())
    expect((await current(works)).get(main.root)?.terminalId).toBe(terminal(1))
    there[0] = { terminalId: null, root: main.root }
    expect((await current(works)).get(main.root)).toMatchObject({ terminalId: null, added: 1 })
    there[0] = { terminalId: terminal(2), root: main.root }
    expect((await current(works)).get(main.root)).toMatchObject({ terminalId: terminal(2) })
  })

  it("tells later changes, and the removal of a work whose worktree is no longer tracked", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    const there: Where[] = [{ terminalId: terminal(1), root: main.root }]
    const { works } = open(() => there)
    resources.defer(() => works.close())
    const stop = new AbortController()
    const seen: string[] = []
    const done = (async () => {
      for await (const change of works.watch("owner", stop.signal))
        seen.push(change.type === "changed" ? `changed ${change.work.added}` : change.type)
    })()
    const until = async (text: string) => {
      const deadline = Date.now() + 5_000
      while (!seen.includes(text) && Date.now() < deadline)
        // eslint-disable-next-line no-await-in-loop -- Polls the stream's progress.
        await new Promise((resolve) => setTimeout(resolve, 20))
      expect(seen).toContain(text)
    }
    await until("synced")
    // Tracked, it is listed from the start, with nothing differing.
    main.write("b.txt", "b\nb2\n")
    await until("changed 1")
    main.write("b.txt", "b\nb2\nb3\nb4\n")
    await until("changed 3")
    there.length = 0
    await until("removed")
    stop.abort()
    await done
    expect(seen).toEqual(["changed 0", "synced", "changed 1", "changed 3", "removed"])
  })

  it("remembers when it first saw a work and what was read, across runs", async ({
    fixture,
    resources,
  }) => {
    const { main, holder } = fixture
    const memory = join(holder, "state", "works.json")
    main.write("b.txt", "one\n")
    const there = [{ terminalId: terminal(1), root: main.root }]
    const first = open(() => there, { memory })
    expect((await current(first.works)).get(main.root)?.unreadAdded).toBe(1)
    await first.works.look(main.root)
    const seenAt = (await current(first.works)).get(main.root)!.firstSeenAt
    // The save is not waited for; it is on disk soon.
    const deadline = Date.now() + 5_000
    while (!readableWatermark(memory) && Date.now() < deadline)
      // eslint-disable-next-line no-await-in-loop -- Polls the file.
      await new Promise((resolve) => setTimeout(resolve, 20))
    await first.works.close()
    const second = open(() => there, { memory })
    resources.defer(() => second.works.close())
    expect((await current(second.works)).get(main.root)).toMatchObject({
      firstSeenAt: seenAt,
      unreadAdded: 0,
    })
  })

  it("keeps its objects beside the memory, so what was read is still known after a restart", async ({
    fixture,
    resources,
  }) => {
    const { main, holder } = fixture
    const memory = join(holder, "state", "works.json")
    main.write("b.txt", "one\n")
    const there = [{ terminalId: terminal(1), root: main.root }]
    const first = open(() => there, { memory })
    await current(first.works)
    await first.works.look(main.root)
    await first.works.close()
    // The folder outlives the run, and the person's own objects were not written.
    expect(readdirSync(join(holder, "state", "works-objects"))).toHaveLength(1)
    main.write("b.txt", "one\ntwo\n")
    const second = open(() => there, { memory })
    resources.defer(() => second.works.close())
    expect((await current(second.works)).get(main.root)).toMatchObject({ unreadAdded: 1 })
  })

  it("rebuilds its object folder now and then, keeping the tree last read", async ({
    fixture,
    resources,
  }) => {
    const { main, holder } = fixture
    const memory = join(holder, "state", "works.json")
    main.write("b.txt", "one\n")
    const there = [{ terminalId: terminal(1), root: main.root }]
    const { works } = open(() => there, { memory, repackAfter: 3 })
    resources.defer(() => works.close())
    await current(works)
    await works.look(main.root)
    const folder = join(holder, "state", "works-objects")
    const count = (path: string): number =>
      readdirSync(path, { withFileTypes: true }).reduce(
        (sum, entry) => sum + (entry.isDirectory() ? count(join(path, entry.name)) : 1),
        0,
      )
    const sizes: number[] = []
    for (let at = 1; at <= 9; at += 1) {
      main.write("b.txt", `one\nedit ${at}\n`)
      // eslint-disable-next-line no-await-in-loop -- Each read follows its edit.
      await current(works)
      sizes.push(count(join(folder, readdirSync(folder)[0]!)))
    }

    // It does not grow with the reads, and the tree read is still known: only the edit is unread.
    expect(Math.max(...sizes)).toBeLessThan(sizes.length * 3)
    expect((await current(works)).get(main.root)).toMatchObject({ unreadAdded: 1 })
    expect(readdirSync(folder).toSorted()).toHaveLength(1)
  })

  it("does not take a merge it could not make for no conflict, and reads again", async ({
    fixture,
    resources,
  }) => {
    const first = fixture.worktree("first")
    const second = fixture.worktree("second")
    first.write("a.txt", ten.replace("line 5\n", "first five\n"))
    second.write("a.txt", ten.replace("line 5\n", "second five\n"))
    const memory = join(fixture.holder, "state", "works.json")
    const { works } = open(
      () => [
        { terminalId: terminal(1), root: first.root },
        { terminalId: terminal(2), root: second.root },
      ],
      { memory },
    )
    resources.defer(() => works.close())
    expect((await current(works)).get(first.root)?.conflicts).toHaveLength(1)
    // The objects of the snapshots go (as a rebuilt folder leaves them), and one side changes.
    rmSync(join(fixture.holder, "state", "works-objects"), { recursive: true, force: true })
    second.write("a.txt", ten.replace("line 5\n", "second five!\n"))
    await current(works)
    expect((await current(works)).get(first.root)?.conflicts).toEqual([
      { with: "work", root: second.root, terminalId: terminal(2) },
    ])
  })

  it("marks the work truncated when an untracked file over 1 MiB is left out", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    main.write("small.txt", "s\n")
    main.write("big.bin", "x".repeat(1024 * 1024 + 1))
    const { works } = open(() => [{ terminalId: terminal(1), root: main.root }])
    resources.defer(() => works.close())
    const work = (await current(works)).get(main.root)!
    expect(work.files.map((file) => file.path)).toEqual(["small.txt"])
    expect(work.truncated).toBe(true)
  })

  // Windows can't hold a ref this long: its file path passes the system's limit.
  it.skipIf(process.platform === "win32")(
    "keeps a branch name within the protocol's limit",
    async ({ fixture, resources }) => {
      const { main } = fixture
      main.git(
        "checkout",
        "--quiet",
        "-b",
        `${"a".repeat(120)}/${"b".repeat(120)}/${"c".repeat(60)}`,
      )
      main.write("b.txt", "changed\n")
      const { works } = open(() => [{ terminalId: terminal(1), root: main.root }])
      resources.defer(() => works.close())
      const work = (await current(works)).get(main.root)!
      expect(work.branch).toHaveLength(256)
    },
  )

  it("stops following a file that became ignored", async ({ fixture, resources }) => {
    const { main } = fixture
    main.write("scratch.log", "x\n")
    const { works } = open(() => [{ terminalId: terminal(1), root: main.root }])
    resources.defer(() => works.close())
    expect((await current(works)).get(main.root)?.files.map((file) => file.path)).toEqual([
      "scratch.log",
    ])
    main.write(".git/info/exclude", "*.log\n")
    expect((await current(works)).get(main.root)?.files).toEqual([])
  })

  it("shows a work's worktree through its owner's bar, or the bar asked for when it has no owner", async ({
    fixture,
    resources,
  }) => {
    const owned = fixture.worktree("owned")
    const orphan = fixture.worktree("orphan")
    const { works, shown } = open(() => [
      { terminalId: terminal(1), root: owned.root },
      { terminalId: null, root: orphan.root },
    ])
    resources.defer(() => works.close())
    expect(await works.show(owned.root, terminal(9))).toEqual({ itemId: "item" })
    expect(shown).toEqual([[terminal(1), owned.root]])
    expect(await works.show(orphan.root, terminal(2))).toEqual({ itemId: "item" })
    expect(shown.at(-1)).toEqual([terminal(2), orphan.root])
    await expect(works.show(orphan.root)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(works.show(join(fixture.holder, "nowhere"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(works.look(join(fixture.holder, "nowhere"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  describe("closing a work", () => {
    it("closes the worktree for the person, forgetting what it remembered of it", async ({
      fixture,
      resources,
    }) => {
      const { holder } = fixture
      const memory = join(holder, "state", "works.json")
      const gone = fixture.worktree("gone")
      const stay = fixture.worktree("stay")
      gone.write("b.txt", "gone\n")
      stay.write("b.txt", "stay\n")
      const rows: Where[] = [
        { terminalId: terminal(1), root: gone.root },
        { terminalId: terminal(1), root: stay.root },
      ]
      const removed: [string, boolean][] = []
      const { works } = open(() => rows, {
        memory,
        // The service removes the row; the work follows at once.
        remove: async (root, force) => {
          removed.push([root, force])
          rows.splice(
            rows.findIndex((each) => each.root === root),
            1,
          )
          return { ok: true, kept: "refs/novadeck/kept/gone", branchDeleted: true }
        },
      })
      resources.defer(() => works.close())
      await current(works)
      await works.markRead(gone.root, "b.txt", "1".repeat(40))
      expect(await works.closeWork(gone.root, true)).toEqual({
        closed: true,
        kept: "refs/novadeck/kept/gone",
        branchDeleted: true,
      })
      expect(removed).toEqual([[gone.root, true]])
      expect([...(await current(works)).keys()]).toEqual([stay.root])
      expect([...works.marks(gone.root).keys()]).toEqual([])
    })

    it("answers what a worktree holds when unforced, for the person to confirm, and closes on force", async ({
      fixture,
      resources,
    }) => {
      const dirty = fixture.worktree("dirty")
      dirty.write("b.txt", "dirty\n")
      const asked: boolean[] = []
      const { works } = open(() => [{ terminalId: terminal(1), root: dirty.root }], {
        remove: async (_root, force) => {
          asked.push(force)
          return force
            ? { ok: true, branchDeleted: false }
            : {
                ok: false,
                holds: "1 uncommitted or untracked path",
                reason: "agent-facing: call close_worktree with force",
              }
        },
      })
      resources.defer(() => works.close())
      expect(await works.closeWork(dirty.root, false)).toEqual({
        closed: false,
        holds: "1 uncommitted or untracked path",
      })
      // Nothing was closed: the work is still there.
      expect((await current(works)).has(dirty.root)).toBe(true)
      expect(await works.closeWork(dirty.root, true)).toEqual({
        closed: true,
        branchDeleted: false,
      })
      expect(asked).toEqual([false, true])
    })

    it("refuses as a CONFLICT with the service's reason where force would not help", async ({
      fixture,
      resources,
    }) => {
      const dirty = fixture.worktree("dirty")
      dirty.write("b.txt", "dirty\n")
      const { works } = open(() => [{ terminalId: terminal(1), root: dirty.root }], {
        remove: async () => ({
          ok: false,
          reason: "Novadeck couldn't read its status, so it stays.",
        }),
      })
      resources.defer(() => works.close())
      for (const force of [false, true])
        // eslint-disable-next-line no-await-in-loop -- One after the other.
        await expect(works.closeWork(dirty.root, force)).rejects.toMatchObject({
          code: "CONFLICT",
          message: "Novadeck couldn't read its status, so it stays.",
        })
      expect((await current(works)).has(dirty.root)).toBe(true)
    })

    it("forgets a worktree's memory when it stops being tracked by any means, such as an agent's close", async ({
      fixture,
      resources,
    }) => {
      const memory = join(fixture.holder, "state", "works.json")
      const a = fixture.worktree("a")
      const b = fixture.worktree("b")
      a.write("b.txt", "a\n")
      b.write("b.txt", "b2\n")
      const rows: Where[] = [
        { terminalId: terminal(1), root: a.root },
        { terminalId: terminal(1), root: b.root },
      ]
      const { works } = open(() => rows, { memory })
      resources.defer(() => works.close())
      await current(works)
      await works.markRead(a.root, "b.txt", "1".repeat(40))
      await works.markRead(b.root, "b.txt", "2".repeat(40))
      // An agent's close_worktree drops the row without going through the panel.
      rows.shift()
      await current(works)
      expect([...works.marks(a.root).keys()]).toEqual([])
      expect([...works.marks(b.root).keys()]).toEqual(["b.txt"])
    })

    it("keeps the marks of a plain checkout a terminal works in, however many others are forgotten", async ({
      fixture,
      resources,
    }) => {
      const memory = join(fixture.holder, "state", "works.json")
      const { works } = open(() => [], {
        memory,
        plain: [{ terminalId: terminal(1), root: fixture.main.root }],
      })
      resources.defer(() => works.close())
      await works.markRead(fixture.main.root, "b.txt", "1".repeat(40))
      // Others, newer, fill the cap of remembered abandoned checkouts (32).
      for (let at = 0; at < 40; at += 1)
        // eslint-disable-next-line no-await-in-loop -- Each mark follows the one before.
        await works.markRead(`/elsewhere/${at}`, "b.txt", "2".repeat(40))
      await current(works)
      expect([...works.marks(fixture.main.root).keys()]).toEqual(["b.txt"])
    })

    it("shows a work on the bar asked for when its owner has none, and says so when that fails too", async ({
      fixture,
      resources,
    }) => {
      const owned = fixture.worktree("owned")
      const shown: string[] = []
      const { works } = open(() => [{ terminalId: terminal(1), root: owned.root }], {
        show: async (terminalId) => {
          shown.push(terminalId)
          if (terminalId === terminal(1)) throw new DomainError("TERMINAL_NOT_FOUND")
          return "item"
        },
      })
      resources.defer(() => works.close())
      expect(await works.show(owned.root, terminal(2))).toEqual({ itemId: "item" })
      expect(shown).toEqual([terminal(1), terminal(2)])
      await expect(works.show(owned.root)).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    })

    it("refuses while the owner's agent is working in it, and for a root with no work", async ({
      fixture,
      resources,
    }) => {
      const busy = fixture.worktree("busy")
      busy.write("b.txt", "busy\n")
      const { works, removed } = open(() => [
        { terminalId: terminal(1), root: busy.root, working: true },
      ])
      resources.defer(() => works.close())
      await expect(works.closeWork(busy.root, true)).rejects.toMatchObject({ code: "CONFLICT" })
      await expect(works.closeWork(join(fixture.holder, "nowhere"), true)).rejects.toMatchObject({
        code: "NOT_FOUND",
      })
      expect(removed).toEqual([])
    })
  })
})

const readableWatermark = (path: string): boolean => {
  try {
    return /"watermark":"[0-9a-f]{40,}"/.test(readFileSync(path, "utf8"))
  } catch {
    return false
  }
}
