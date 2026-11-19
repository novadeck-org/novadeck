import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { claude } from "./index.js"

const install = (env: NodeJS.ProcessEnv = {}) => ({
  env,
  home: join("/", "h"),
  platform: "linux" as const,
  plugin: "",
})

describe("the folders Claude Code keeps for itself", () => {
  it("are its plans, transcripts and memory, its agents' memory and its state, not the rest of its home", () => {
    const folders = claude.bookkeeping(install())
    for (const name of ["plans", "projects", "agent-memory", "todos"])
      expect(folders).toContain(join("/h", ".claude", name))
    for (const name of ["skills", "settings.json", "CLAUDE.md", "commands"])
      expect(folders).not.toContain(join("/h", ".claude", name))
  })

  it("follow the home its variable moves", () => {
    expect(claude.bookkeeping(install({ CLAUDE_CONFIG_DIR: "/moved" }))).toContain(
      join("/moved", "plans"),
    )
  })

  it("are named from a transcript's own home, laid out as `<home>/projects/<project>/<id>.jsonl`", () => {
    const folders = claude.bookkeepingOf("/a/.claude-2/projects/-a-p/s.jsonl")
    expect(folders).toContain(join("/a/.claude-2", "plans"))
    expect(folders).toContain(join("/a/.claude-2", "agent-memory"))
  })

  it("name none for a path laid out otherwise, which only has a folder called projects above it", () => {
    expect(claude.bookkeepingOf("/home/u/projects/acme/claude-home/s.jsonl")).toEqual([])
    expect(claude.bookkeepingOf("/home/u/projects/s.jsonl")).toEqual([])
    expect(claude.bookkeepingOf("/home/u/.claude/projects/a/b/s.jsonl")).toEqual([])
  })
})
