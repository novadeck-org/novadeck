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
import { describe, expect, it as base } from "../test.js"
import { Works, type Placement } from "./works.js"

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

type Where = { readonly terminalId: string; readonly root: string }

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

// A Works over the terminals `where` names, read as fast as the test needs.
const open = (
  where: () => readonly Where[],
  options: { memory?: string; repackAfter?: number } = {},
) => {
  const shown: [string, string][] = []
  const works = new Works({
    placements: async () =>
      where().map(({ terminalId, root }): Placement => ({ terminalId, projectId: project, root })),
    show: async (terminalId, root) => {
      shown.push([terminalId, root])
      return "item"
    },
    everyMs: 20,
    snapshots: snapshotsFor(options.memory, options.repackAfter),
    ...(options.memory !== undefined && { memory: options.memory }),
  })
  return { works, shown }
}

// What the works are as of now, by terminal: a watch's first sequence, read afresh.
const current = async (works: Works): Promise<Map<string, Work>> => {
  const stop = new AbortController()
  const found = new Map<string, Work>()
  try {
    for await (const change of works.watch("owner", stop.signal)) {
      if (change.type === "synced") break
      if (change.type === "changed") found.set(change.work.terminalId, change.work)
    }
  } finally {
    stop.abort()
  }
  return found
}

