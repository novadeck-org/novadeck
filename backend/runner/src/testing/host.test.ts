import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { hostless, ownHome, sessionVariable } from "./host.js"

describe("a test's own environment", () => {
  it("leaves out what a Novadeck terminal or an agent session sets", () => {
    for (const name of [
      "NOVADECK_CAPTURE",
      "NOVADECK_TERMINAL_ID",
      "NOVADECK_REPORT_TOKEN",
      "CLAUDECODE",
      "CLAUDE_PID",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_SESSION_ID",
      "CODEX_HOME",
      "CODEX_THREAD_ID",
      "CURSOR_VERSION",
    ])
      expect(sessionVariable(name), name).toBe(true)
  })

  it("keeps the machine's own, as Claude Code's path to Git for Windows' bash", () => {
    for (const name of ["PATH", "HOME", "CLAUDE_CODE_GIT_BASH_PATH", "NOVADECKS", "XCODEX_HOME"])
      expect(sessionVariable(name), name).toBe(false)
  })

  it("takes what the test gives over this process's, session variables included", () => {
    const env = hostless({ NOVADECK_TERMINAL_ID: "t1", HOME: "/home/test" })
    expect(env).toMatchObject({ NOVADECK_TERMINAL_ID: "t1", HOME: "/home/test" })
    expect(env.PATH).toBe(process.env.PATH)
    expect(Object.keys(hostless()).filter(sessionVariable)).toEqual([])
  })

  it("names a worktrees folder and a Codex config under the test's own root", () => {
    expect(ownHome("/tmp/t")).toEqual({
      worktrees: join("/tmp/t", "home", ".novadeck", "worktrees"),
      codexConfig: join("/tmp/t", "home", ".codex", "config.toml"),
    })
  })
})
