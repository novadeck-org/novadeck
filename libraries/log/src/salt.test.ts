import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { loadSalt } from "./salt.js"

const folders: string[] = []
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true })
})

const saltFile = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "novadeck-salt-"))
  folders.push(folder)
  return join(folder, "data", "log-salt")
}

describe("loadSalt", () => {
  it("makes a salt the first time and keeps it", () => {
    const file = saltFile()
    const salt = loadSalt(file)
    expect(salt).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(file, "utf8")).toBe(salt)
    expect(loadSalt(file)).toBe(salt)
  })

  it("replaces a file that holds no salt", () => {
    const file = saltFile()
    loadSalt(file)
    writeFileSync(file, "garbage")
    const salt = loadSalt(file)
    expect(salt).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(file, "utf8")).toBe(salt)
  })
})
