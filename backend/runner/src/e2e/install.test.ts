import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"
import { z } from "zod"

import { describe, expect, it } from "../test.js"
import { latestMs, latestRelease, pins, renameHeld } from "./install.js"

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

  it("keeps an old record when the lookup fails, as a run without the network does", async () => {
    const file = record()
    await latestRelease(file, version, lookup("2.2.0").look, 1000)
    const failing = async () => {
      throw new Error("getaddrinfo EAI_AGAIN")
    }

    await expect(latestRelease(file, version, failing, 1000 + latestMs * 80)).resolves.toEqual({
      version: "2.2.0",
    })
    // With no record to keep, the failure stands.
    await expect(latestRelease(record(), version, failing, 1000)).rejects.toThrow("EAI_AGAIN")
  })
})

describe("moving a staged install into place", () => {
  const failing = (codes: readonly (string | undefined)[]) => {
    const tries: string[] = []
    const move = async (from: string, to: string): Promise<void> => {
      tries.push(`${from}->${to}`)
      const code = codes[tries.length - 1]
      if (code !== undefined) throw Object.assign(new Error(code), { code })
    }
    const waits: number[] = []
    const wait = async (ms: number): Promise<void> => void waits.push(ms)
    return { move, wait, tries, waits }
  }

  it("tries again, a little later each time, while Windows holds the files", async () => {
    const { move, wait, tries, waits } = failing(["EPERM", "EBUSY", "EACCES", undefined])
    await renameHeld("a.tmp", "a", move, wait)
    expect(tries).toHaveLength(4)
    expect(waits).toEqual([250, 500, 750])
  })

  it("gives up after a few tries, and at once on any other failure", async () => {
    const held = failing(Array.from({ length: 8 }, () => "EPERM"))
    await expect(renameHeld("a.tmp", "a", held.move, held.wait)).rejects.toThrow("EPERM")
    expect(held.tries).toHaveLength(8)
    const other = failing(["ENOENT"])
    await expect(renameHeld("a.tmp", "a", other.move, other.wait)).rejects.toThrow("ENOENT")
    expect(other.tries).toHaveLength(1)
  })
})

describe("the programs a harness fetches for itself", () => {
  it("pin pi's fd for every platform the tests run on, an archive of a version with its checksum", () => {
    const pin = pins.pi
    const fd = pin && "tools" in pin ? pin.tools?.fd : undefined
    expect(Object.keys(fd?.releases ?? {}).toSorted()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "win32-x64",
    ])
    for (const release of Object.values(fd?.releases ?? {})) {
      expect(release.archive).toContain(`/v${fd!.version}/`)
      expect(release.member).toMatch(/[\\/]fd(?:\.exe)?$/)
    }
  })
})
