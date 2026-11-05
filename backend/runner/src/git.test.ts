import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { gitEnv, gitPath } from "./git.js"
import { describe, expect, it } from "./test.js"

describe("the git the runner runs", () => {
  it("is found once installed, though an earlier look found none", ({ resources }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-git-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const env = { PATH: folder }
    expect(gitPath(env)).toBeUndefined()
    const git = join(folder, process.platform === "win32" ? "git.exe" : "git")
    writeFileSync(git, "", { mode: 0o755 })
    expect(gitPath(env)).toBe(git)
  })
})

describe("the environment git runs in", () => {
  it("drops what would point git elsewhere, and keeps the rest of the person's", () => {
    const saved = { ...process.env }
    Object.assign(process.env, {
      GIT_DIR: "/elsewhere",
      GIT_INDEX_FILE: "/x",
      GIT_CONFIG_COUNT: "1",
      GIT_EXTERNAL_DIFF: "/bin/true",
      GIT_CEILING_DIRECTORIES: "/ceiling",
      GIT_EXEC_PATH: "/exec",
      GIT_LITERAL_PATHSPECS: "1",
    })
    try {
      const env = gitEnv()
      // Literal pathspecs too: check-ignore refuses them, and the diff reader sets its own.
      for (const name of [
        "GIT_DIR",
        "GIT_INDEX_FILE",
        "GIT_CONFIG_COUNT",
        "GIT_EXTERNAL_DIFF",
        "GIT_LITERAL_PATHSPECS",
      ])
        expect(env[name]).toBeUndefined()
      expect(env).toMatchObject({
        GIT_CEILING_DIRECTORIES: "/ceiling",
        GIT_EXEC_PATH: "/exec",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      })
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
      Object.assign(process.env, saved)
    }
  })
})
