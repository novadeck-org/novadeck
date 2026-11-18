import { randomUUID } from "node:crypto"
import { join } from "node:path"

import { git as realGit } from "../checkouts/git.js"
import { describe, expect, it as base } from "../test.js"
import { gitIn, withOrigin, type Origin } from "../testing/origin.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { MainFetcher } from "../worktrees/fetching.js"
import { CompanionItems, type TerminalPlace } from "./items.js"

type Fixture = {
  origin: Origin
  place: TerminalPlace
  items: CompanionItems
  fetcher: MainFetcher
  /** The fetches the fetcher ran. */
  fetches: string[]
  common: string
}

const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    const origin = withOrigin((cleanup) => resources.defer(cleanup))
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    const project = await store.createProject({ id: randomUUID(), name: "P", cwd: origin.repo })
    const session = store.createSession({ id: randomUUID(), projectId: project.id, name: "S" })
    const place: TerminalPlace = {
      terminalId: randomUUID(),
      sessionId: session.id,
      handle: "moth",
      cwd: origin.repo,
      project: origin.repo,
    }
    store.saveTerminal({
      id: place.terminalId,
      sessionId: session.id,
      cwd: origin.repo,
      agents: {},
      promptedAt: null,
      handle: "moth",
      naming: { person: null, opener: null, murmur: null, own: null, summary: null },
      openedBy: null,
      ledBy: null,
      command: null,
      lastProgram: null,
      work: null,
    })
    const fetches: string[] = []
    const fetcher = new MainFetcher({
      environment: {},
      follow: () => false,
      run: (cwd, args, limit) => {
        if (args.includes("fetch")) fetches.push(cwd)
        return realGit(cwd, args, limit)
      },
    })
    resources.defer(() => fetcher.abort())
    const items = new CompanionItems({
      records: store,
      terminal: (terminalId) => (terminalId === place.terminalId ? place : undefined),
      project: () => origin.repo,
      origin: {
        fetchBriefly: (commonDir, ms) => fetcher.fetchBriefly(commonDir, ms),
        status: (commonDir) => ({
          ...(fetcher.fetchedAt(commonDir) !== undefined && {
            fetchedAt: fetcher.fetchedAt(commonDir)!,
          }),
          ...(fetcher.failure(commonDir) !== undefined && { failed: fetcher.failure(commonDir)! }),
        }),
      },
      fetchWaitMs: 400,
      pollMs: 10,
      changesMs: 10,
    })
    resources.defer(() => items.shutdown())
    await use({ origin, place, items, fetcher, fetches, common: join(origin.repo, ".git") })
  },
})

const first = async (fixture: Fixture, id: string) => {
  const watch = new AbortController()
  try {
    const stream = fixture.items.content(id, undefined, watch.signal)
    return (await stream.next()).value
  } finally {
    watch.abort()
  }
}

describe("a compare of remote refs", () => {
  it("shows a commit pushed to origin after the clone, fetched when it is shown", async ({
    fixture: f,
  }) => {
    const landed = f.origin.land("b.txt")
    const shown = await f.items.show(f.place, { changes: { base: "main", head: "origin/main" } })
    if (!shown.ok) throw new Error(shown.reason)
    expect(f.fetches).toHaveLength(1)
    const content = await first(f, shown.id)
    expect(content).toMatchObject({
      state: "ready",
      content: {
        kind: "changes",
        head: "origin/main",
        layers: [{ id: landed }],
        origin: { fetchedAt: expect.any(Number) },
      },
    })
    // Kept fetched on the runner's schedule while it is on a bar.
    expect(await f.items.remoteRepositories()).toEqual([f.common])
    // Fetched a moment ago, so showing it again fetches nothing.
    await f.items.show(f.place, { changes: { base: "main", head: "origin/main" } })
    expect(f.fetches).toHaveLength(1)
  })

  it("says why a fetch failed, and keeps what it had", async ({ fixture: f }) => {
    f.origin.land("b.txt")
    gitIn(f.origin.repo, "remote", "set-url", "origin", join(f.origin.repo, "nowhere.git"))
    const shown = await f.items.show(f.place, { changes: { base: "main", head: "origin/main" } })
    if (!shown.ok) throw new Error(shown.reason)
    const content = await first(f, shown.id)
    expect(content).toMatchObject({ content: { origin: { failed: expect.any(String) } } })
  })

  it("never fetches for refs that are not remote ones", async ({ fixture: f }) => {
    gitIn(f.origin.repo, "branch", "side")
    await f.items.show(f.place, { changes: { base: "main", head: "side" } })
    await f.items.show(f.place, { changes: { base: "main~0", head: "HEAD" } })
    expect(f.fetches).toEqual([])
    expect(await f.items.remoteRepositories()).toEqual([])
  })

  it.skipIf(process.platform === "win32")(
    "doesn't hold a show past its bound for a remote that hangs",
    async ({ fixture: f }) => {
      gitIn(f.origin.repo, "config", "protocol.ext.allow", "always")
      gitIn(f.origin.repo, "remote", "set-url", "origin", "ext::sleep 30")
      const started = Date.now()
      const shown = await f.items.show(f.place, { changes: { base: "main", head: "origin/main" } })
      expect(shown).toMatchObject({ ok: true })
      expect(Date.now() - started).toBeLessThan(5000)
      expect(f.fetches).toHaveLength(1)
      expect(f.fetcher.fetchedAt(f.common)).toBeUndefined()
    },
  )
})
