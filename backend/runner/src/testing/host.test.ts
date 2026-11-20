import { join } from "node:path"

import { hookVariables } from "../shell/hook.js"
import { inherited, withoutInherited } from "../shell/inherited.js"
import { describe, expect, it } from "../test.js"
import { hostless, hostVariables, ownHome, sessionVariable } from "./host.js"

describe("a test's own environment", () => {
  it("leaves out every variable Novadeck keeps from what it starts, and what its relay reads", () => {
    // Built from them, so the two can't drift: a name added to `inherited` is left out here too.
    for (const name of [...inherited, ...hookVariables])
      expect(sessionVariable(name), name).toBe(true)
    const env = Object.fromEntries(hostVariables.map((name) => [name, "x"]))
    expect(Object.keys(withoutInherited(env, "linux"))).toEqual(
      hostVariables.filter((name) => !inherited.includes(name)),
    )
  })

  it("leaves out the session markers and config homes of the harnesses", () => {
    for (const name of [
      "NOVADECK_CAPTURE",
      "NOVADECK_TERMINAL_ID",
      "CLAUDECODE",
      "CLAUDE_PROJECT_DIR",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "CODEX_THREAD_ID",
      "ANTIGRAVITY_CONVERSATION_ID",
      "CURSOR_VERSION",
    ])
      expect(sessionVariable(name), name).toBe(true)
  })

  it("keeps the machine's own, as Claude Code's path to Git for Windows' bash", () => {
    for (const name of ["PATH", "HOME", "CLAUDE_CODE_GIT_BASH_PATH", "NOVADECKS", "XCODEX_HOME"])
      expect(sessionVariable(name), name).toBe(false)
  })

  it("takes a name in any case on Windows, as stripInherited does, and only there", () => {
    expect(sessionVariable("novadeck_capture", "win32")).toBe(true)
    expect(sessionVariable("Codex_Home", "win32")).toBe(true)
    expect(sessionVariable("novadeck_capture", "linux")).toBe(false)
  })

  it("takes what the test gives over this process's, session variables included", () => {
    const env = hostless({ NOVADECK_TERMINAL_ID: "t1", HOME: "/home/test" })
    expect(env).toMatchObject({ NOVADECK_TERMINAL_ID: "t1", HOME: "/home/test" })
    expect(env.PATH).toBe(process.env.PATH)
    expect(Object.keys(hostless()).filter((name) => sessionVariable(name))).toEqual([])
  })

  it("names a worktrees folder and a Codex config under the test's own root", () => {
    expect(ownHome("/tmp/t")).toEqual({
      worktrees: join("/tmp/t", "home", ".novadeck", "worktrees"),
      codexConfig: join("/tmp/t", "home", ".codex", "config.toml"),
    })
  })
})
