import type { Approval } from "@novadeck/protocol"

import { PageLooks } from "../companions/looks.js"
import { describe, expect, it } from "../test.js"
import { Approvals } from "./approvals.js"
import { ClientWindows } from "./client-windows.js"
import { Followers } from "./followers.js"
import { OpenRequests } from "./opens.js"

// Session s1 belongs to project p1, s2 to p2; any other session is no one's.
const projects: Record<string, string> = { s1: "p1", s2: "p2" }
const windows = () =>
  new ClientWindows((sessionId) => {
    const project = projects[sessionId]
    if (project === undefined) throw new Error("unknown session")
    return project
  })

const opener = { by: "id-moth", handle: "moth", leads: false }
const open = (sessionId: string) => ({
  sessionId,
  from: "id-moth",
  cwd: "/work",
  focus: true,
})

describe("the client an agent's request goes to", () => {
  it("is the one that shows the asking terminal's project, though another connected later", async () => {
    const clients = windows()
    clients.report("first", "p1")
    clients.report("second", "p2")
    const opens = new OpenRequests(() => clients)
    const first = opens.follow("first")
    const second = opens.follow("second")
    const reads = [
      first.next().then((read) => ["first", read.value] as const),
      second.next().then((read) => ["second", read.value] as const),
    ]
    void opens.request(open("s1"), 1_000, opener)
    const [client, request] = await Promise.race(reads)
    expect(client).toBe("first")
    expect(request).toMatchObject({ sessionId: "s1" })
    opens.finish()
  })

  it("is the one used last when none shows the project", async () => {
    const clients = windows()
    clients.report("first", "p2")
    clients.report("second", "p2")
    clients.touch("first")
    const followers = new Followers<number>()
    const controller = new AbortController()
    void followers.follow("first", () => {}, controller.signal).next()
    void followers.follow("second", () => {}, controller.signal).next()
    expect(followers.newest(clients.choosing("s1"))?.owner).toBe("first")
    controller.abort()
  })

  it("is the newest when no client says which project it shows", () => {
    const clients = windows()
    const followers = new Followers<number>()
    const controller = new AbortController()
    void followers.follow("old", () => {}, controller.signal).next()
    void followers.follow("new", () => {}, controller.signal).next()
    expect(followers.newest(clients.choosing("s1"))?.owner).toBe("new")
    controller.abort()
  })

  it("is the newest where the session belongs to no project", () => {
    const clients = windows()
    clients.report("old", "p1")
    const followers = new Followers<number>()
    const controller = new AbortController()
    void followers.follow("old", () => {}, controller.signal).next()
    void followers.follow("new", () => {}, controller.signal).next()
    // Only a client that said something is preferred, and then only among them.
    expect(followers.newest(clients.choosing("unknown"))?.owner).toBe("old")
    clients.release("old")
    expect(followers.newest(clients.choosing("unknown"))?.owner).toBe("new")
    controller.abort()
  })

  it("stops being preferred once the client says it shows no project", () => {
    const clients = windows()
    clients.report("a", "p1")
    clients.report("b", "p2")
    clients.report("a", null)
    expect(clients.choosing("s1")(["a", "b"])).toBe("b")
  })

  it("lapses with the client: a client that has gone is no longer preferred", () => {
    const clients = windows()
    clients.report("a", "p1")
    clients.report("b", "p2")
    clients.release("a")
    expect(clients.choosing("s1")(["a", "b"])).toBe("b")
  })

  it("is told of a project that is shown, not of one whose report came before the client reported", () => {
    const clients = windows()
    clients.touch("never-reported")
    expect(clients.choosing("s1")(["never-reported"])).toBeUndefined()
  })
})

describe("an approval's client", () => {
  it("is the one that shows the project of the terminal it is about", async () => {
    const clients = windows()
    clients.report("showing", "p1")
    clients.report("newer", "p2")
    const approvals = new Approvals(() => clients)
    const reads: Approval[] = []
    const stream = approvals.follow("showing")
    void (async () => {
      for await (const item of stream) reads.push(item)
    })()
    const other = approvals.follow("newer")
    void other.next()
    approvals.request(
      { from: "caller", terminalId: "target", sessionId: "s1", action: { type: "close" } },
      () => {},
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(reads).toHaveLength(1)
    approvals.finish()
  })
})

describe("a look at a page's client", () => {
  it("is the one that shows the project of the terminal the page is beside", async () => {
    const clients = windows()
    clients.report("showing", "p1")
    clients.report("newer", "p2")
    const looks = new PageLooks(() => clients)
    const seen: string[] = []
    for (const owner of ["showing", "newer"])
      void (async () => {
        for await (const look of looks.follow(owner)) seen.push(`${owner}:${look.itemId}`)
      })()
    void looks.ask({ itemId: "page", shown: 1, url: "http://127.0.0.1:3000/" }, 50, "s1")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen).toEqual(["showing:page"])
    looks.finish()
  })
})
