import { describe, expect, it } from "../test.js"
import { findRepos, recentMs, type SourceIo } from "./grant-sources.js"

const now = 1_000_000_000_000
const old = now - recentMs - 1
// A fake disk: folders, which are repos, their remotes and when their config changed.
// The walk joins paths with the platform's separator; the fake disk is spelled with slashes.
const slashed = (path: string) => path.replaceAll("\\", "/")
const world = (
  repos: Record<string, { remotes: [string, string][]; changed?: number; head?: string }>,
  github: Record<string, string> = {},
): SourceIo & { readonly gh: string[] } => {
  const gh: string[] = []
  const paths = new Set<string>()
  for (const path of ["/p", ...Object.keys(repos)]) {
    const parts = path.split("/").filter(Boolean)
    for (let at = 1; at <= parts.length; at += 1) paths.add(`/${parts.slice(0, at).join("/")}`)
  }
  return {
    gh,
    now: () => now,
    folders: (given) => {
      const dir = slashed(given)
      return Promise.resolve(
        [...paths]
          .filter(
            (path) =>
              path !== dir &&
              path.startsWith(`${dir}/`) &&
              !path.slice(dir.length + 1).includes("/"),
          )
          .map((path) => path.slice(dir.length + 1)),
      )
    },
    isRepo: (dir) => Promise.resolve(slashed(dir) in repos),
    remotes: (dir) =>
      Promise.resolve((repos[slashed(dir)]?.remotes ?? []).map(([name, url]) => ({ name, url }))),
    configChangedAt: (dir) => Promise.resolve(repos[slashed(dir)]?.changed ?? old),
    githubDefault: (name) => {
      gh.push(name)
      return Promise.resolve(github[name])
    },
    remoteHead: (dir) => Promise.resolve(repos[slashed(dir)]?.head),
  }
}

describe("the repos a Grant card offers", () => {
  it("ticks the origin of a repo that hasn't changed lately, with the default GitHub reports", async () => {
    const io = world(
      { "/p/shop": { remotes: [["origin", "git@github.com:acme/shop.git"]] } },
      { "acme/shop": "trunk" },
    )
    expect(await findRepos("/p", io)).toEqual([
      {
        repo: { url: "github.com/acme/shop", defaultBranch: "trunk", defaultFrom: "github" },
        ticked: true,
        flag: null,
      },
    ])
  })

  it("leaves a repo changed in the last day unticked as recent, and another remote as added", async () => {
    const io = world({
      "/p/fresh": { remotes: [["origin", "https://github.com/acme/fresh"]], changed: now - 1_000 },
      "/p/shop": {
        remotes: [
          ["origin", "https://github.com/acme/shop"],
          ["evil", "https://github.com/mallory/shop"],
        ],
      },
    })
    const found = await findRepos("/p", io)
    expect(found.map(({ repo, ticked, flag }) => [repo.url, ticked, flag])).toEqual([
      ["github.com/acme/fresh", false, "recent"],
      ["github.com/acme/shop", true, null],
      ["github.com/mallory/shop", false, "added-remote"],
    ])
  })

  it("reads two levels deep, one choice a repo, ticked if any copy of it is an old origin", async () => {
    const io = world({
      "/p/source/shop": { remotes: [["origin", "https://github.com/acme/shop"]] },
      "/p/source/shop/deep/x": { remotes: [["origin", "https://github.com/acme/too-deep"]] },
      "/p/other": { remotes: [["origin", "https://github.com/acme/shop"]], changed: now },
      "/p/lab": { remotes: [["origin", "https://gitlab.com/acme/lab"]] },
    })
    const found = await findRepos("/p", io)
    expect(found.map(({ repo, ticked }) => [repo.url, ticked])).toEqual([
      ["github.com/acme/shop", true],
    ])
  })

  it("falls back to the remote's HEAD, then a guess, when GitHub says nothing", async () => {
    const io = world({
      "/p/a": { remotes: [["origin", "https://github.com/acme/a"]], head: "develop" },
      "/p/b": { remotes: [["origin", "https://github.com/acme/b"]] },
    })
    const found = await findRepos("/p", io)
    expect(found.map(({ repo }) => [repo.defaultBranch, repo.defaultFrom])).toEqual([
      ["develop", "remote-head"],
      ["main", "guess"],
    ])
  })
})
