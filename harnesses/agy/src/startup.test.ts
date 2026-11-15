import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { hooksTrusted } from "./startup.js"

let home: string
const config = () => join(home, ".gemini", "config")
const trusted = () => hooksTrusted({ env: {}, home, platform: "linux", plugin: "" }, home)

const plugin = (manifest: unknown) => {
  mkdirSync(join(config(), "plugins", "novadeck"), { recursive: true })
  writeFileSync(join(config(), "plugins", "novadeck", "plugin.json"), JSON.stringify(manifest))
}
const settings = (value: unknown) => {
  mkdirSync(config(), { recursive: true })
  writeFileSync(join(config(), "config.json"), JSON.stringify(value))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agy-startup-"))
  plugin({ name: "novadeck" })
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

describe("whether Antigravity loads Novadeck's plugin", () => {
  it("does with no entry of the person's", async () => {
    expect(await trusted()).toBe(true)
  })

  // As `agy plugin disable novadeck` writes it (probed 2026-11-15, 1.5.7).
  it("doesn't once the person disabled it", async () => {
    settings({ plugins: { novadeck: { enabled: false } } })
    expect(await trusted()).toBe(false)
    settings({ plugins: { novadeck: { enabled: true } } })
    expect(await trusted()).toBe(true)
  })

  it("follows the plugin's own declaration where the person made no choice", async () => {
    plugin({ name: "novadeck", disabled: true })
    expect(await trusted()).toBe(false)
    settings({ plugins: { novadeck: { enabled: true } } })
    expect(await trusted()).toBe(true)
  })
})
