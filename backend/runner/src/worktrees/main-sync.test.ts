import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { gitIn, withOrigin, type Origin } from "../testing/origin.js"
import { MainFetcher } from "./fetching.js"
import { dependenciesOf, mergeOf } from "./landing.js"
import { mainNotice } from "./main-notice.js"
import { MainSync, type Landed } from "./main-sync.js"
import { repositoriesIn } from "./repositories-in.js"

type Setup = {
  origin: Origin
  fetcher: MainFetcher
  sync: MainSync
  common: string
  told: Landed[]
  own: { number: number; title: string }[]
  /** Fetches origin and lets the runner follow it, then waits for the landing to be recorded. */
  follow: () => Promise<void>
}

const it = base.extend<{ setup: Setup }>({
  setup: async ({ resources }, use) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    const told: Landed[] = []
    const own: { number: number; title: string }[] = []
    const common = join(origin.repo, ".git")
    let sync: MainSync | undefined
    const fetcher = new MainFetcher({
      environment: {},
      landed: (dir, from, to) => void sync?.landed(dir, from, to),
    })
    resources.defer(() => fetcher.abort())
    sync = new MainSync({
      projects: () => [{ id: "p", cwd: origin.repo }],
      moved: (dir) => fetcher.moved(dir),
      update: (dir) => fetcher.update(dir),
      own: () => own,
      landed: (landed) => told.push(landed),
    })
    const follow = async (): Promise<void> => {
      await fetcher.fetchNow([common])
      await fetcher.idle()
      await sync.idle()
    }
    await use({ origin, fetcher, sync, common, told, own, follow })
  },
})

describe("the repositories of a project", () => {
  it("finds the one the folder is in and those nested under it, not the ones that aren't", async ({
    resources,
  }) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-repos-")))
    resources.defer(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
    const init = (...parts: string[]): string => {
      const folder = join(root, ...parts)
      mkdirSync(folder, { recursive: true })
      gitIn(folder, "init", "--quiet", "-b", "main")
      return folder
    }
    init("source", "novadeck")
    init("source", "site")
    init("a", "b", "c", "deep")
    init("a", "b", "c", "d", "too-deep")
    init("node_modules", "dep")
    init(".hidden", "repo")
    // A repository's own folders are not searched for more.
    mkdirSync(join(root, "source", "novadeck", "packages", "x"), { recursive: true })
    init("source", "novadeck", "inside")
    expect((await repositoriesIn(root)).map(({ path, name }) => [path, name])).toEqual([
      ["a/b/c/deep", "deep"],
      ["source/novadeck", "novadeck"],
      ["source/site", "site"],
    ])
  })

  it("puts the repository the folder is in first, with an empty path", async ({ resources }) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-repos-")))
    resources.defer(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
    gitIn(root, "init", "--quiet", "-b", "main")
    mkdirSync(join(root, "docs", "guide"), { recursive: true })
    mkdirSync(join(root, "vendor-clone"), { recursive: true })
    gitIn(join(root, "vendor-clone"), "init", "--quiet", "-b", "main")
    const inside = (await repositoriesIn(join(root, "docs", "guide"))).map(({ path }) => path)
    expect(inside).toEqual([""])
    const top = await repositoriesIn(root)
    expect(top.map(({ path }) => path)).toEqual(["", "vendor-clone"])
  })

  it("finds none in a folder with no repository, or that is not there", async ({ resources }) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-repos-")))
    resources.defer(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
    expect(await repositoriesIn(root)).toEqual([])
    expect(await repositoriesIn(join(root, "gone"))).toEqual([])
  })
})