describe.skipIf(!hasGit)("the works of terminals in git checkouts", () => {
  it("has none for a checkout identical to main", async ({ fixture, resources }) => {
    const { works } = open(() => [{ terminalId: terminal(1), root: fixture.main.root }])
    resources.defer(() => works.close())
    expect([...(await current(works))]).toEqual([])
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
    const work = (await current(works)).get(terminal(1))!
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
    const work = (await current(works)).get(terminal(1))!
    expect(work.files.map(({ path, added, removed }) => [path, added, removed])).toEqual([
      ["moved.txt", 1, 1],
    ])
    expect([work.added, work.removed]).toEqual([1, 1])
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
    const work = (await current(works)).get(terminal(1))!
    expect(work.base).toBe("origin/trunk")
    expect(work.files.map((file) => file.path)).toEqual(["a.txt"])
  })

  it("falls back to master when there is no main", async ({ fixture, resources }) => {
    const { main } = fixture
    main.git("branch", "-m", "main", "master")
    main.write("b.txt", "b\nb2\n")
    const { works } = open(() => [{ terminalId: terminal(1), root: main.root }])
    resources.defer(() => works.close())
    expect((await current(works)).get(terminal(1))?.base).toBe("master")
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
    expect((await current(works)).get(terminal(1))).toMatchObject({
      unreadAdded: 1,
      unreadRemoved: 1,
    })
    await works.look(terminal(1))
    expect((await current(works)).get(terminal(1))).toMatchObject({
      added: 1,
      removed: 1,
      unreadAdded: 0,
      unreadRemoved: 0,
    })
    main.write("a.txt", ten.replace("line 2\n", "two\n").replace("line 9\n", "nine\nnine+\n"))
    const after = (await current(works)).get(terminal(1))!
    expect(after).toMatchObject({ added: 3, removed: 2, unreadAdded: 2, unreadRemoved: 1 })
    expect(after.files[0]).toMatchObject({ unreadAdded: 2, unreadRemoved: 1 })
  })

  it("keeps when it first saw the work until the work is gone", async ({ fixture, resources }) => {
    const { main } = fixture
    let now = 1_000
    main.write("b.txt", "x\n")
    const works = new Works({
      placements: async () => [{ terminalId: terminal(1), projectId: project, root: main.root }],
      show: async () => "item",
      now: () => now,
      snapshots: snapshotsFor(),
    })
    resources.defer(() => works.close())
    expect((await current(works)).get(terminal(1))?.firstSeenAt).toBe(1_000)
    now = 5_000
    main.write("b.txt", "y\n")
    expect((await current(works)).get(terminal(1))?.firstSeenAt).toBe(1_000)
    main.git("checkout", "--", "b.txt")
    expect((await current(works)).size).toBe(0)
    now = 9_000
    main.write("b.txt", "z\n")
    expect((await current(works)).get(terminal(1))?.firstSeenAt).toBe(9_000)
  })

  it("ends when the branch is merged into main, or squashed into it", async ({
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
    expect([...(await current(works)).keys()].toSorted()).toEqual([terminal(1), terminal(2)])
    main.git("merge", "--quiet", "--no-ff", "-m", "merge", "feature")
    main.git("merge", "--quiet", "--squash", "squashed")
    main.git("commit", "--quiet", "-m", "squash")
    expect((await current(works)).size).toBe(0)
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
    const work = (await current(works)).get(terminal(1))!
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
    expect(found.get(terminal(1))?.conflicts).toEqual([{ with: "work", terminalId: terminal(2) }])
    expect(found.get(terminal(2))?.conflicts).toEqual([
      { with: "work", terminalId: terminal(1) },
      { with: "work", terminalId: terminal(3) },
    ])
    expect(found.get(terminal(1))?.files.map((file) => file.conflict)).toEqual([true])
    expect(found.get(terminal(2))?.files.map((file) => [file.path, file.conflict])).toEqual([
      ["a.txt", true],
      ["b.txt", true],
    ])
    expect(found.get(terminal(3))?.conflicts).toEqual([{ with: "work", terminalId: terminal(2) }])
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
    expect(found.get(terminal(1))?.files.map(({ path }) => path)).toEqual(["moved.txt"])
    expect(found.get(terminal(1))?.conflicts).toEqual([{ with: "work", terminalId: terminal(2) }])
  })

  it("gives a checkout shared by several terminals to the one that was there first", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    main.write("b.txt", "changed\n")
    let now = 100
    const there = [{ terminalId: terminal(2), root: main.root }]
    const works = new Works({
      placements: async () =>
        there.map(({ terminalId, root }) => ({ terminalId, projectId: project, root })),
      show: async () => "item",
      now: () => now,
      snapshots: snapshotsFor(),
    })
    resources.defer(() => works.close())
    expect([...(await current(works)).keys()]).toEqual([terminal(2)])
    now = 200
    there.unshift({ terminalId: terminal(1), root: main.root })
    expect([...(await current(works)).keys()]).toEqual([terminal(2)])
    there.shift()
    expect([...(await current(works)).keys()]).toEqual([terminal(2)])
  })

  it("tells later changes, and the removal of a work whose terminal closed", async ({
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
    main.write("b.txt", "b\nb2\n")
    await until("changed 1")
    main.write("b.txt", "b\nb2\nb3\nb4\n")
    await until("changed 3")
    there.length = 0
    await until("removed")
    stop.abort()
    await done
    expect(seen).toEqual(["synced", "changed 1", "changed 3", "removed"])
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
    expect((await current(first.works)).get(terminal(1))?.unreadAdded).toBe(1)
    await first.works.look(terminal(1))
    const seenAt = (await current(first.works)).get(terminal(1))!.firstSeenAt
    // The save is not waited for; it is on disk soon.
    const deadline = Date.now() + 5_000
    while (!readableWatermark(memory) && Date.now() < deadline)
      // eslint-disable-next-line no-await-in-loop -- Polls the file.
      await new Promise((resolve) => setTimeout(resolve, 20))
    await first.works.close()
    const second = open(() => there, { memory })
    resources.defer(() => second.works.close())
    expect((await current(second.works)).get(terminal(1))).toMatchObject({
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
    await first.works.look(terminal(1))
    await first.works.close()
    // The folder outlives the run, and the person's own objects were not written.
    expect(readdirSync(join(holder, "state", "works-objects"))).toHaveLength(1)
    main.write("b.txt", "one\ntwo\n")
    const second = open(() => there, { memory })
    resources.defer(() => second.works.close())
    expect((await current(second.works)).get(terminal(1))).toMatchObject({ unreadAdded: 1 })
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
    await works.look(terminal(1))
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
    expect((await current(works)).get(terminal(1))).toMatchObject({ unreadAdded: 1 })
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
    expect((await current(works)).get(terminal(1))?.conflicts).toHaveLength(1)
    // The objects of the snapshots go (as a rebuilt folder leaves them), and one side changes.
    rmSync(join(fixture.holder, "state", "works-objects"), { recursive: true, force: true })
    second.write("a.txt", ten.replace("line 5\n", "second five!\n"))
    await current(works)
    expect((await current(works)).get(terminal(1))?.conflicts).toEqual([
      { with: "work", terminalId: terminal(2) },
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
    const work = (await current(works)).get(terminal(1))!
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
      const work = (await current(works)).get(terminal(1))!
      expect(work.branch).toHaveLength(256)
    },
  )

  it("stops following a file that became ignored", async ({ fixture, resources }) => {
    const { main } = fixture
    main.write("scratch.log", "x\n")
    const { works } = open(() => [{ terminalId: terminal(1), root: main.root }])
    resources.defer(() => works.close())
    expect((await current(works)).get(terminal(1))?.files.map((file) => file.path)).toEqual([
      "scratch.log",
    ])
    main.write(".git/info/exclude", "*.log\n")
    expect((await current(works)).size).toBe(0)
  })

  it("shows a work's checkout through the terminal's bar, and has nothing to show without a work", async ({
    fixture,
    resources,
  }) => {
    const { main } = fixture
    main.write("b.txt", "changed\n")
    const idle = fixture.worktree("idle")
    const { works, shown } = open(() => [
      { terminalId: terminal(1), root: main.root },
      { terminalId: terminal(2), root: idle.root },
    ])
    resources.defer(() => works.close())
    expect(await works.show(terminal(1))).toEqual({ itemId: "item" })
    expect(shown).toEqual([[terminal(1), main.root]])
    await expect(works.show(terminal(2))).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(works.look(terminal(2))).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

const readableWatermark = (path: string): boolean => {
  try {
    return /"watermark":"[0-9a-f]{40,}"/.test(readFileSync(path, "utf8"))
  } catch {
    return false
  }
}
