import { describe, expect, it } from "vitest"

import { parseShell } from "./words.js"

describe("the shell reader", () => {
  it("splits commands at their joints and takes quotes off", () => {
    const { commands, dynamic } = parseShell(`cd "a b" && git push origin 'feat x'; echo hi | cat`)
    expect(commands.map((c) => [c.joint, ...c.words])).toEqual([
      ["start", "cd", "a b"],
      ["&&", "git", "push", "origin", "feat x"],
      [";", "echo", "hi"],
      ["|", "cat"],
    ])
    expect(dynamic).toBe(false)
  })

  it("reads origin main; as a push to main", () => {
    expect(parseShell("git push origin main;").commands[0]!.words).toEqual([
      "git",
      "push",
      "origin",
      "main",
    ])
  })

  it("marks expansions and subshells as dynamic and reads inside them", () => {
    const read = parseShell("echo $(git push origin main)")
    expect(read.dynamic).toBe(true)
    expect(read.inner).toEqual(["git push origin main"])
    expect(parseShell("(git push)").dynamic).toBe(true)
  })

  it("keeps redirections and assignments apart from the words", () => {
    const [one] = parseShell("GIT_SSH=x git push 2>&1").commands
    expect(one!.assigns).toEqual(["GIT_SSH=x"])
    expect(one!.words).toEqual(["git", "push"])
    expect(one!.redirects).toEqual(["2>&1"])
  })

  it("skips a here-document's body", () => {
    const { commands } = parseShell(
      "gh pr create --body-file - <<'EOF'\ngit push origin main\nEOF\n",
    )
    expect(commands.map((c) => c.words[0])).toEqual(["gh"])
  })
})
