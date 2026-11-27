import type { ProjectFiles, RepoSync, SyncLanding } from "@novadeck/core/files"
import { vi } from "vitest"

import { describe, expect, it } from "../test"
import {
  agoOf,
  createSyncFeed,
  freshNotices,
  hasNews,
  hidesNews,
  landingNotice,
  landingSub,
  marksOf,
  syncFeedOf,
  syncPollMs,
  whyBehind,
} from "./files-sync"

const landing = (parts: Partial<SyncLanding> = {}): SyncLanding => ({
  from: "a",
  to: "1234567890abcdef",
  at: 0,
  commits: 3,
  merges: [
    { subject: "Mine", pr: 1, commit: "x", own: true },
    { subject: "Theirs", pr: 2, commit: "y", own: false },
  ],
  files: [],
  filesTotal: 14,
  dependencies: null,
  ...parts,
})
const repo = (parts: Partial<RepoSync> = {}): RepoSync => ({
  path: "source/api",
  name: "api",
  branch: "main",
  behind: null,
  ahead: 0,
  landing: null,
  moved: 0,
  head: null,
  ...parts,
})

describe("the words a repository's marks say", () => {
  it("has none for a repository that is up to date", () => {
    expect(marksOf(repo())).toEqual([])
    expect(hasNews(repo())).toBe(false)
  })

  it("counts merges, or commits where none was a pull request", () => {
    expect(marksOf(repo({ landing: landing() }))).toEqual([
      { kind: "new", text: "2 new", tip: "2 merges from origin" },
    ])
    const plain = landing({ merges: [{ subject: "x", pr: null, commit: "z", own: false }] })
    expect(marksOf(repo({ landing: plain }))[0]).toMatchObject({
      text: "1 new",
      tip: "1 commit from origin",
    })
  })

  it("says why main was left behind, and that Novadeck hasn't moved it where nothing held it", () => {
    const held = { remote: "origin/main", count: 1, why: "You have edits in a.ts", merges: [] }
    expect(marksOf(repo({ behind: held }))[0]).toEqual({
      kind: "behind",
      text: "↓1",
      tip: "1 behind origin: you have edits in a.ts",
    })
    expect(whyBehind({ ...held, why: null })).toBe("Novadeck hasn't moved it yet")
  })

  it("says commits not on origin, which are no news", () => {
    expect(marksOf(repo({ ahead: 2 }))).toEqual([
      { kind: "ahead", text: "↑2", tip: "2 commits not on origin yet" },
    ])
    expect(marksOf(repo({ ahead: 1 }))[0]?.tip).toBe("1 commit not on origin yet")
    expect(hasNews(repo({ ahead: 2 }))).toBe(false)
  })

  it("says how long ago, and how far main moved", () => {
    expect(agoOf(0, 30_000)).toBe("just now")
    expect(agoOf(0, 5 * 60_000)).toBe("5 min ago")
    expect(agoOf(0, 3 * 3_600_000)).toBe("3 h ago")
    expect(agoOf(0, 50 * 3_600_000)).toBe("2 d ago")
    expect(landingSub(repo(), landing({ filesTotal: 1, commits: 1 }), 120_000)).toBe(
      "main moved 1 commit · 2 min ago · 1 file",
    )
  })

  it("marks a closed folder that hides a repository with news, not one with none", () => {
    expect(hidesNews("source", [repo({ landing: landing() })])).toBe(true)
    expect(hidesNews("source", [repo({ ahead: 1 })])).toBe(false)
    expect(hidesNews("source/api", [repo({ landing: landing() })])).toBe(false)
    expect(hidesNews("other", [repo({ landing: landing() })])).toBe(false)
  })
})

describe("the notice a landing earns", () => {
  it("is for a pull request of the person's agents, with the dependency hint where there is one", () => {
    expect(landingNotice(repo(), landing())).toEqual({
      id: "main-1234567890ab",
      title: "Mine landed in main",
      body: "api caught up with origin",
    })
    expect(
      landingNotice(
        repo(),
        landing({ dependencies: { file: "x/pnpm-lock.yaml", command: "pnpm install" } }),
      ),
    ).toMatchObject({ body: "New dependencies: run pnpm install before you start the app." })
  })

  it("is for new dependencies alone, and for a teammate's merge alone is none", () => {
    const theirs = landing({ merges: [{ subject: "Theirs", pr: 2, commit: "y", own: false }] })
    expect(landingNotice(repo(), theirs)).toBeUndefined()
    expect(
      landingNotice(repo(), {
        ...theirs,
        dependencies: { file: "x/Cargo.lock", command: "cargo build" },
      }),
    ).toEqual({
      id: "main-1234567890ab",
      title: "New dependencies in api",
      body: "Cargo.lock changed. Run cargo build before you start the app.",
    })
  })
})

