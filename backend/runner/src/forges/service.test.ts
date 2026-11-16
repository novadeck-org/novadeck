import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Forge, ForgeName, Problem, PullRequest, Token } from "@novadeck/forges"

import { describe, expect, it } from "../test.js"
import { Forges, type ForgesOptions, type RepositoryFacts } from "./service.js"

const every = 5 * 60 * 1000
const open: PullRequest = {
  number: 7,
  url: "https://example.com/pull/7",
  title: "Add",
  state: "open",
}

type Fake = {
  readonly forge: Forge
  /** What each call saw. */
  readonly tokens: string[]
  readonly lookups: {
    readonly host: string
    readonly token: string
    readonly branches: string[]
  }[]
  /** What the next token and lookup answer; a function sees how many came before. */
  token: (call: number) => Token | Problem
  answer: (call: number) => ReadonlyMap<string, PullRequest> | Problem
}

const hostsOf: Record<ForgeName, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  azure: "dev.azure.com",
}

// A forge that claims its own host by name, with a scripted token and answer.
const fake = (name: ForgeName): Fake => {
  const state: Fake = {
    tokens: [],
    lookups: [],
    token: () => ({ value: `${name}-token` }),
    answer: () => new Map([["feature", open]]),
    forge: {
      name,
      program: name,
      defaultHost: hostsOf[name],
      repository: (remote) =>
        remote.host === hostsOf[name]
          ? name === "github"
            ? { forge: "github", host: remote.host, owner: "o", name: "r" }
            : name === "gitlab"
              ? { forge: "gitlab", host: remote.host, path: "o/r" }
              : {
                  forge: "azure",
                  host: remote.host,
                  organization: "o",
                  project: "p",
                  name: "r",
                }
          : undefined,
      signedIn: async () => [],
      token: async (_run, host) => {
        state.tokens.push(host)
        return state.token(state.tokens.length)
      },
      pullRequests: async (_fetch, token, repository, branches) => {
        state.lookups.push({
          host: repository.host,
          token: token.value,
          branches: [...branches],
        })
        return state.answer(state.lookups.length)
      },
      signIn: (host) => `${name} login ${host}`,
    },
  }
  return state
}

const dirs = { a: "/repos/a/.git", b: "/repos/b/.git" }
const remotes: Record<string, string> = {
  [dirs.a]: "https://github.com/o/r.git",
  [dirs.b]: "https://gitlab.com/o/r.git",
}

// The service over fake forges and the repositories `repositories` names, with a clock the
// test moves, a watched Worktrees panel, and every tool installed.
const setup = (
  options: {
    enabled?: ForgeName[]
    repositories?: RepositoryFacts[]
    watching?: boolean
    installed?: readonly string[]
    platform?: NodeJS.Platform
    remote?: ForgesOptions["remote"]
  } = {},
) => {
  const fakes = {
    github: fake("github"),
    gitlab: fake("gitlab"),
    azure: fake("azure"),
  }
  const state = {
    enabled: options.enabled ?? [],
    now: 1_000_000,
    watching: options.watching ?? true,
    saved: [] as ForgeName[][],
    repositories: options.repositories ?? [
      { commonDir: dirs.a, branches: ["feature"], fetchedAt: 1 },
      { commonDir: dirs.b, branches: ["feature"], fetchedAt: 1 },
    ],
    refreshed: 0,
    remoteReads: 0,
    installed: options.installed ?? ["github", "gitlab", "azure", "brew"],
  }
  const forges = new Forges({
    enabled: () => state.enabled,
    save: (names) => {
      state.saved.push([...names])
      state.enabled = [...names]
    },
    repositories: () => state.repositories,
    watching: () => state.watching,
    environment: () => ({}),
    refreshEnvironment: async () => {
      state.refreshed += 1
    },
    forges: {
      github: fakes.github.forge,
      gitlab: fakes.gitlab.forge,
      azure: fakes.azure.forge,
    },
    run: async () => ({ ok: false, kind: "missing", said: "" }),
    find: (program) => (state.installed.includes(program) ? `/bin/${program}` : undefined),
    remote:
      options.remote ??
      (async (commonDir) => {
        state.remoteReads += 1
        return remotes[commonDir]
      }),
    platform: options.platform ?? "linux",
    now: () => state.now,
    every,
  })
  return { forges, fakes, state }
}

const calls = (fakes: ReturnType<typeof setup>["fakes"]) =>
  Object.values(fakes).reduce((sum, each) => sum + each.tokens.length + each.lookups.length, 0)

