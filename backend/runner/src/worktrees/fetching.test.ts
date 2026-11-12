import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { git as realGit, Run } from "../checkouts/git.js"
import { describe, expect, it as base } from "../test.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { fetchEnv, fetchEveryMs, fetchTimeoutMs, MainFetcher } from "./fetching.js"
import { Worktrees } from "./worktrees.js"

const minute = 60_000

type Call = {
  cwd: string
  args: readonly string[]
  env: NodeJS.ProcessEnv | undefined
  ms?: number
}

// A fake git that records what it is asked, answers a failing fetch where `failing` says so.
const fake = (options: { failing?: (cwd: string) => boolean; sshCommand?: string } = {}) => {
  const calls: Call[] = []
  let running = 0
  let most = 0
  const run: typeof realGit = async (cwd, args, limit) => {
    calls.push({ cwd, args, env: limit.env, ...(limit.ms !== undefined && { ms: limit.ms }) })
    if (args[0] === "config")
      return options.sshCommand
        ? { ok: true, out: `${options.sshCommand}\n`, cut: false }
        : { ok: false, kind: "exit", status: 1, said: "" }
    running += 1
    most = Math.max(most, running)
    await new Promise((resolve) => setImmediate(resolve))
    running -= 1
    return options.failing?.(cwd)
      ? ({ ok: false, kind: "exit", status: 128, said: "could not read from remote" } satisfies Run)
      : { ok: true, out: "", cut: false }
  }
  return {
    run,
    fetches: () => calls.filter(({ args }) => args[0] === "fetch"),
    calls,
    most: () => most,
  }
}

describe("fetching origins", () => {
  it("fetches a repository at most every five minutes", async () => {
    const git = fake()
    let now = 1_000_000
    const fetcher = new MainFetcher({ now: () => now, run: git.run, environment: {} })
    const repos = ["/r/api/.git"]
    await fetcher.fetchDue(repos)
    expect(git.fetches()).toHaveLength(1)
    expect(fetcher.fetchedAt("/r/api/.git")).toBe(now)
    now += 4 * minute
    await fetcher.fetchDue(repos)
    expect(git.fetches()).toHaveLength(1)
    now += 1 * minute
    await fetcher.fetchDue(repos)
    expect(git.fetches()).toHaveLength(2)
    expect(fetcher.fetchedAt("/r/api/.git")).toBe(now)
    expect(fetchEveryMs).toBe(5 * minute)
  })

  it("runs in the repository's folder with a timeout, pruning and no tags", async () => {
    const git = fake()
    const fetcher = new MainFetcher({ run: git.run, environment: {} })
    await fetcher.fetchDue(["/r/api/.git"])
    expect(git.fetches()[0]).toMatchObject({
      cwd: "/r/api",
      args: ["fetch", "--quiet", "--no-tags", "--prune", "origin"],
      ms: fetchTimeoutMs,
    })
    expect(fetchTimeoutMs).toBe(60_000)
  })

  it("fetches one repository at a time, each once", async () => {
    const git = fake()
    const fetcher = new MainFetcher({ run: git.run, environment: {} })
    await Promise.all([fetcher.fetchDue(["/a/.git", "/b/.git", "/c/.git"]), Promise.resolve()])
    expect(git.fetches().map(({ cwd }) => cwd)).toEqual(["/a", "/b", "/c"])
    expect(git.most()).toBe(1)
  })

  it("ignores a failure, keeps no time for it, and waits longer each time", async () => {
    const git = fake({ failing: (cwd) => cwd === "/off" })
    let now = 0
    const fetcher = new MainFetcher({ now: () => now, run: git.run, environment: {} })
    const repos = ["/off/.git", "/on/.git"]
    await fetcher.fetchDue(repos)
    expect(fetcher.fetchedAt("/off/.git")).toBeUndefined()
    expect(fetcher.fetchedAt("/on/.git")).toBe(0)
    // Backed off: 10 minutes after the first failure, 20 after the second.
    now = 9 * minute
    await fetcher.fetchDue(repos)
    expect(git.fetches().filter(({ cwd }) => cwd === "/off")).toHaveLength(1)
    now = 10 * minute
    await fetcher.fetchDue(repos)
    expect(git.fetches().filter(({ cwd }) => cwd === "/off")).toHaveLength(2)
    now = 29 * minute
    await fetcher.fetchDue(repos)
    expect(git.fetches().filter(({ cwd }) => cwd === "/off")).toHaveLength(2)
    now = 30 * minute
    await fetcher.fetchDue(repos)
    expect(git.fetches().filter(({ cwd }) => cwd === "/off")).toHaveLength(3)
  })

  it("can never ask for a credential", async () => {
    const git = fake()
    const fetcher = new MainFetcher({ run: git.run, environment: {} })
    await fetcher.fetchDue(["/a/.git"])
    expect(git.fetches()[0]?.env).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GCM_INTERACTIVE: "never",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    })
  })

  it("keeps the person's own ssh command, from the environment or git's config", async () => {
    expect(fetchEnv({ GIT_SSH_COMMAND: "ssh -i key" }, false)).not.toHaveProperty("GIT_SSH_COMMAND")
    const git = fake({ sshCommand: "ssh -i ~/.ssh/work" })
    await new MainFetcher({ run: git.run, environment: {} }).fetchDue(["/a/.git"])
    expect(git.fetches()[0]?.env).not.toHaveProperty("GIT_SSH_COMMAND")
    expect(git.fetches()[0]?.env).toMatchObject({ GIT_ASKPASS: "", SSH_ASKPASS: "" })
  })

  it("forgets a repository no longer tracked", async () => {
    const git = fake()
    const fetcher = new MainFetcher({ run: git.run, environment: {} })
    await fetcher.fetchDue(["/a/.git"])
    await fetcher.fetchDue([])
    expect(fetcher.fetchedAt("/a/.git")).toBeUndefined()
  })
})

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  }).trim()

