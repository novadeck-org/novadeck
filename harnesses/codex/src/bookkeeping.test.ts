import { join } from "node:path"

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
    expect(codex.bookkeepingOf("/a/.codex-2/sessions/2026/11/19/rollout-1.jsonl")).toContain(
      join("/a/.codex-2", "memories"),
    )
  })

  it("name none for a path laid out otherwise", () => {
    expect(codex.bookkeepingOf("/home/u/sessions/acme/x/rollout.jsonl")).toEqual([])
    expect(codex.bookkeepingOf("/a/.codex/sessions/2026/11/rollout-1.jsonl")).toEqual([])
    expect(codex.bookkeepingOf("/elsewhere/rollout.jsonl")).toEqual([])
  })
})
