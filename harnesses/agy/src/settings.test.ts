import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Install } from "@novadeck/harness-core/harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { statusLineCommand, statusLineSettings } from "./settings.js"

// A rename that fails, as Windows' does while Antigravity holds the file open.
const failing = vi.hoisted(() => ({ rename: false }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) =>
      failing.rename
        ? Promise.reject(Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }))
        : actual.rename(...args),
  }
})

let root: string
let install: Install
let settings: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "novadeck-agy-settings-"))
  install = { env: {}, home: root, platform: "linux", plugin: join(root, "plugin") }
  const folder = join(root, ".gemini", "antigravity-cli")
  mkdirSync(folder, { recursive: true })
  settings = join(folder, "settings.json")
})
afterEach(() => {
  failing.rename = false
  rmSync(root, { recursive: true, force: true })
})

const statusLine = (file: string) =>
  (JSON.parse(readFileSync(file, "utf8")) as { statusLine?: { command?: string } }).statusLine

describe("Antigravity's settings, as Novadeck writes them", () => {
  it.skipIf(process.platform === "win32")(
    "write through a link to the file it names, which keeps the link",
    async () => {
      // As stow, chezmoi or home-manager leave it: the settings a link to a dotfile.
      const dotfiles = join(root, "dotfiles")
      mkdirSync(dotfiles)
      const real = join(dotfiles, "settings.json")
      writeFileSync(real, JSON.stringify({ theme: "dark" }))
      symlinkSync(real, settings)
      await statusLineSettings.apply(install)
      expect(lstatSync(settings).isSymbolicLink()).toBe(true)
      expect(statusLine(real)?.command).toBe(statusLineCommand(undefined))
      await statusLineSettings.revert(install)
      expect(lstatSync(settings).isSymbolicLink()).toBe(true)
      expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ theme: "dark" })
      // Nothing is left beside either.
      expect(readdirSync(dotfiles)).toEqual(["settings.json"])
    },
  )

  it.skipIf(process.platform === "win32")(
    "write a link to nothing yet as the file it names",
    async () => {
      const dotfiles = join(root, "dotfiles")
      mkdirSync(dotfiles)
      symlinkSync(join("..", "..", "dotfiles", "settings.json"), settings)
      await statusLineSettings.apply(install)
      expect(lstatSync(settings).isSymbolicLink()).toBe(true)
      expect(statusLine(join(dotfiles, "settings.json"))?.command).toBe(
        statusLineCommand(undefined),
      )
    },
  )

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "say so where a link names a file they can't write, and leave both as they were",
    async () => {
      // As home-manager links into its read-only store.
      const store = join(root, "store")
      mkdirSync(store)
      const real = join(store, "settings.json")
      writeFileSync(real, "{}")
      symlinkSync(real, settings)
      chmodSync(store, 0o555)
      try {
        await expect(statusLineSettings.apply(install)).rejects.toThrow(/links to .*can't write/)
      } finally {
        chmodSync(store, 0o755)
      }
      expect(lstatSync(settings).isSymbolicLink()).toBe(true)
      expect(readdirSync(store)).toEqual(["settings.json"])
      expect(readFileSync(real, "utf8")).toBe("{}")
    },
  )

  it.skipIf(process.platform === "win32")("keep the mode the file had", async () => {
    writeFileSync(settings, "{}")
    chmodSync(settings, 0o644)
    await statusLineSettings.apply(install)
    expect(statSync(settings).mode & 0o777).toBe(0o644)
    expect(statusLine(settings)?.command).toBe(statusLineCommand(undefined))
  })

  it.skipIf(process.platform === "win32")("make a new file the person's alone", async () => {
    await statusLineSettings.apply(install)
    expect(statSync(settings).mode & 0o777).toBe(0o600)
  })

  it("leave no file of their own behind when the write fails, and the settings as they were", async () => {
    writeFileSync(settings, JSON.stringify({ theme: "dark" }))
    failing.rename = true
    await expect(statusLineSettings.apply(install)).rejects.toThrow(/EBUSY/)
    expect(readdirSync(join(root, ".gemini", "antigravity-cli"))).toEqual(["settings.json"])
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ theme: "dark" })
  })
})
