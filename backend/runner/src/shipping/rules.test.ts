import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  agyRule,
  claudeRule,
  claudeRules,
  codexRules,
  codexRulesOf,
  covered,
  projectFolders,
} from "./rules.js"

describe("the person's allow rules", () => {
  it("read Claude Code's Bash specifiers", () => {
    const rule = (entry: string) => claudeRule(entry)!
    expect(rule("Bash(git push:*)")("git push origin main", [])).toBe(true)
    expect(rule("Bash(git push:*)")("git pushy", [])).toBe(false)
    expect(rule("Bash(git push *)")("git push -f", [])).toBe(true)
    expect(rule("Bash(gh pr merge 12)")("gh pr merge 12", [])).toBe(true)
    expect(rule("Bash(gh pr merge 12)")("gh pr merge 13", [])).toBe(false)
    expect(rule("Bash")("anything", [])).toBe(true)
    expect(claudeRule("Read(./x)")).toBeUndefined()
  })

  it("read Antigravity's command rules as the words a command begins with", () => {
    const rule = agyRule("command(git push)")!
    expect(rule("", ["git", "push", "origin"])).toBe(true)
    expect(rule("", ["git", "push-something"])).toBe(false)
    expect(rule("", ["git", "status"])).toBe(false)
    // A glob never matched in Antigravity, and other entries say nothing of a command.
    expect(agyRule("command(git push*)")).toBeUndefined()
    expect(agyRule("mcp(novadeck_novadeck/*)")).toBeUndefined()
  })

  it("read Codex's prefix rules that allow", () => {
    const rules = codexRulesOf(
      'prefix_rule(pattern=["git", "push"], decision="allow")\nprefix_rule(pattern=["rm"], decision="forbidden")',
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]!("", ["git", "push", "origin"])).toBe(true)
    expect(rules[0]!("", ["git", "pull"])).toBe(false)
  })

  it("cover a command only where every segment is covered", () => {
    const rules = [claudeRule("Bash(git push:*)")!]
    expect(covered(rules, "git push origin main")).toBe(true)
    expect(covered(rules, "cd /x && git push origin main")).toBe(true)
    expect(covered(rules, "git push origin main && rm -rf x")).toBe(false)
    expect(covered([], "git push")).toBe(false)
  })
})

describe("the folders whose project rules a harness reads", () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "rules-")))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("are where it started and each folder up to its repository's top", async () => {
    const top = join(dir, "repo")
    mkdirSync(join(top, ".git"), { recursive: true })
    mkdirSync(join(top, "a", "b"), { recursive: true })
    expect(await projectFolders(join(top, "a", "b"))).toEqual([
      join(top, "a", "b"),
      join(top, "a"),
      top,
    ])
    // A worktree's `.git` is a file.
    mkdirSync(join(dir, "wt"))
    writeFileSync(join(dir, "wt", ".git"), "gitdir: x\n")
    expect(await projectFolders(join(dir, "wt"))).toEqual([join(dir, "wt")])
    // Outside a repository, only the folder itself.
    mkdirSync(join(dir, "loose"))
    expect(await projectFolders(join(dir, "loose"))).toEqual([join(dir, "loose")])
  })

  it("hold Claude Code's and Codex's rules, beside their homes'", async () => {
    const top = join(dir, "repo")
    const home = join(dir, "home")
    mkdirSync(join(top, ".git"), { recursive: true })
    mkdirSync(join(top, "sub", ".claude"), { recursive: true })
    mkdirSync(join(top, ".codex", "rules"), { recursive: true })
    mkdirSync(join(home, ".claude"), { recursive: true })
    const allow = (entry: string) => JSON.stringify({ permissions: { allow: [entry] } })
    writeFileSync(join(home, ".claude", "settings.json"), allow("Bash(git status:*)"))
    writeFileSync(join(top, "sub", ".claude", "settings.local.json"), allow("Bash(git push:*)"))
    writeFileSync(
      join(top, ".codex", "rules", "a.rules"),
      'prefix_rule(pattern=["gh", "pr"], decision="allow")',
    )
    const claude = await claudeRules(join(top, "sub"), {}, home)
    expect(covered(claude, "git push origin main")).toBe(true)
    expect(covered(claude, "git status")).toBe(true)
    // Started at the top, the folder below isn't read.
    expect(covered(await claudeRules(top, {}, home), "git push origin main")).toBe(false)
    expect(covered(await codexRules(join(top, "sub"), {}, home), "gh pr merge 1")).toBe(true)
  })
})
