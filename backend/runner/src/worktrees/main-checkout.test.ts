import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { gitIn, withOrigin, type Origin } from "../testing/origin.js"
import { MainFetcher } from "./fetching.js"
import { MainCheckouts } from "./main-checkout.js"

type Setup = {
  origin: Origin
  fetcher: MainFetcher
  checkouts: MainCheckouts
  common: string
}

const it = base.extend<{ setup: Setup }>({
  setup: async ({ resources }, use) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    const fetcher = new MainFetcher({ environment: {} })
    resources.defer(() => fetcher.abort())
    const checkouts = new MainCheckouts({
      moved: (commonDir) => fetcher.moved(commonDir),
      update: (commonDir) => fetcher.update(commonDir),
    })
    await use({ origin, fetcher, checkouts, common: join(origin.repo, ".git") })
  },
})
describe("a project's checkout against main", () => {
  it("follows main by itself after a fetch, and says nothing", async ({ setup: s }) => {
    const landed = s.origin.land("b.txt")
    await s.fetcher.fetchNow([s.common])
    await s.fetcher.idle()
    expect(gitIn(s.origin.repo, "rev-parse", "HEAD")).toBe(landed)
    expect(s.fetcher.moved(s.common)).toBe(1)
    expect(await s.checkouts.read(s.origin.repo)).toEqual({ behind: null, moved: 1, head: landed })
  })

  it("leaves the checkout be after a fetch where following is switched off", async ({
    setup: s,
    resources,
  }) => {
    const fetcher = new MainFetcher({ environment: {}, follow: () => false })
    resources.defer(() => fetcher.abort())
    const before = gitIn(s.origin.repo, "rev-parse", "HEAD")
    s.origin.land("b.txt")
    await fetcher.fetchNow([s.common])
    await fetcher.idle()
    expect(gitIn(s.origin.repo, "rev-parse", "HEAD")).toBe(before)
    expect(fetcher.moved(s.common)).toBe(0)
  })

  it("says how far behind it is when changes kept it from moving, and updates on request", async ({
    setup: s,
  }) => {
    s.origin.land("b.txt")
    const landed = s.origin.land("c.txt")
    const before = gitIn(s.origin.repo, "rev-parse", "HEAD")
    writeFileSync(join(s.origin.repo, "a.txt"), "mine\n")
    await s.fetcher.fetchNow([s.common])
    await s.fetcher.idle()
    expect(s.fetcher.moved(s.common)).toBe(0)
    expect(await s.checkouts.read(s.origin.repo)).toEqual({
      behind: { branch: "main", remote: "origin/main", count: 2 },
      moved: 0,
      head: before,
    })
    expect(await s.checkouts.update(s.origin.repo)).toEqual({ ok: true })
    expect(gitIn(s.origin.repo, "rev-parse", "HEAD")).toBe(landed)
    expect(await s.checkouts.read(s.origin.repo)).toEqual({ behind: null, moved: 1, head: landed })
  })

  it("says so, whatever the reason the checkout wasn't moved", async ({ setup: s }) => {
    // A file of the person's own, untracked, where main brings one.
    s.origin.land("b.txt")
    writeFileSync(join(s.origin.repo, "b.txt"), "mine\n")
    await s.fetcher.fetchNow([s.common])
    await s.fetcher.idle()
    expect(s.fetcher.moved(s.common)).toBe(0)
    expect(await s.checkouts.read(s.origin.repo)).toMatchObject({ behind: { count: 1 } })
    expect(await s.checkouts.update(s.origin.repo)).toEqual({
      ok: false,
      said: "b.txt is in the way, and not tracked.",
    })
  })

  it("names the file where a change is in the way", async ({ setup: s }) => {
    s.origin.land("a.txt")
    writeFileSync(join(s.origin.repo, "a.txt"), "mine\n")
    await s.fetcher.fetchNow([s.common])
    await s.fetcher.idle()
    expect(await s.checkouts.update(s.origin.repo)).toEqual({
      ok: false,
      said: "Your changes to a.txt would be overwritten.",
    })
  })

  it("says nothing off main", async ({ setup: s }) => {
    s.origin.land("b.txt")
    await s.fetcher.fetchNow([s.common])
    await s.fetcher.idle()
    gitIn(s.origin.repo, "checkout", "--quiet", "-b", "feature")
    expect(await s.checkouts.read(s.origin.repo)).toMatchObject({ behind: null })
  })

  it("has nothing for a folder outside a repository", async ({ setup: s, resources }) => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-plain-")))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    expect(await s.checkouts.read(folder)).toEqual({ behind: null, moved: 0, head: null })
  })
})
