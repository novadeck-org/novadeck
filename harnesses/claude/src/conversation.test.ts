import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { conversation, conversations } from "./conversation.js"

// How many folders were listed, and how many at once at most: what a pass over many rows is
// judged by, rather than by the seconds it took, which a loaded CI runner decides.
const reads = vi.hoisted(() => ({ count: 0, open: 0, most: 0 }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      reads.count += 1
      reads.open += 1
      reads.most = Math.max(reads.most, reads.open)
      try {
        return await actual.readdir(...args)
      } finally {
        reads.open -= 1
      }
    },
  }
})

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

  it("reads each project once for a pass over many rows, a few at a time", async () => {
    const projects = join(home, ".claude", "projects")
    const folders = 300
    for (let n = 0; n < folders; n += 1) mkdirSync(join(projects, `-p${n}`), { recursive: true })
    const ids = Array.from(
      { length: 500 },
      (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    )
    for (const one of ids.slice(0, 250)) writeFileSync(join(projects, "-p7", `${one}.jsonl`), "")
    reads.count = 0
    reads.most = 0
    const scan = conversations(install())
    const answers = await Promise.all(ids.map((one) => scan.conversation(one)))
    expect(answers.filter((one) => one === "found")).toHaveLength(250)
    expect(answers.filter((one) => one === "gone")).toHaveLength(250)
    // The projects folder once, then each project once, for all 500 rows together.
    expect(reads.count).toBe(folders + 1)
    // The reader's pool, so a long list never queues every folder at the event loop at once.
    expect(reads.most).toBeGreaterThan(1)
    expect(reads.most).toBeLessThanOrEqual(32)
  })
})
