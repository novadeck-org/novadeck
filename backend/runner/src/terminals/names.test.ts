import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { handleCooldown } from "./handles.js"
import { Names, type NamedRecord } from "./names.js"
import type { Saves } from "./saving.js"
import type { Streams } from "./streams.js"

// Sessions s1 and s2 are one project, p; s3 is another, q.
const projects: { [session: string]: string } = { s1: "p", s2: "p", s3: "q" }

type Fake = NamedRecord & { closed: boolean }

const record = (id: string, sessionId: string, handle: string, closed = false): Fake =>
  ({ closed, summary: { id, sessionId, handle } }) as unknown as Fake

const words = ["moth", "fox", "owl", "crow"]

/** Names over the records `held` lists, with no store: the memory-only path. */
const inMemory = (held: Fake[] = [], cooldown = 1_000) => {
  const names = new Names<Fake>(
    { handleOrder: () => words, handleCooldown: cooldown },
    {} as Saves,
    {} as Streams<Fake>,
    {
      stopping: () => false,
      records: () => held,
      record: (id) => held.find((each) => each.summary.id === id),
      projectOf: (sessionId) => projects[sessionId] ?? sessionId,
      announce: () => undefined,
    },
  )
  return { names, held }
}

afterEach(() => vi.useRealTimers())

describe("the handles Names gives without records", () => {
  it("gives a project's sessions different words, and another project its own", () => {
    const { names } = inMemory()
    expect(names.next("s1")).toBe("moth")
    expect(names.next("s2")).toBe("fox")
    expect(names.next("s1")).toBe("owl")
    expect(names.next("s3")).toBe("moth")
  })

  it("holds a handle for a record that is closing, until it is removed", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(10_000)
    const { names, held } = inMemory()
    expect(names.next("s1")).toBe("moth")
    held.push(record("a", "s1", "moth", true))
    expect(names.next("s1")).toBe("fox")
    // The record leaves when its shell has ended, and the handle rests from then.
    held.length = 0
    names.release("s1", "moth", "a")
    vi.setSystemTime(10_500)
    expect(names.next("s1")).toBe("owl")
    expect(names.next("s1")).toBe("crow")
    // Every word is held or resting, so the words come again with a letter.
    expect(names.next("s1")).toBe("mothz")
    vi.setSystemTime(11_000)
    expect(names.next("s1")).toBe("moth")
  })

  it("lets a restore take its own handle back during its own cooldown, not another's", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(10_000)
    const { names } = inMemory()
    const moth = names.next("s1")
    names.release("s1", moth, "a")
    expect(names.claim("s2", moth, "b")).toBe(false)
    expect(names.claim("s2", moth, "a")).toBe(true)
    // Held again, resting from the claim for any other terminal.
    expect(names.claim("s1", moth, "c")).toBe(false)
    expect(names.claim("s3", moth, "c")).toBe(true)
  })

  it("hands a freed handle on after an hour when the cooldown is not set", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(0)
    const names = new Names<Fake>(
      { handleOrder: () => ["moth"] },
      {} as Saves,
      {} as Streams<Fake>,
      {
        stopping: () => false,
        records: () => [],
        record: () => undefined,
        projectOf: (sessionId) => sessionId,
        announce: () => undefined,
      },
    )
    expect(names.next("s")).toBe("moth")
    names.release("s", "moth", "a")
    expect(names.next("s")).toBe("mothz")
    vi.setSystemTime(handleCooldown - 1)
    expect(names.next("s")).toBe("mothy")
    vi.setSystemTime(handleCooldown)
    expect(names.next("s")).toBe("moth")
  })

  it("rests a handle from when its terminal first freed it, though it lets go again", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(0)
    const names = new Names<Fake>(
      { handleOrder: () => ["moth"] },
      {} as Saves,
      {} as Streams<Fake>,
      {
        stopping: () => false,
        records: () => [],
        record: () => undefined,
        projectOf: (sessionId) => sessionId,
        announce: () => undefined,
      },
    )
    expect(names.next("s")).toBe("moth")
    names.release("s", "moth", "a")
    vi.setSystemTime(handleCooldown - 1)
    names.release("s", "moth", "a")
    vi.setSystemTime(handleCooldown)
    expect(names.next("s")).toBe("moth")
  })

  it("orders terminals by when they were given, a reused handle last", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(0)
    const { names } = inMemory()
    const given = words.map(() => names.next("s1"))
    expect(given).toEqual(words)
    names.release("s1", "moth", "a")
    vi.setSystemTime(5_000)
    expect(names.next("s1")).toBe("moth")
    const order = ["moth", "crow", "fox", "owl"].toSorted(
      (a, b) => names.order("s1", a) - names.order("s1", b),
    )
    expect(order).toEqual(["fox", "owl", "crow", "moth"])
    expect(names.givenAt("s1", "moth")).toBe(5_000)
    expect(names.givenAt("s1", "fox")).toBe(0)
    // Another project's order is its own.
    expect(names.order("s3", "moth")).toBe(-1)
  })

  it("keeps when a handle was given across a terminal taking its own back, not for another", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1_000)
    const { names } = inMemory()
    const moth = names.next("s1")
    names.release("s1", moth, "a")
    vi.setSystemTime(2_000)
    expect(names.claim("s2", moth, "a")).toBe(true)
    expect(names.givenAt("s2", moth)).toBe(1_000)
    // Given to another terminal after its rest, it is given afresh.
    names.release("s2", moth, "a")
    vi.setSystemTime(2_000 + 2_000)
    expect(names.claim("s2", moth, "b")).toBe(true)
    expect(names.givenAt("s2", moth)).toBe(4_000)
  })

  it("counts the closing record of the terminal taking its own handle back as nothing", () => {
    const { names, held } = inMemory()
    const moth = names.next("s1")
    held.push(record("a", "s1", moth, true))
    names.release("s1", moth, "a")
    // Its shell is still ending, but the restore is of that very terminal.
    expect(names.claim("s2", moth, "b")).toBe(false)
    expect(names.claim("s2", moth, "a")).toBe(true)
  })

  it("rests the handle of a terminal that exited or was let go without a release, from when it is noticed", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(0)
    const { names, held } = inMemory()
    const moth = names.next("s1")
    held.push(record("a", "s1", moth))
    // Seen held by its record, as is the next, which goes to a terminal.
    const fox = names.next("s1")
    held.push(record("b", "s1", fox))
    held.splice(0, 1)
    vi.setSystemTime(5_000)
    // Each drawn handle goes to a terminal, which holds it.
    const others = [names.next("s1"), names.next("s1")]
    expect(others).toEqual(["owl", "crow"])
    others.forEach((handle, index) => held.push(record(`o${index}`, "s1", handle)))
    // It rests from the look that noticed it gone, not from when it was given.
    vi.setSystemTime(5_000 + 999)
    expect(names.next("s1")).toBe("mothz")
    vi.setSystemTime(5_000 + 1_000)
    expect(names.next("s1")).toBe("moth")
  })

  it("drops a project's handles with it", () => {
    const { names } = inMemory()
    names.next("s1")
    names.forgetProject("p")
    expect(names.next("s1")).toBe("moth")
  })
})