describe("the forges service", () => {
  it("runs and fetches nothing while every forge is off", async () => {
    const { forges, fakes } = setup()
    await forges.tick()
    expect(calls(fakes)).toBe(0)
    expect(forges.pullRequest(dirs.a, "feature")).toBeUndefined()
  })

  it("looks up nothing while the works are not watched", async () => {
    const { forges, fakes } = setup({ enabled: ["github"], watching: false })
    await forges.tick()
    expect(calls(fakes)).toBe(0)
  })

  it("looks up only the repositories of the forges switched on", async () => {
    const { forges, fakes } = setup({ enabled: ["github"] })
    await forges.tick()
    expect(fakes.github.lookups).toEqual([
      { host: "github.com", token: "github-token", branches: ["feature"] },
    ])
    expect(fakes.gitlab.tokens).toEqual([])
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
    expect(forges.pullRequest(dirs.b, "feature")).toBeUndefined()
    expect(forges.pullRequest(dirs.a, "other")).toBeUndefined()
  })

  it("starts looking at once when a forge is switched on, and stores the switch", async () => {
    const { forges, fakes, state } = setup({ watching: true })
    const integration = await forges.set("gitlab", true)
    expect(state.saved).toEqual([["gitlab"]])
    expect(integration).toEqual({
      forge: "gitlab",
      available: true,
      enabled: true,
      hosts: [{ host: "gitlab.com", state: "signed-in" }],
    })
    await forges.tick()
    expect(fakes.gitlab.lookups).toHaveLength(1)
    expect(fakes.github.lookups).toHaveLength(0)
  })

  it("forgets what a forge found once it is switched off", async () => {
    const { forges } = setup({ enabled: ["github"] })
    await forges.tick()
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
    await forges.set("github", false)
    expect(forges.pullRequest(dirs.a, "feature")).toBeUndefined()
  })

  it("looks again every five minutes, when the fetch moves, or when a branch comes", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"] })
    await forges.tick()
    state.now += every - 1
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(1)
    state.now += 1
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(2)
    state.repositories = [{ commonDir: dirs.a, branches: ["feature"], fetchedAt: 2 }]
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(3)
    state.repositories = [{ commonDir: dirs.a, branches: ["feature", "next"], fetchedAt: 2 }]
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(4)
    expect(fakes.github.lookups[3]?.branches).toEqual(["feature", "next"])
  })

  it("looks again every minute while an open pull request's checks run, and every five once they end", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"] })
    const running: PullRequest = { ...open, ci: "running" }
    fakes.github.answer = () => new Map([["feature", running]])
    await forges.tick()
    state.now += 60_000 - 1
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(1)
    state.now += 1
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(2)
    fakes.github.answer = () => new Map([["feature", { ...open, ci: "passed" as const }]])
    state.now += 60_000
    await forges.tick()
    expect(forges.pullRequest(dirs.a, "feature")?.ci).toBe("passed")
    state.now += every - 1
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(3)
    state.now += 1
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(4)
  })

  it("backs off from a failing repository, keeping what it found", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"] })
    await forges.tick()
    fakes.github.answer = () => ({ kind: "unreachable" })
    state.now += every
    await forges.tick()
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
    // A fetch that moved does not shorten a wait a failure set: twice the usual, then four times.
    state.repositories = [{ commonDir: dirs.a, branches: ["feature"], fetchedAt: 9 }]
    state.now += every
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(2)
    state.now += every
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(3)
    state.now += every * 3
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(3)
    state.now += every
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(4)
    // Answering again ends the backoff.
    fakes.github.answer = () => new Map()
    state.now += every * 100
    await forges.tick()
    expect(forges.pullRequest(dirs.a, "feature")).toBeUndefined()
    state.now += every
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(6)
  })

  it("waits until the time a rate limit gives", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"] })
    const until = state.now + 20 * 60 * 1000
    fakes.github.answer = () => ({ kind: "limited", until })
    await forges.tick()
    state.now = until - 1
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(1)
    fakes.github.answer = () => new Map([["feature", open]])
    state.now = until
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(2)
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
  })

  it("keeps a token until it ends, and asks again then", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"] })
    fakes.github.token = (call) => ({
      value: `t${call}`,
      expiresAt: state.now + every + 60_000,
    })
    await forges.tick()
    state.now += every
    await forges.tick()
    expect(fakes.github.tokens).toHaveLength(1)
    expect(fakes.github.lookups.map((each) => each.token)).toEqual(["t1", "t1"])
    state.now += every
    await forges.tick()
    expect(fakes.github.lookups.map((each) => each.token)).toEqual(["t1", "t1", "t2"])
  })

  it("retries a refused lookup once, with a fresh token", async () => {
    const { forges, fakes } = setup({ enabled: ["github"] })
    fakes.github.token = (call) => ({ value: `t${call}` })
    fakes.github.answer = (call) =>
      call === 1 ? { kind: "refused" } : new Map([["feature", open]])
    await forges.tick()
    expect(fakes.github.lookups.map((each) => each.token)).toEqual(["t1", "t2"])
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
  })

  it("gives up on a lookup refused twice, and says the host refused", async () => {
    const { forges, fakes } = setup({ enabled: ["github"] })
    fakes.github.answer = () => ({
      kind: "refused",
      fix: "gh auth refresh -s repo",
    })
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(2)
    expect(forges.pullRequest(dirs.a, "feature")).toBeUndefined()
    const [github] = await forges.list()
    expect(github?.hosts).toEqual([
      { host: "github.com", state: "refused", fix: "gh auth refresh -s repo" },
    ])
  })

  it("drops a token the tool no longer gives for a signed-out host", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"] })
    await forges.tick()
    fakes.github.token = () => ({
      kind: "signed-out",
      fix: "gh auth login --hostname github.com",
    })
    fakes.github.answer = () => ({ kind: "refused" })
    state.now += every
    await forges.tick()
    const [github] = await forges.list()
    expect(github?.hosts).toEqual([
      {
        host: "github.com",
        state: "signed-out",
        fix: "gh auth login --hostname github.com",
      },
    ])
  })

  it("lists each forge in order, with where it stands", async () => {
    const { forges, fakes } = setup({
      enabled: ["github", "gitlab"],
      installed: ["github", "gitlab"],
    })
    fakes.gitlab.token = () => ({
      kind: "signed-out",
      fix: "glab auth login --hostname gitlab.com",
    })
    expect(await forges.list()).toEqual([
      {
        forge: "github",
        available: true,
        enabled: true,
        hosts: [{ host: "github.com", state: "signed-in" }],
      },
      {
        forge: "gitlab",
        available: true,
        enabled: true,
        hosts: [
          {
            host: "gitlab.com",
            state: "signed-out",
            fix: "glab auth login --hostname gitlab.com",
          },
        ],
      },
      { forge: "azure", available: false, enabled: false, hosts: [] },
    ])
  })

  it("lists what is already known when cached, asking no tool and reading no remote", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"], installed: ["github"] })
    expect(await forges.list({ cached: true })).toEqual([
      { forge: "github", available: true, enabled: true, hosts: [] },
      { forge: "gitlab", available: false, enabled: false, hosts: [] },
      { forge: "azure", available: false, enabled: false, hosts: [] },
    ])
    expect(calls(fakes)).toBe(0)
    expect(state.remoteReads).toBe(0)
    await forges.list()
    const [github] = await forges.list({ cached: true })
    expect(github?.hosts).toEqual([{ host: "github.com", state: "signed-in" }])
  })

  it("names a forge's own host when no repository is on it, and no host while it is off or missing", async () => {
    const { forges } = setup({
      enabled: ["azure"],
      repositories: [],
      installed: ["github", "azure"],
    })
    const [github, gitlab, azure] = await forges.list()
    expect(github).toEqual({
      forge: "github",
      available: true,
      enabled: false,
      hosts: [],
    })
    expect(gitlab).toEqual({
      forge: "gitlab",
      available: false,
      enabled: false,
      hosts: [],
    })
    expect(azure?.hosts).toEqual([{ host: "dev.azure.com", state: "signed-in" }])
  })

  it("offers an installer only for a missing tool, by platform", async () => {
    const mac = setup({ platform: "darwin", installed: ["github", "brew"] })
    expect((await mac.forges.list()).map((each) => each.installer)).toEqual([
      undefined,
      "brew install glab",
      "brew install azure-cli",
    ])
    const noBrew = setup({ platform: "darwin", installed: [] })
    expect((await noBrew.forges.list()).map((each) => each.installer)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    const windows = setup({ platform: "win32", installed: ["github"] })
    expect((await windows.forges.list()).map((each) => each.installer)).toEqual([
      undefined,
      "winget install --id GLab.GLab -e",
      "winget install --id Microsoft.AzureCLI -e",
    ])
    const linux = setup({ installed: [] })
    expect((await linux.forges.list()).map((each) => each.installer)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  it("reads the environment and the remotes again for a fresh list", async () => {
    const { forges, state } = setup({ enabled: ["github"] })
    await forges.list()
    await forges.list()
    const reads = state.remoteReads
    expect(state.refreshed).toBe(0)
    await forges.list({ fresh: true })
    expect(state.refreshed).toBe(1)
    expect(state.remoteReads).toBe(reads + state.repositories.length)
  })

  it("drops a token a lookup finds revoked, retries once, and says the host is signed out", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"] })
    fakes.github.token = (call) => ({ value: `t${call}` })
    await forges.tick()
    expect(fakes.github.tokens).toHaveLength(1)
    // The token held without an end is revoked: the host answers signed-out.
    fakes.github.answer = (call) =>
      call === 2
        ? { kind: "signed-out", fix: "gh auth login --hostname github.com" }
        : new Map([["feature", open]])
    state.now += every
    await forges.tick()
    expect(fakes.github.lookups.map((each) => each.token)).toEqual(["t1", "t1", "t2"])
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
    // Signed out for good: the host says so, instead of "signed in".
    fakes.github.answer = () => ({ kind: "signed-out", fix: "gh auth login --hostname github.com" })
    state.now += every
    await forges.tick()
    const [github] = await forges.list({ cached: true })
    expect(github?.hosts).toEqual([
      { host: "github.com", state: "signed-out", fix: "gh auth login --hostname github.com" },
    ])
  })

  it("looks again at once after a fresh list, whatever a failure held back", async () => {
    const { forges, fakes } = setup({ enabled: ["github"] })
    fakes.github.answer = () => ({ kind: "unreachable" })
    await forges.tick()
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(1)
    fakes.github.answer = () => new Map([["feature", open]])
    await forges.list({ fresh: true })
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(2)
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
  })

  it("keeps what it found through a fresh list, so the marks don't blink", async () => {
    const { forges, state } = setup({ enabled: ["github"] })
    await forges.tick()
    // No pass looks again meanwhile: what shows is what the list kept.
    state.watching = false
    await forges.list({ fresh: true })
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
  })

  it("keeps backing off when the tool hands out again the token the host turned away", async () => {
    const twoOnGitHub: Record<string, string> = {
      [dirs.a]: "https://github.com/o/a.git",
      [dirs.b]: "https://github.com/o/b.git",
    }
    const { forges, fakes, state } = setup({
      enabled: ["github"],
      remote: async (commonDir) => twoOnGitHub[commonDir],
    })
    await forges.tick()
    // Revoked on the host, while `gh` still hands it out.
    fakes.github.answer = () => ({ kind: "signed-out", fix: "gh auth login --hostname github.com" })
    state.now += every
    await forges.tick()
    const looked = fakes.github.lookups.length
    // A minute of ticks: neither repository's look sets the other's going again.
    for (let tick = 0; tick < 12; tick += 1) {
      state.now += 5000
      // eslint-disable-next-line no-await-in-loop -- One tick after another.
      await forges.tick()
    }
    expect(fakes.github.lookups).toHaveLength(looked)
    // Each failure doubles the wait: not looked at 10 min on, but 20 min on.
    state.now += 2 * every
    await forges.tick()
    const second = fakes.github.lookups.length
    expect(second).toBeGreaterThan(looked)
    state.now += 2 * every
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(second)
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
  })

  it("asks a signed-out tool once a look, not again to retry", async () => {
    const { forges, fakes } = setup({ enabled: ["github"] })
    fakes.github.token = () => ({ kind: "signed-out", fix: "gh auth login --hostname github.com" })
    await forges.tick()
    expect(fakes.github.tokens).toHaveLength(1)
    expect(fakes.github.lookups).toHaveLength(0)
  })

  it("sees a sign-in made in the person's own terminal when it lists, and looks again", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"] })
    fakes.github.token = () => ({ kind: "signed-out", fix: "gh auth login --hostname github.com" })
    await forges.tick()
    expect(forges.pullRequest(dirs.a, "feature")).toBeUndefined()
    // `gh auth login`, run outside Novadeck; then Preferences opens.
    fakes.github.token = () => ({ value: "new" })
    state.now += 1000
    const [github] = await forges.list()
    expect(github?.hosts).toEqual([{ host: "github.com", state: "signed-in" }])
    await forges.tick()
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
  })

  it("sees a refused token mended in the person's own terminal when it lists, and looks again", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"] })
    fakes.github.answer = () => ({ kind: "refused", fix: "gh auth refresh -s repo" })
    await forges.tick()
    expect((await forges.list({ cached: true }))[0]?.hosts).toEqual([
      { host: "github.com", state: "refused", fix: "gh auth refresh -s repo" },
    ])
    // Listing again with the same token says nothing new.
    expect((await forges.list())[0]?.hosts[0]?.state).toBe("refused")
    // `gh auth refresh -s repo`, run outside Novadeck: a new token, which the host takes.
    fakes.github.token = () => ({ value: "mended" })
    fakes.github.answer = () => new Map([["feature", open]])
    state.now += 1000
    expect((await forges.list())[0]?.hosts).toEqual([{ host: "github.com", state: "signed-in" }])
    await forges.tick()
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
  })

  it("says a host turned the token away still, after a fresh list whose tool gives it again", async () => {
    const { forges, fakes } = setup({ enabled: ["github"] })
    fakes.github.answer = () => ({ kind: "signed-out", fix: "gh auth login --hostname github.com" })
    await forges.tick()
    // A Sign in the person cancelled: the terminal ends and the list is asked afresh.
    const [github] = await forges.list({ fresh: true })
    expect(github?.hosts).toEqual([
      { host: "github.com", state: "signed-out", fix: "gh auth login --hostname github.com" },
    ])
  })

  it("reads an origin again in a while, one added since or one whose read failed", async () => {
    let origin: string | undefined
    let reads = 0
    const { forges, state } = setup({
      enabled: ["github"],
      repositories: [{ commonDir: dirs.a, branches: ["feature"], fetchedAt: 1 }],
      remote: async () => {
        reads += 1
        if (reads === 2) throw new Error("git broke")
        return origin
      },
    })
    await forges.tick()
    expect(forges.pullRequest(dirs.a, "feature")).toBeUndefined()
    state.now += every
    await forges.tick()
    expect(reads).toBe(2)
    // `git remote add origin`, meanwhile.
    origin = "https://github.com/o/r.git"
    state.now += every
    await forges.tick()
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
  })

  it("keeps what it found when a forge is switched as it already was", async () => {
    const { forges, state } = setup({ enabled: ["github"] })
    await forges.tick()
    // No pass looks again meanwhile: what shows is what the switch kept.
    state.watching = false
    await forges.set("github", true)
    expect(forges.pullRequest(dirs.a, "feature")).toEqual(open)
  })

  it("waits at least a minute for a rate limit whose time has already passed", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"] })
    fakes.github.answer = () => ({ kind: "limited", until: state.now - 1000 })
    await forges.tick()
    state.now += 59_000
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(1)
    state.now += 1000
    await forges.tick()
    expect(fakes.github.lookups).toHaveLength(2)
  })

  it("keeps nothing for a forge switched off while a pass was under way", async () => {
    const { forges, fakes, state } = setup({ enabled: ["github"] })
    fakes.github.answer = () => {
      state.enabled = []
      return new Map([["feature", open]])
    }
    await forges.tick()
    state.enabled = ["github"]
    expect(forges.pullRequest(dirs.a, "feature")).toBeUndefined()
    const [github] = await forges.list({ cached: true })
    expect(github?.hosts).toEqual([])
  })

  it("reads a repository's origin from git, its insteadOf rewrite applied", async ({
    resources,
  }) => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-forges-test-")))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    execFileSync("git", ["init", "-q", folder])
    execFileSync("git", ["-C", folder, "config", "url.https://github.com/.insteadOf", "gh:"])
    execFileSync("git", ["-C", folder, "remote", "add", "origin", "gh:o/r.git"])
    const { fakes } = setup()
    // No `remote` option: the default reader.
    const own = new Forges({
      enabled: () => ["github"],
      save: () => {},
      repositories: () => [
        {
          commonDir: join(folder, ".git"),
          branches: ["feature"],
          fetchedAt: undefined,
        },
      ],
      watching: () => true,
      environment: () => ({}),
      forges: {
        github: fakes.github.forge,
        gitlab: fakes.gitlab.forge,
        azure: fakes.azure.forge,
      },
      run: async () => ({ ok: false, kind: "missing", said: "" }),
      find: () => "/bin/tool",
    })
    await own.tick()
    expect(own.pullRequest(join(folder, ".git"), "feature")).toEqual(open)
  })
})
