import type { WorkspaceSession } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import { SessionFeed } from "./session-feed.js"

const sessions = new Map<string, WorkspaceSession>()
const store = {
  revisions: () =>
    Object.fromEntries([...sessions].map(([id, { revision }]) => [id, revision ?? 0])),
  session: (id: string) => {
    const found = sessions.get(id)
    if (!found) throw new Error("NOT_FOUND")
    return found
  },
}
const put = (id: string, revision: number) =>
  sessions.set(id, { id, projectId: "p", name: id, state: null, visitedAt: null, revision })

describe("SessionFeed", () => {
  it("tells each revision first, then each session as it changes, and each one gone", async () => {
    sessions.clear()
    put("a", 4)
    const feed = new SessionFeed(store)
    const stop = new AbortController()
    const watch = feed.watch(stop.signal)
    expect((await watch.next()).value).toEqual({ type: "revisions", revisions: { a: 4 } })
    put("a", 5)
    feed.changed("a", { writer: "w1", base: 4 })
    expect((await watch.next()).value).toMatchObject({
      type: "changed",
      session: { id: "a", revision: 5 },
      writer: "w1",
      base: 4,
    })
    feed.removed("a")
    expect((await watch.next()).value).toEqual({ type: "removed", sessionId: "a" })
    stop.abort()
    expect((await watch.next()).done).toBe(true)
  })

  // A reader that lays its unsent changes over what it reads loses none this way.
  it("gives a slow reader a session once, as it is now, whoever changed it", async () => {
    sessions.clear()
    put("a", 5)
    const feed = new SessionFeed(store)
    const watch = feed.watch(new AbortController().signal)
    await watch.next()
    put("a", 6)
    feed.changed("a", { writer: "b", base: 5 })
    put("a", 7)
    feed.changed("a", { writer: "a", base: 5 })
    expect((await watch.next()).value).toMatchObject({ session: { revision: 7 }, writer: "a" })
  })
})