describe("the handles Names gives from the store", () => {
  const stored = (held: Fake[] = []) => {
    const store = new WorkspaceStore()
    store["database"].exec("INSERT INTO projects (id, name, cwd) VALUES ('p', 'P', '/p')")
    store["database"].exec(
      "INSERT INTO sessions (id, project_id, name) VALUES ('s1', 'p', 'One'), ('s2', 'p', 'Two')",
    )
    const saves = {
      giveHandle: (...args: Parameters<WorkspaceStore["giveHandle"]>) => store.giveHandle(...args),
      claimHandle: (...args: Parameters<WorkspaceStore["claimHandle"]>) =>
        store.claimHandle(...args),
      releaseHandle: (...args: Parameters<WorkspaceStore["releaseHandle"]>) =>
        store.releaseHandle(...args),
      handleGivenAt: (...args: Parameters<WorkspaceStore["handleGivenAt"]>) =>
        store.handleGivenAt(...args),
    } as unknown as Saves
    const names = new Names<Fake>(
      { records: store, handleOrder: () => words, handleCooldown: 1_000 },
      saves,
      {} as Streams<Fake>,
      {
        stopping: () => false,
        records: () => held,
        record: () => undefined,
        projectOf: (sessionId) => projects[sessionId] ?? sessionId,
        announce: () => undefined,
      },
    )
    return { names, store, held }
  }

  it("holds the handle of a record whose row is gone, as a terminal closing is", () => {
    const { names, store, held } = stored([record("a", "s2", "moth", true)])
    // Its row went when the close began; the record stays until its shell ends.
    expect(store.terminals()).toEqual([])
    expect(names.next("s1")).toBe("fox")
    held.length = 0
    expect(names.claim("s1", "moth", "z")).toBe(true)
  })

  it("takes no account of the record of the very terminal taking its handle back", () => {
    const { names, held } = stored([record("a", "s2", "moth", true)])
    expect(names.claim("s1", "moth", "b")).toBe(false)
    held.push()
    expect(names.claim("s1", "moth", "a")).toBe(true)
  })

  it("gives a handle drawn for a create to nobody else for a cooldown, whether or not it ends", () => {
    const { names } = stored()
    const drawn = names.next("s1")
    expect(names.next("s2")).not.toBe(drawn)
    // A create that failed never releases it: it rests from the draw.
    expect(names.claim("s2", drawn, "other")).toBe(false)
    expect(names.givenAt("s1", drawn)).toBeGreaterThan(0)
  })
})
