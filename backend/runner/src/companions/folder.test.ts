import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { FolderWatch, loadFolder } from "./folder.js"

const roots: string[] = []
const folder = (): string => {
  const made = mkdtempSync(join(tmpdir(), "novadeck-folder-watch-"))
  roots.push(made)
  return made
}
afterEach(() => {
  for (const made of roots.splice(0)) rmSync(made, { recursive: true, force: true })
})

// Polls far longer than a test, so only the watch, or its start, ends a wait.
const polls = { safety: 600_000, unwatched: 600_000 }
// How long a wait took, in milliseconds, or undefined if it hadn't ended by `within`.
const waited = async (watch: FolderWatch, within: number): Promise<number | undefined> => {
  const controller = new AbortController()
  const began = Date.now()
  let ended: number | undefined
  const wait = watch.wait(polls, controller.signal).then(() => {
    if (!controller.signal.aborted) ended = Date.now() - began
  })
  await new Promise((resolve) => setTimeout(resolve, within))
  controller.abort()
  await wait
  return ended
}

describe("a folder's watch", () => {
  it("reads a folder again a moment after it starts watching, as a watch may start late", async () => {
    const watch = new FolderWatch()
    try {
      watch.follow(folder())
      const first = await waited(watch, 3_000)
      expect(first).toBeDefined()
      expect(first!).toBeLessThan(2_000)
      // Once only: the next wait is the watch's, or the poll's.
      expect(await waited(watch, 2_500)).toBeUndefined()
    } finally {
      watch.close()
    }
  })

  it("waits for no start where the watch has told of a change", async () => {
    const dir = folder()
    const watch = new FolderWatch()
    try {
      watch.follow(dir)
      writeFileSync(join(dir, "one.png"), "1")
      // Told before any wait: the watch has started, so no later wait ends at its start.
      await new Promise((resolve) => setTimeout(resolve, 300))
      // Told: the wait ends a settle after the change.
      expect(await waited(watch, 3_000)).toBeDefined()
      expect(await waited(watch, 2_500)).toBeUndefined()
    } finally {
      watch.close()
    }
  })

  it("reads again a moment after it moves onto a folder made anew", async () => {
    const watch = new FolderWatch()
    try {
      watch.follow(folder(), "1:1")
      await waited(watch, 1_500)
      watch.follow(folder(), "2:2")
      expect(await waited(watch, 3_000)).toBeDefined()
    } finally {
      watch.close()
    }
  })
})

describe("a folder's steps", () => {
  it("never lists one that may hold secrets by the name it is reached by", async () => {
    const top = folder()
    mkdirSync(join(top, "keys"))
    writeFileSync(join(top, "keys", "id_work"), "KEY\n")
    symlinkSync(join(top, "keys"), join(top, ".ssh"))
    await expect(loadFolder({ path: top }, ".ssh", {})).resolves.toMatchObject({
      content: { state: "unavailable", reason: "secret" },
    })
    await expect(loadFolder({ path: top }, "keys", {})).resolves.toMatchObject({
      content: { state: "ready" },
    })
  })
})

describe("a folder's links", () => {
  it("are held by a name they lead through on the way, in the listing and as a step", async () => {
    const top = folder()
    mkdirSync(join(top, "config"))
    mkdirSync(join(top, "keys"))
    writeFileSync(join(top, "config", "dev.vars"), "STRIPE_KEY=x\n")
    writeFileSync(join(top, "keys", "id_work"), "KEY\n")
    symlinkSync(join(top, "config", "dev.vars"), join(top, ".env"))
    symlinkSync(join(top, ".env"), join(top, "notes.txt"))
    symlinkSync(join(top, "keys"), join(top, ".ssh"))
    symlinkSync(join(top, ".ssh"), join(top, "stuff"))
    const listed = await loadFolder({ path: top }, "", {})
    const entries =
      listed.content.state === "ready" && listed.content.content.kind === "folder"
        ? listed.content.content.entries
        : []
    const held = Object.fromEntries(entries.map(({ name, secret }) => [name, secret]))
    expect(held).toMatchObject({ "notes.txt": true, stuff: true, config: false, keys: false })
    await expect(loadFolder({ path: top }, "stuff", {})).resolves.toMatchObject({
      content: { state: "unavailable", reason: "secret" },
    })
  })
})
