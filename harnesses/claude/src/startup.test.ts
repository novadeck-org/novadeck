import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { hooksTrusted } from "./startup.js"

let root: string
let home: string
let project: string
// Managed settings live under Program Files on Windows, which the environment moves.
let programFiles: string

const write = (path: string, settings: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(settings))
}

const user = (settings: unknown) => write(join(home, ".claude", "settings.json"), settings)
const shared = (settings: unknown) => write(join(project, ".claude", "settings.json"), settings)
const local = (settings: unknown) =>
  write(join(project, ".claude", "settings.local.json"), settings)
const managed = (settings: unknown) =>
  write(join(programFiles, "ClaudeCode", "managed-settings.json"), settings)

const trusted = () =>
  hooksTrusted(
    { env: { ProgramFiles: programFiles }, home, platform: "win32", plugin: "" },
    project,
  )

const enabled = { enabledPlugins: { "novadeck@novadeck": true } }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-startup-"))
  home = join(root, "home")
  project = join(root, "project")
  programFiles = join(root, "Program Files")
  mkdirSync(project, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("whether Claude Code's settings let Novadeck's hooks run", () => {
  it("does with the plugin enabled and nothing turning hooks off", async () => {
    user(enabled)
    expect(await trusted()).toBe(true)
  })

  it("doesn't where the person's settings turn every hook off", async () => {
    user({ ...enabled, disableAllHooks: true })
    expect(await trusted()).toBe(false)
  })

  it("doesn't where the project's settings turn the plugin off", async () => {
    user(enabled)
    shared({ enabledPlugins: { "novadeck@novadeck": false } })
    expect(await trusted()).toBe(false)
  })

  it("takes the scope that decides: local over the project's over the person's", async () => {
    user({ ...enabled, disableAllHooks: true })
    shared({ disableAllHooks: false })
    expect(await trusted()).toBe(true)
    local({ disableAllHooks: true })
    expect(await trusted()).toBe(false)
    local({ enabledPlugins: { "novadeck@novadeck": true } })
    shared({ disableAllHooks: false, enabledPlugins: { "novadeck@novadeck": false } })
    expect(await trusted()).toBe(true)
  })

  it("doesn't where managed settings turn hooks off or allow only their own", async () => {
    user(enabled)
    managed({ disableAllHooks: true })
    expect(await trusted()).toBe(false)
    managed({ allowManagedHooksOnly: true })
    expect(await trusted()).toBe(false)
    managed({})
    expect(await trusted()).toBe(true)
  })

  it("reads a file it can't parse as Claude Code does: as none", async () => {
    user(enabled)
    shared({})
    writeFileSync(join(project, ".claude", "settings.json"), "{ not json")
    expect(await trusted()).toBe(true)
  })
})
