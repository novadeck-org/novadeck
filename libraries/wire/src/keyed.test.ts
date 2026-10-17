import { describe, expect, it } from "vitest"

import { KeyedChanges } from "./keyed.js"

const read = async <T>(changes: KeyedChanges<string, T>, count: number) => {
  const seen: (T | undefined)[] = []
  for (let index = 0; index < count; index += 1)
    // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
    seen.push(await changes.next())
  return seen
}

describe("keyed changes", () => {
  it("reports the current state, then synced, then later changes", async () => {
    const changes = new KeyedChanges<string, string>(
      [
        ["a", "a1"],
        ["b", "b1"],
      ],
      "synced",
    )
    changes.changed("c", "c1")
    expect(await read(changes, 4)).toEqual(["a1", "b1", "synced", "c1"])
  })

  it("keeps only each key's latest unread change, in the order the keys first changed", async () => {
    const changes = new KeyedChanges<string, string>([], "synced")
    changes.changed("a", "a0")
    changes.changed("b", "b1")
    for (let step = 1; step <= 1000; step += 1) changes.changed("a", `a${step}`)
    expect(await read(changes, 3)).toEqual(["synced", "a1000", "b1"])
  })

  it("keeps each key's latest change in its first place, a removal included, behind the current state", async () => {
    const changes = new KeyedChanges<string, string>([["a", "a1"]], "synced")
    changes.changed("b", "b1")
    changes.changed("a", "a2")
    changes.changed("b", "b2")
    changes.removed("a", "a gone")
    expect(await read(changes, 4)).toEqual(["a1", "synced", "b2", "a gone"])
    // A window renamed after it was undocked stays ahead of the item it holds.
    changes.changed("window", "window opened")
    changes.changed("item", "item in window")
    changes.changed("window", "window renamed")
    expect(await read(changes, 2)).toEqual(["window renamed", "item in window"])
  })

  it("reports a removal only of keys the reader was told of", async () => {
    const changes = new KeyedChanges<string, string>([["seen", "seen1"]], "synced")
    changes.changed("unseen", "unseen1")
    changes.removed("unseen", "unseen gone")
    changes.removed("seen", "seen gone")
    expect(await read(changes, 3)).toEqual(["seen1", "synced", "seen gone"])
    // A key the reader no longer knows leaves without a word.
    changes.removed("seen", "seen gone again")
    changes.changed("late", "late1")
    expect(await changes.next()).toBe("late1")
  })

  it("ends a waiting read when finished, and ignores later changes", async () => {
    const changes = new KeyedChanges<string, string>([], "synced")
    await changes.next()
    const pending = changes.next()
    changes.finish()
    changes.changed("late", "late1")
    await expect(pending).resolves.toBeUndefined()
    await expect(changes.next()).resolves.toBeUndefined()
  })
})
