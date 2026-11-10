import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { RememberedSaves, type Remembered } from "./memory.js"

const it = base.extend<{ folder: string }>({
  folder: async ({ resources }, use) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-works-memory-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5 }))
    await use(folder)
  },
})

const mark = (at: number): ReadonlyMap<string, Remembered> =>
  new Map([["/repo", { firstSeenAt: at, watermark: null }]])

describe("saving what works remember", () => {
  it("writes the latest of many requests, leaving no temporary file, and settles after it", async ({
    folder,
  }) => {
    const path = join(folder, "works.json")
    const saves = new RememberedSaves(path)
    for (let at = 1; at <= 20; at += 1) saves.save(mark(at))
    await saves.settled()
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      roots: { "/repo": { firstSeenAt: 20, watermark: null } },
    })
    expect(readdirSync(folder)).toEqual(["works.json"])
  })

  it("writes again after it has settled", async ({ folder }) => {
    const path = join(folder, "works.json")
    const saves = new RememberedSaves(path)
    saves.save(mark(1))
    await saves.settled()
    saves.save(mark(2))
    await saves.settled()
    expect(readFileSync(path, "utf8")).toContain('"firstSeenAt":2')
  })
})
