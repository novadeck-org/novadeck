import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"
import { z } from "zod"

import { describe, expect, it } from "../test.js"
import { latestMs, latestRelease } from "./install.js"

const version = z.strictObject({ version: z.string() })

// A cache of its own for each test, and a lookup that counts how often it was asked.
const folders: string[] = []
const record = () => {
  const folder = mkdtempSync(join(tmpdir(), "novadeck-latest-"))
  folders.push(folder)
  return join(folder, "claude.latest")
}
const lookup = (found: string) => {
  const asked = { count: 0 }
  const look = async () => {
    asked.count += 1
    return { version: found }
  }
  return { asked, look }
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe("latestRelease", () => {
  it("looks the newest release up once, and a later run within the hour reads it back", async () => {
    const file = record()
    const first = lookup("2.2.0")
    const later = lookup("2.3.0")

    await expect(latestRelease(file, version, first.look, 1000)).resolves.toEqual({
      version: "2.2.0",
    })
    await expect(latestRelease(file, version, later.look, 1000 + latestMs - 1)).resolves.toEqual({
      version: "2.2.0",
    })
    expect([first.asked.count, later.asked.count]).toEqual([1, 0])
  })

  it("looks again once the record is an hour old, and keeps what it found", async () => {
    const file = record()
    await latestRelease(file, version, lookup("2.2.0").look, 1000)
    const again = lookup("2.3.0")

    await expect(latestRelease(file, version, again.look, 1000 + latestMs)).resolves.toEqual({
      version: "2.3.0",
    })
    expect(again.asked.count).toBe(1)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      at: 1000 + latestMs,
      release: { version: "2.3.0" },
    })
  })

  it("never trusts a record it can't read, or whose version isn't safe in a path", async () => {
    const file = record()
    for (const written of [
      "not JSON",
      JSON.stringify({ at: 1000, release: { version: "../x" } }),
    ]) {
      writeFileSync(file, written)
      const again = lookup("2.3.0")

      // eslint-disable-next-line no-await-in-loop -- One record at a time.
      await expect(latestRelease(file, version, again.look, 1000)).resolves.toEqual({
        version: "2.3.0",
      })
      expect(again.asked.count).toBe(1)
    }
  })
})
