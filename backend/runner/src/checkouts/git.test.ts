import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { git, waitAfter } from "./git.js"

describe("how long a change waits to be read again", () => {
  it("is the usual wait for fast reads, longer for slow ones, and never more than 15 s", () => {
    expect(waitAfter(50, 2000)).toBe(2000)
    expect(waitAfter(1000, 2000)).toBe(2000)
    expect(waitAfter(1500, 2000)).toBe(6000)
    expect(waitAfter(60_000, 2000)).toBe(15_000)
  })
})

describe.skipIf(process.platform === "win32")("a git run that takes too long", () => {
  // An alias that runs a shell, which on SIGTERM writes a marker (as git removes its locks).
  const slow = (marker: string) => [
    "-c",
    `alias.slow=!trap 'touch ${marker}; exit 0' TERM; sleep 30 & wait`,
    "slow",
  ]

  it("is asked to stop first when it has a grace, so it can clean up", async () => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-grace-"))
    try {
      const marker = join(folder, "term")
      const run = await git(folder, slow(marker), { cap: 1024, ms: 100, graceMs: 5000 })
      expect(run).toMatchObject({ ok: false, kind: "timeout" })
      expect(existsSync(marker)).toBe(true)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it("is killed at the grace's end if it ignores that", async () => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-grace-"))
    try {
      const args = ["-c", "alias.stubborn=!trap '' TERM; sleep 30", "stubborn"]
      const started = Date.now()
      const run = await git(folder, args, { cap: 1024, ms: 100, graceMs: 300 })
      expect(run).toMatchObject({ ok: false, kind: "timeout" })
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