describe("what main's move brought", () => {
  it("reads a pull request's number from either kind of merge", () => {
    expect(mergeOf("a", "Fix the thing (#123)", "")).toEqual({
      commit: "a",
      pr: 123,
      subject: "Fix the thing",
    })
    expect(mergeOf("b", "Merge pull request #7 from me/branch", "\nAdd a cart\n")).toEqual({
      commit: "b",
      pr: 7,
      subject: "Add a cart",
    })
    expect(mergeOf("c", "A plain commit", "")).toEqual({
      commit: "c",
      pr: null,
      subject: "A plain commit",
    })
  })

  it("names the command of the lockfile that changed, the nearest one to the top", () => {
    expect(dependenciesOf(["src/a.ts"])).toBeNull()
    expect(dependenciesOf(["pnpm-lock.yaml", "src/a.ts"])).toEqual({
      file: "pnpm-lock.yaml",
      command: "pnpm install",
    })
    expect(dependenciesOf(["tools/Cargo.lock", "bun.lockb"])).toEqual({
      file: "bun.lockb",
      command: "bun install",
    })
    for (const [file, command] of [
      ["package-lock.json", "npm install"],
      ["yarn.lock", "yarn install"],
      ["bun.lock", "bun install"],
      ["Cargo.lock", "cargo build"],
      ["uv.lock", "uv sync"],
      ["poetry.lock", "poetry install"],
      ["go.sum", "go mod download"],
      ["Gemfile.lock", "bundle install"],
    ] as const)
      expect(dependenciesOf([`x/${file}`])).toEqual({ file: `x/${file}`, command })
  })

  it("records the merges, files and dependency hint of a move the runner made", async ({
    setup: s,
  }) => {
    s.own.push({ number: 12, title: "Add a cart" })
    s.origin.land("b.txt", "Add a cart (#12)")
    const last = s.origin.land("pnpm-lock.yaml", "Update dependencies (#13)")
    await s.follow()
    const [repo] = (await s.sync.sync(s.origin.repo)).repos
    expect(repo).toMatchObject({
      path: "",
      name: "api",
      branch: "main",
      behind: null,
      ahead: 0,
      moved: 1,
      head: last,
    })
    expect(repo?.landing).toMatchObject({
      to: last,
      commits: 2,
      merges: [
        { subject: "Update dependencies", pr: 13, own: false },
        { subject: "Add a cart", pr: 12, own: true },
      ],
      files: ["b.txt", "pnpm-lock.yaml"],
      filesTotal: 2,
      dependencies: { file: "pnpm-lock.yaml", command: "pnpm install" },
    })
    expect(s.told).toHaveLength(1)
    expect(s.told[0]?.own).toEqual([{ number: 12, title: "Add a cart" }])
  })

  it("joins a second move to the first the person has not seen, and tells only of the second", async ({
    setup: s,
  }) => {
    s.origin.land("b.txt", "One (#1)")
    await s.follow()
    s.origin.land("c.txt", "Two (#2)")
    await s.follow()
    const [repo] = (await s.sync.sync(s.origin.repo)).repos
    expect(repo?.landing?.merges.map(({ pr }) => pr)).toEqual([2, 1])
    expect(repo?.landing?.files).toEqual(["b.txt", "c.txt"])
    expect(s.told.map(({ landing }) => landing.commits)).toEqual([1, 1])
  })

  it("forgets a landing once it is seen, and keeps a newer one than the one seen", async ({
    setup: s,
  }) => {
    const first = s.origin.land("b.txt", "One (#1)")
    await s.follow()
    s.origin.land("c.txt", "Two (#2)")
    await s.follow()
    await s.sync.seen(s.origin.repo, "", first)
    expect((await s.sync.sync(s.origin.repo)).repos[0]?.landing).not.toBeNull()
    await s.sync.seen(s.origin.repo, "")
    expect((await s.sync.sync(s.origin.repo)).repos[0]?.landing).toBeNull()
  })

  it("is not told of an update the person asked for", async ({ setup: s }) => {
    writeFileSync(join(s.origin.repo, "a.txt"), "mine\n")
    s.origin.land("b.txt", "One (#1)")
    await s.fetcher.fetchNow([s.common])
    await s.fetcher.idle()
    expect(await s.sync.update(s.origin.repo)).toEqual({ ok: true })
    await s.sync.idle()
    expect(s.told).toEqual([])
    expect((await s.sync.sync(s.origin.repo)).repos[0]).toMatchObject({
      behind: null,
      landing: null,
      moved: 1,
    })
  })
})