type Fixture = { origin: string; clone: string; other: string; root: string }

const it = base.extend<{ fx: Fixture }>({
  fx: async ({ resources }, use) => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-fetch-")))
    resources.defer(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5 }))
    const origin = join(folder, "origin.git")
    mkdirSync(origin)
    sh(origin, "init", "--quiet", "--bare", "-b", "main")
    const clone = join(folder, "api")
    sh(folder, "clone", "--quiet", origin, clone)
    writeFileSync(join(clone, "a.txt"), "a\n")
    sh(clone, "add", "-A")
    sh(clone, "commit", "--quiet", "-m", "first")
    sh(clone, "push", "--quiet", "-u", "origin", "main")
    sh(clone, "remote", "set-head", "origin", "main")
    // Another person's clone, which merges on the remote.
    const other = join(folder, "other")
    sh(folder, "clone", "--quiet", origin, other)
    await use({ origin, clone, other, root: join(folder, "worktrees") })
  },
})

describe("fetching for real", () => {
  it("brings the remote's main in, and makes a branch merged there read as merged", async ({
    fx: f,
    resources,
  }) => {
    const store = new WorkspaceStore(":memory:")
    resources.defer(() => store.close())
    const project = randomUUID()
    await store.createProject({ id: project, name: "P", cwd: f.clone })
    const owners = new Set(["t1"])
    const worktrees = new Worktrees(store, {
      exists: (id) => owners.has(id),
      owner: (id) => (owners.has(id) ? "open" : "history"),
      root: f.root,
      projectFolder: () => f.clone,
    })
    resources.defer(() => worktrees.stop())
    const opened = await worktrees.open({
      projectId: project,
      terminalId: "t1",
      cwd: f.clone,
      branch: "feature",
    })
    if (!opened.ok) throw new Error(opened.reason)
    writeFileSync(join(opened.path, "f.txt"), "f\n")
    sh(opened.path, "add", "-A")
    sh(opened.path, "commit", "--quiet", "-m", "feature work")
    sh(opened.path, "push", "--quiet", "origin", "feature")
    // On the remote, the pull request is squash-merged.
    sh(f.other, "fetch", "--quiet", "origin")
    sh(f.other, "merge", "--quiet", "--squash", "origin/feature")
    sh(f.other, "commit", "--quiet", "-m", "squash feature")
    sh(f.other, "push", "--quiet", "origin", "main")
    owners.delete("t1")
    // Not merged as far as this clone knows.
    await worktrees.tidy()
    expect(existsSync(opened.path)).toBe(true)
    const common = sh(f.clone, "rev-parse", "--path-format=absolute", "--git-common-dir")
    expect(worktrees.fetchedAt(common)).toBeUndefined()
    await worktrees.tidy(true)
    expect(existsSync(opened.path)).toBe(false)
    expect(sh(f.clone, "branch", "--list", "feature")).toBe("")
    expect(worktrees.fetchedAt(common)).toBeTypeOf("number")
  })
})
