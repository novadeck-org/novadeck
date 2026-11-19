import { join, posix, win32 } from "node:path"

import { describe, expect, it } from "vitest"

import { codex } from "./index.js"

const install = (env: NodeJS.ProcessEnv = {}) => ({
  env,
  home: join("/", "h"),
  platform: "linux" as const,
  plugin: "",
})

describe("the folders Codex keeps for itself", () => {
  it("are its sessions, memories and logs, not the rest of its home", () => {
    const folders = codex.bookkeeping(install())
    for (const name of ["sessions", "memories", "log"])
      expect(folders).toContain(join("/h", ".codex", name))
    for (const name of ["config.toml", "prompts", "skills"])
      expect(folders).not.toContain(join("/h", ".codex", name))
  })

  it("follow the home its variable moves", () => {
    expect(codex.bookkeeping(install({ CODEX_HOME: "/moved" }))).toContain(
      join("/moved", "sessions"),
    )
  })

  it("are named from a rollout's own home, laid out as `<home>/sessions/<year>/<month>/<day>/rollout-<…>.jsonl`", () => {
    // Named in the rules the rollout's path is written in, whatever machine reads it.
    expect(codex.bookkeepingOf("/a/.codex-2/sessions/2026/11/19/rollout-1.jsonl")).toContain(
      posix.join("/a/.codex-2", "memories"),
    )
  })

  it("are named from a Windows rollout, written with either slash", () => {
    const home = "C:\\Users\\Ann\\.codex"
    for (const rollout of [
      win32.join(home, "sessions", "2026", "11", "19", "rollout-1.jsonl"),
      "C:/Users/Ann/.codex/sessions/2026/11/19/rollout-1.jsonl",
    ]) {
      const folders = codex.bookkeepingOf(rollout)
      expect(folders).toContain(win32.join(home, "sessions"))
      expect(folders).toContain(win32.join(home, "memories"))
    }
    expect(codex.bookkeepingOf("C:\\Users\\Ann\\.codex\\sessions\\2026\\rollout-1.jsonl")).toEqual(
      [],
    )
  })

  it("name none for a path laid out otherwise", () => {
    expect(codex.bookkeepingOf("/home/u/sessions/acme/x/rollout.jsonl")).toEqual([])
    expect(codex.bookkeepingOf("/a/.codex/sessions/2026/11/rollout-1.jsonl")).toEqual([])
    expect(codex.bookkeepingOf("/elsewhere/rollout.jsonl")).toEqual([])
  })
})
