import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { carry, hunksOf } from "./preview.js"

// Main's text with the hunks carried onto it, as the preview shows it.
const applied = (
  main: string,
  hunks: readonly { at: number; removed: number; lines: string[] }[],
) => {
  const lines = main.split("\n")
  for (const hunk of hunks.toReversed()) lines.splice(hunk.at - 1, hunk.removed, ...hunk.lines)
  return lines.join("\n")
}

describe("the hunks of a diff", () => {
  it("keeps the context lines git joins two changes over, as main has them", () => {
    // Two changes joined into one hunk, as diff.interHunkContext has git print them, a blank
    // context line (diff.suppressBlankEmpty) among them.
    const diff = [
      "diff --git a/main b/wanted",
      "--- a/main",
      "+++ b/wanted",
      "@@ -2,4 +2,4 @@",
      "-two",
      "+TWO",
      " three",
      "",
      "-five",
      "+FIVE",
      "",
    ].join("\n")
    const hunks = hunksOf(diff)
    expect(hunks).toEqual([{ at: 2, removed: 4, lines: ["TWO", "three", "", "FIVE"] }])
    expect(applied("one\ntwo\nthree\n\nfive\nsix\n", hunks)).toBe("one\nTWO\nthree\n\nFIVE\nsix\n")
  })

  it("reads changed lines only where git prints no context", () => {
    const diff = ["@@ -2 +2 @@", "-two", "+TWO", "@@ -3,0 +4,2 @@", "+new", "+lines", ""].join("\n")
    expect(hunksOf(diff)).toEqual([
      { at: 2, removed: 1, lines: ["TWO"] },
      { at: 4, removed: 0, lines: ["new", "lines"] },
    ])
  })

  it("counts no line for the note of a file ending without a newline", () => {
    const diff = ["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b", ""].join("\n")
    expect(hunksOf(diff)).toEqual([{ at: 1, removed: 1, lines: ["b"] }])
  })
})

describe("carrying a worktree's file onto main", () => {
  // Carries `theirs` onto `main` from `main`, under a home whose git config is `config`, a file
  // beside it named by `files`, as the person's own.
  const carried = async (
    config: string,
    files: Readonly<Record<string, string>> = {},
  ): Promise<string> => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-preview-home-")))
    const was = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME }
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(home, name), text)
      writeFileSync(join(home, ".gitconfig"), config.replaceAll("$HOME", home))
      process.env.HOME = home
      delete process.env.XDG_CONFIG_HOME
      const main = "one\ntwo\nthree\nfour\nfive\n"
      const theirs = "one\nTWO\nthree\nFOUR\nfive\n"
      const hunks = await carry(home, { main, base: main, theirs })
      expect(hunks).toEqual([
        { at: 2, removed: 1, lines: ["TWO"], applies: true },
        { at: 4, removed: 1, lines: ["FOUR"], applies: true },
      ])
      return applied(main, hunks ?? [])
    } finally {
      process.env.HOME = was.HOME
      if (was.XDG !== undefined) process.env.XDG_CONFIG_HOME = was.XDG
      rmSync(home, { recursive: true, force: true })
    }
  }

  // The person's own git setting: git joins changes this many lines apart into one hunk.
  it("keeps main's unchanged lines between two changes under diff.interHunkContext", async () => {
    expect(await carried("[diff]\n\tinterHunkContext = 5\n")).toBe("one\nTWO\nthree\nFOUR\nfive\n")
  })

  // A textconv the person's attributes give every file: the preview's own files among them.
  it.skipIf(process.platform === "win32")(
    "reads the files' own text, whatever textconv the person's attributes name",
    async () => {
      const config =
        '[core]\n\tattributesFile = $HOME/attributes\n[diff "upper"]\n\ttextconv = tr a-z A-Z <\n'
      expect(await carried(config, { attributes: "* diff=upper\n" })).toBe(
        "one\nTWO\nthree\nFOUR\nfive\n",
      )
    },
  )
})