describe("the landings the person is told of", () => {
  it("tells each once, and not one that was there before the app began or one it was not to tell of", () => {
    const told = new Set<string>()
    const mine = repo({ landing: landing({ at: 1000 }) })
    expect(freshNotices([mine], told, 500, true)).toHaveLength(1)
    expect(freshNotices([mine], told, 500, true)).toEqual([])
    const older = repo({ landing: landing({ to: "older", at: 100 }) })
    expect(freshNotices([older], told, 500, true)).toEqual([])
    const quiet = repo({ landing: landing({ to: "quiet", at: 1000 }) })
    expect(freshNotices([quiet], told, 500, false)).toEqual([])
    // Seen while the person looked, it is no news later either.
    expect(freshNotices([quiet], told, 500, true)).toEqual([])
  })
})

describe("the feed of a project's repositories", () => {
  it("is none where the backend tells none, and one for each backend and project", () => {
    expect(createSyncFeed({}, "p")).toBeUndefined()
    const files = { sync: async () => ({ repos: [] }) } as unknown as ProjectFiles
    expect(syncFeedOf(files, "p")).toBe(syncFeedOf(files, "p"))
    expect(syncFeedOf(files, "p")).not.toBe(syncFeedOf(files, "q"))
    expect(syncFeedOf(undefined, "p")).toBeUndefined()
  })

  it("asks while retained and every poll, and stops with the last to let go", async () => {
    vi.useFakeTimers()
    try {
      const sync = vi.fn<NonNullable<ProjectFiles["sync"]>>(async () => ({ repos: [repo()] }))
      const feed = createSyncFeed({ sync }, "p")!
      const first = feed.retain()
      const second = feed.retain()
      await vi.advanceTimersByTimeAsync(0)
      expect(sync).toHaveBeenCalledTimes(1)
      expect(feed.store.getSnapshot()?.repos).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(syncPollMs)
      expect(sync).toHaveBeenCalledTimes(2)
      first()
      first()
      await vi.advanceTimersByTimeAsync(syncPollMs)
      expect(sync).toHaveBeenCalledTimes(3)
      second()
      await vi.advanceTimersByTimeAsync(syncPollMs * 3)
      expect(sync).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("takes a landing away at once when it is seen, and tells the backend the commit", async () => {
    const seen = vi.fn<NonNullable<ProjectFiles["seen"]>>(async () => {})
    const feed = createSyncFeed(
      { sync: async () => ({ repos: [repo({ landing: landing() })] }), seen },
      "p",
    )!
    const release = feed.retain()
    await vi.waitFor(() =>
      expect(feed.store.getSnapshot()?.repos[0]?.landing?.to).toBe("1234567890abcdef"),
    )
    feed.seen("source/api", "1234567890abcdef")
    expect(feed.store.getSnapshot()?.repos[0]?.landing).toBeNull()
    expect(seen).toHaveBeenCalledWith("p", "source/api", "1234567890abcdef")
    release()
  })

  it("keeps a newer landing than the one seen, and says a refused or failed update in words", async () => {
    const update = vi
      .fn<NonNullable<ProjectFiles["update"]>>()
      .mockRejectedValueOnce(new Error("gone"))
      .mockResolvedValueOnce({ ok: false, said: "No." })
    const feed = createSyncFeed(
      { sync: async () => ({ repos: [repo({ landing: landing({ to: "newer" }) })] }), update },
      "p",
    )!
    const release = feed.retain()
    await vi.waitFor(() => expect(feed.store.getSnapshot()).toBeDefined())
    feed.seen("source/api", "older")
    expect(feed.store.getSnapshot()?.repos[0]?.landing).not.toBeNull()
    expect(await feed.update("source/api")).toEqual({
      ok: false,
      said: "Novadeck couldn't update it.",
    })
    expect(await feed.update("source/api")).toEqual({ ok: false, said: "No." })
    release()
  })
})