describe("how far a repository is from origin", () => {
  it("counts the commits main has that origin lacks", async ({ setup: s }) => {
    writeFileSync(join(s.origin.repo, "mine.txt"), "mine\n")
    gitIn(s.origin.repo, "add", "-A")
    gitIn(s.origin.repo, "commit", "--quiet", "-m", "local")
    gitIn(s.origin.repo, "commit", "--quiet", "--allow-empty", "-m", "local again")
    expect((await s.sync.sync(s.origin.repo)).repos[0]).toMatchObject({ ahead: 2, behind: null })
  })

  it("says why main was left behind: edits in a file git would overwrite, and refuses an update of it", async ({
    setup: s,
  }) => {
    writeFileSync(join(s.origin.repo, "a.txt"), "mine\n")
    s.origin.land("a.txt", "Rewrite a (#4)")
    await s.follow()
    const [repo] = (await s.sync.sync(s.origin.repo)).repos
    expect(repo?.behind).toEqual({
      remote: "origin/main",
      count: 1,
      why: "You have edits in a.txt",
      merges: [{ subject: "Rewrite a", pr: 4, commit: expect.any(String), own: false }],
    })
    expect(repo?.landing).toBeNull()
    const refused = await s.sync.update(s.origin.repo, "")
    expect(refused).toMatchObject({ ok: false })
  })

  it("says it was not fetched into main yet when nothing held it back", async ({ setup: s }) => {
    s.origin.land("b.txt")
    s.origin.fetch()
    expect((await s.sync.sync(s.origin.repo)).repos[0]?.behind).toEqual({
      remote: "origin/main",
      count: 1,
      why: null,
      merges: [{ subject: "add b.txt", pr: null, commit: expect.any(String), own: false }],
    })
  })

  it("says an operation in progress held it back", async ({ setup: s }) => {
    s.origin.land("b.txt")
    s.origin.fetch()
    writeFileSync(
      join(s.origin.repo, ".git", "MERGE_HEAD"),
      `${gitIn(s.origin.repo, "rev-parse", "HEAD")}\n`,
    )
    expect((await s.sync.sync(s.origin.repo)).repos[0]?.behind?.why).toBe("A merge is in progress.")
  })

  it("refuses to move a main that has commits of its own and is behind too", async ({
    setup: s,
  }) => {
    writeFileSync(join(s.origin.repo, "mine.txt"), "mine\n")
    gitIn(s.origin.repo, "add", "-A")
    gitIn(s.origin.repo, "commit", "--quiet", "-m", "local")
    s.origin.land("b.txt")
    s.origin.fetch()
    const [repo] = (await s.sync.sync(s.origin.repo)).repos
    expect(repo).toMatchObject({ ahead: 1, behind: { count: 1 } })
    expect(await s.sync.update(s.origin.repo)).toMatchObject({ ok: false })
  })

  it("serves a project whose folder is no repository, and updates a nested one by its path", async ({
    setup: s,
  }) => {
    const sync = new MainSync({
      projects: () => [{ id: "p", cwd: join(s.origin.repo, "..") }],
      moved: (dir) => s.fetcher.moved(dir),
      update: (dir) => s.fetcher.update(dir),
    })
    s.origin.land("b.txt")
    s.origin.fetch()
    const { repos } = await sync.sync(join(s.origin.repo, ".."))
    const api = repos.find(({ name }) => name === "api")
    expect(api).toMatchObject({ path: "api", behind: { count: 1 } })
    expect(await sync.update(join(s.origin.repo, ".."), "api")).toEqual({ ok: true })
    expect(
      (await sync.sync(join(s.origin.repo, ".."))).repos.find(({ name }) => name === "api"),
    ).toMatchObject({
      behind: null,
    })
    expect(await sync.update(join(s.origin.repo, ".."), "nowhere")).toMatchObject({ ok: false })
    expect(await sync.followed()).toContain(s.common)
  })
})

describe("the notice an agent in the checkout gets", () => {
  it("states the facts and asks for nothing", () => {
    const text = mainNotice("api", {
      from: "a",
      to: "b",
      at: 0,
      commits: 3,
      merges: [],
      files: ["src/a.ts", "pnpm-lock.yaml"],
      filesTotal: 2,
      dependencies: { file: "pnpm-lock.yaml", command: "pnpm install" },
    })
    expect(text).toBe(
      [
        "Novadeck · Main",
        "main in api moved 3 commits from origin; 2 files changed.",
        "  src/a.ts",
        "  pnpm-lock.yaml",
        "  pnpm-lock.yaml is among them",
      ].join("\n"),
    )
    expect(text).not.toContain("→")
  })
})
