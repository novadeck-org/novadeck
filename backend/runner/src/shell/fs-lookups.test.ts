import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { matchCall, type GrantScope } from "@novadeck/harness-core/grants"
import { describe, expect, it } from "vitest"

import { fsLookups } from "./fs-lookups.js"
import { gitLookups } from "./git-lookups.js"

const scope: GrantScope = {
  presets: ["pr"],
  commands: [],
  repos: [{ url: "github.com/acme/app", defaultBranch: "main" }],
}

const folder = (): { root: string; outside: string; done: () => void } => {
  // The real long path: a Windows runner's temp folder is an 8.3 name (`RUNNER~1`), which the
  // dialect refuses for its `~`.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-fs-lookups-")))
  const root = join(base, "project")
  const outside = join(base, "outside")
  mkdirSync(root)
  mkdirSync(outside)
  return { root, outside, done: () => rmSync(base, { recursive: true, force: true }) }
}

// Windows makes a symlink only for a user allowed to; without that the test has nothing to read.
const makeLink = (target: string, path: string, skip: (reason: string) => never): void => {
  try {
    symlinkSync(target, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") skip("this user may not create symlinks")
    throw error
  }
}

describe("the disk lookups", () => {
  it("tell a regular file from a directory, and follow a symlink to its real path", async ({
    skip,
  }) => {
    const { root, outside, done } = folder()
    try {
      writeFileSync(join(outside, "secret.md"), "x")
      writeFileSync(join(root, "note.md"), "x")
      makeLink(join(outside, "secret.md"), join(root, "link.md"), skip)
      expect((await fsLookups.real(join(root, "note.md")))?.file).toBe(true)
      expect((await fsLookups.real(root))?.file).toBe(false)
      const link = await fsLookups.real(join(root, "link.md"))
      expect(link?.file).toBe(true)
      expect(link?.path.startsWith(root)).toBe(false)
      expect(link?.path.endsWith("secret.md")).toBe(true)
      expect(await fsLookups.real(join(root, "missing.md"))).toBeUndefined()
      expect(await fsLookups.exists(join(root, "note.md"))).toBe(true)
      expect(await fsLookups.exists(join(root, "missing.md"))).toBe(false)
    } finally {
      done()
    }
  })

  it("keep a pull request's body file from being a symlink inside the project that points outside", async ({
    skip,
  }) => {
    const { root, outside, done } = folder()
    try {
      writeFileSync(join(outside, "secret.md"), "x")
      writeFileSync(join(root, "note.md"), "x")
      makeLink(join(outside, "secret.md"), join(root, "link.md"), skip)
      const ask = (file: string) =>
        matchCall(
          {
            command: `gh pr comment 5 -R acme/app --body-file ${join(root, file)}`,
            cwd: null,
            // Windows paths have backslashes, which only its dialect reads whole.
            ...(process.platform === "win32" && { dialect: "windows-quote-free" as const }),
          },
          [scope],
          gitLookups,
          root,
          fsLookups,
        )
      expect(await ask("note.md")).not.toBeNull()
      expect(await ask("link.md")).toBeNull()
      expect(await ask("missing.md")).toBeNull()
    } finally {
      done()
    }
  })
})
