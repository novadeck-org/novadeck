import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { conversation } from "./conversation.js"

const id = "5f1c1d1e-8a4b-4c1d-9e2f-0a1b2c3d4e5f"
let home = ""
const install = (env: NodeJS.ProcessEnv = {}) => ({
  env,
  home,
  platform: process.platform,
  plugin: "",
})
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claude-conversation-"))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("Claude Code's conversation", () => {
  it("is found in whichever project folder holds its transcript", async () => {
    mkdirSync(join(home, ".claude", "projects", "-work-a"), { recursive: true })
    mkdirSync(join(home, ".claude", "projects", "-work-b"), { recursive: true })
    writeFileSync(join(home, ".claude", "projects", "-work-b", `${id}.jsonl`), "")
    expect(await conversation(install(), id)).toBe("found")
  })

  it("is gone when no project holds it, and unknown with no projects folder at all", async () => {
    expect(await conversation(install(), id)).toBe("unknown")
    mkdirSync(join(home, ".claude", "projects", "-work-a"), { recursive: true })
    writeFileSync(join(home, ".claude", "projects", "stray.txt"), "")
    expect(await conversation(install(), id)).toBe("gone")
  })

  it("follows CLAUDE_CONFIG_DIR, and reads an id that is no file name as unknown", async () => {
    const moved = join(home, "moved")
    mkdirSync(join(moved, "projects", "p"), { recursive: true })
    writeFileSync(join(moved, "projects", "p", `${id}.jsonl`), "")
    expect(await conversation(install({ CLAUDE_CONFIG_DIR: moved }), id)).toBe("found")
    expect(await conversation(install({ CLAUDE_CONFIG_DIR: moved }), "../p")).toBe("unknown")
  })
})
