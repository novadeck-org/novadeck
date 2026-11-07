import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { conversation, conversations } from "./conversation.js"

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

  it("is unknown with an empty projects folder, or a project that is a link to nowhere", async () => {
    mkdirSync(join(home, ".claude", "projects"), { recursive: true })
    expect(await conversation(install(), id)).toBe("unknown")
    mkdirSync(join(home, ".claude", "projects", "-real"))
    symlinkSync(join(home, "nowhere"), join(home, ".claude", "projects", "-dangling"))
    expect(await conversation(install(), id)).toBe("unknown")
  })

  it("finds a session in the home its transcript names, though the environment names another", async () => {
    const wrapped = join(home, "direnv-home")
    mkdirSync(join(wrapped, "projects", "p"), { recursive: true })
    const transcript = join(wrapped, "projects", "p", `${id}.jsonl`)
    writeFileSync(transcript, "")
    expect(await conversation(install(), id)).toBe("unknown")
    expect(await conversation(install(), id, { transcript })).toBe("found")
    // Moved to another project of that home: the home says, not the old path.
    mkdirSync(join(wrapped, "projects", "q"))
    rmSync(transcript)
    writeFileSync(join(wrapped, "projects", "q", `${id}.jsonl`), "")
    expect(await conversation(install(), id, { transcript })).toBe("found")
    rmSync(join(wrapped, "projects", "q", `${id}.jsonl`))
    expect(await conversation(install(), id, { transcript })).toBe("gone")
  })

  it("reads each project once for a pass over many rows, without stalling the loop", async () => {
    const projects = join(home, ".claude", "projects")
    for (let n = 0; n < 3000; n += 1) mkdirSync(join(projects, `-p${n}`), { recursive: true })
    const ids = Array.from(
      { length: 500 },
      (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    )
    for (const one of ids.slice(0, 250)) writeFileSync(join(projects, "-p7", `${one}.jsonl`), "")
    let worst = 0
    let last = Date.now()
    const watch = setInterval(() => {
      worst = Math.max(worst, Date.now() - last)
      last = Date.now()
    }, 10)
    const started = Date.now()
    const scan = conversations(install())
    const answers = await Promise.all(ids.map((one) => scan.conversation(one)))
    clearInterval(watch)
    expect(answers.filter((one) => one === "found")).toHaveLength(250)
    expect(answers.filter((one) => one === "gone")).toHaveLength(250)
    expect(Date.now() - started).toBeLessThan(8000)
    expect(worst).toBeLessThan(400)
  }, 30_000)
})
