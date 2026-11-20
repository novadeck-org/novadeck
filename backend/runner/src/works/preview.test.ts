import { execFileSync } from "node:child_process"
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
  // Carries a change of two lines onto main under a home whose git config is `config` (`$HOME`
  // standing for it, with forward slashes, as git reads on every system) and holding `files`,
  // as the person's own; with `repo`, that home is the repository the work is in. Each line ends
  // in `eol`. Answers main's text with the hunks carried, after checking they are the two lines.
  const carried = async (
    config: string,
    options: { files?: Readonly<Record<string, string>>; repo?: boolean; eol?: string } = {},
  ): Promise<string> => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-preview-home-")))
    const was = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME }
    try {
      for (const [name, text] of Object.entries(options.files ?? {}))
        writeFileSync(join(home, name), text)
      writeFileSync(
        join(home, ".gitconfig"),
        config.replaceAll("$HOME", home.replaceAll("\\", "/")),
      )
      process.env.HOME = home
      delete process.env.XDG_CONFIG_HOME
      if (options.repo) execFileSync("git", ["init", "--quiet"], { cwd: home })
      const eol = options.eol ?? "\n"
      const text = (lines: readonly string[]) => lines.map((line) => `${line}${eol}`).join("")
      const end = eol.slice(0, -1)
      const main = text(["one", "two", "three", "four", "five"])
      const theirs = text(["one", "TWO", "three", "FOUR", "five"])
      const hunks = await carry(home, { main, base: main, theirs })
      expect(hunks).toEqual([
        { at: 2, removed: 1, lines: [`TWO${end}`], applies: true },
        { at: 4, removed: 1, lines: [`FOUR${end}`], applies: true },
      ])
      return applied(main, hunks ?? [])
    } finally {
      process.env.HOME = was.HOME
      if (was.XDG !== undefined) process.env.XDG_CONFIG_HOME = was.XDG
      rmSync(home, { recursive: true, force: true })
    }
  }

  const changed = "one\nTWO\nthree\nFOUR\nfive\n"

  // The person's own git setting: git joins changes this many lines apart into one hunk.
  it("keeps main's unchanged lines between two changes under diff.interHunkContext", async () => {
    expect(await carried("[diff]\n\tinterHunkContext = 5\n")).toBe(changed)
  })

  // A textconv the person's attributes give every file: the preview's own files among them.
  it.skipIf(process.platform === "win32")(
    "reads the files' own text, whatever textconv the person's attributes name",
    async () => {
      const config =
        '[core]\n\tattributesFile = $HOME/attributes\n[diff "upper"]\n\ttextconv = tr a-z A-Z <\n'
      expect(await carried(config, { files: { attributes: "* diff=upper\n" } })).toBe(changed)
    },
  )

  // Attributes that call every file binary leave git no hunk to print, so the work would drop
  // out of the preview.
  for (const attribute of ["-diff", "binary"])
    it(`reads the files as text where the person's attributes say ${attribute}`, async () => {
      const config = "[core]\n\tattributesFile = $HOME/attributes\n"
      expect(await carried(config, { files: { attributes: `* ${attribute}\n` } })).toBe(changed)
    })

  it("reads the files as text where the repository's own attributes say binary", async () => {
    expect(await carried("", { repo: true, files: { ".gitattributes": "* binary\n" } })).toBe(
      changed,
    )
  })

  // A clean filter would rewrite both sides before they are compared.
  it.skipIf(process.platform === "win32")(
    "reads the files as written, whatever clean filter the person's attributes name",
    async () => {
      const config =
        '[core]\n\tattributesFile = $HOME/attributes\n[filter "up"]\n\tclean = tr a-z A-Z\n'
      expect(await carried(config, { files: { attributes: "* filter=up\n" } })).toBe(changed)
    },
  )

  it.skipIf(process.platform === "win32")(
    "reads the files as written, whatever clean filter the repository's own attributes name",
    async () => {
      const config = '[filter "up"]\n\tclean = tr a-z A-Z\n'
      const files = { ".gitattributes": "* filter=up\n" }
      expect(await carried(config, { repo: true, files })).toBe(changed)
    },
  )

  // Git for Windows' installer sets core.autocrlf, which drops each line's \r from the hunks;
  // core.eol and core.safecrlf only act on a conversion, which there now is none of.
  it("keeps a CRLF file's line ends under core.autocrlf, core.eol and core.safecrlf", async () => {
    const config = "[core]\n\tautocrlf = true\n\teol = crlf\n\tsafecrlf = true\n"
    expect(await carried(config, { eol: "\r\n" })).toBe(changed.replaceAll("\n", "\r\n"))
  })

  it("keeps a CRLF file's line ends where the person's attributes say text and eol", async () => {
    const config = "[core]\n\tattributesFile = $HOME/attributes\n"
    const files = { attributes: "* text=auto eol=crlf\n" }
    expect(await carried(config, { files, eol: "\r\n" })).toBe(changed.replaceAll("\n", "\r\n"))
  })
})
