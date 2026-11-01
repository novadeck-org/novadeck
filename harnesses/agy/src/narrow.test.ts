import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { launchSettings, mayDeny } from "./narrow.js"
import { userRules } from "./settings.js"

describe("the launch settings", () => {
  it("keep the person's own allow rules verbatim, then the granted programs, once each", () => {
    expect(
      JSON.parse(launchSettings(["git", "gh"], ["mcp(novadeck_novadeck/*)", "command(git)"])),
    ).toEqual({
      permissions: {
        allow: ["mcp(novadeck_novadeck/*)", "command(git)", "command(gh)"],
      },
    })
    expect(JSON.parse(launchSettings(["git"]))).toEqual({
      permissions: { allow: ["command(git)"] },
    })
  })

  it("name no deny or ask list, which Antigravity then keeps from the person's settings", () => {
    const { permissions } = JSON.parse(launchSettings(["git"], ["command(ls)"])) as {
      permissions: object
    }
    expect(Object.keys(permissions)).toEqual(["allow"])
  })
})

describe("whether the person's deny rules may deny a command line", () => {
  const deny = ["command(rm)", "command(git push --force)", "mcp(x/*)", "read(secret)"]

  it("takes a rule by the words a command starts with, in any segment of the line", () => {
    expect(mayDeny("rm -rf x", deny)).toBe(true)
    expect(mayDeny("rm", deny)).toBe(true)
    expect(mayDeny("git push --force origin a:b", deny)).toBe(true)
    expect(mayDeny("cd x && rm -rf y", deny)).toBe(true)
    expect(mayDeny("ls; rm y", deny)).toBe(true)
    expect(mayDeny("echo $(rm y)", deny)).toBe(true)
    expect(mayDeny("echo `rm y`", deny)).toBe(true)
  })

  it("leaves a line no rule could cover, and rules that aren't about commands", () => {
    expect(mayDeny("git push origin a:b", deny)).toBe(false)
    expect(mayDeny("rmdir x", deny)).toBe(false)
    expect(mayDeny("echo rm", deny)).toBe(false)
    expect(mayDeny("anything", ["mcp(x/*)", "read(anything)"])).toBe(false)
    expect(mayDeny("rm x", [])).toBe(false)
  })

  it("takes a rule with a wildcard by what comes before it", () => {
    expect(mayDeny("git push --force-with-lease", ["command(git push --force*)"])).toBe(true)
    expect(mayDeny("git status", ["command(git push --force*)"])).toBe(false)
    expect(mayDeny("anything at all", ["command(*)"])).toBe(true)
    expect(mayDeny("curl x", ["command(cu?l)"])).toBe(true)
  })
})

describe("the person's own rules", () => {
  const home = (settings: string | undefined) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-agy-rules-"))
    if (settings !== undefined) {
      mkdirSync(join(root, ".gemini", "antigravity-cli"), { recursive: true })
      writeFileSync(join(root, ".gemini", "antigravity-cli", "settings.json"), settings)
    }
    return { home: root, clean: () => rmSync(root, { recursive: true, force: true }) }
  }

  it("are read verbatim, and none where there is no file or no rules", async () => {
    const some = home(
      JSON.stringify({
        permissions: { allow: ["mcp(a/*)", "command(ls)"], deny: ["command(rm)"] },
      }),
    )
    expect(await userRules(some)).toEqual({
      ok: true,
      allow: ["mcp(a/*)", "command(ls)"],
      deny: ["command(rm)"],
    })
    some.clean()
    for (const settings of [undefined, "{}", JSON.stringify({ permissions: {} })]) {
      const none = home(settings)
      // eslint-disable-next-line no-await-in-loop -- Each case in turn.
      expect(await userRules(none)).toEqual({ ok: true, allow: [], deny: [] })
      none.clean()
    }
  })

  it("are not read when the file can't be parsed or the rules aren't lists of strings", async () => {
    for (const settings of [
      "{ not json",
      "[]",
      JSON.stringify({ permissions: "all" }),
      JSON.stringify({ permissions: { allow: "command(ls)" } }),
      JSON.stringify({ permissions: { deny: [1] } }),
    ]) {
      const bad = home(settings)
      // eslint-disable-next-line no-await-in-loop -- Each case in turn.
      expect(await userRules(bad), settings).toMatchObject({ ok: false })
      bad.clean()
    }
  })
})
