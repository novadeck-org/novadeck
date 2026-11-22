import { describe, expect, it } from "vitest"

import { claudeRule, codexRulesOf, covered } from "./rules.js"

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
