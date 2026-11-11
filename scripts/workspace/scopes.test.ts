import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { workspacePackages } from "./platform.ts"
import { isProse, readScope, scopeFile, scopeOver } from "./scopes.ts"

// The narrowings of what a change outside every package runs (scopes.ts): each must read, sit
// where a narrowing is allowed, and be true of the folder, as far as a test can tell: nothing
// that runs on another system names it, and nothing that isn't narrowed imports it. That no
// package reads it is the reach fence's (reach.ts), in lint.

const root = join(import.meta.dirname, "..", "..")
const tracked = execFileSync(
  "git",
  ["-c", "core.quotePath=false", "ls-files", "-z", "-co", "--exclude-standard"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
)
  .split("\0")
  .filter(Boolean)
const files = tracked.filter((file) => file.split("/").at(-1) === scopeFile)
const scopes = files.map((file) => ({
  file,
  scope: readScope(dirname(file), readFileSync(join(root, file), "utf8")),
}))
const folders = workspacePackages(root).map(({ folder }) => folder)

// What may never be narrowed: what CI runs on every system or decides with (the workflows and
// their actions, the E2E suite's scripts, packaging, the installer, this plan and its facts).
// Root config and the lockfile sit at the root, whose scope is never read.
const never = [
  ".github",
  "scripts/e2e",
  "scripts/package",
  "scripts/install",
  "scripts/ci",
  "scripts/workspace",
]

/** Each job of a workflow, by its text, and whether it runs on Linux alone. */
const jobsOf = (text: string): readonly { text: string; linux: boolean }[] =>
  text
    .split(/^jobs:\s*$/m)
    .slice(1)
    .join("")
    .split(/^ {2}(?=[\w-]+:\s*$)/m)
    .slice(1)
    .map((job) => {
      const runsOn = /^ {4}runs-on:\s*(.+)$/m.exec(job)?.[1] ?? ""
      // A matrix's system counts as Linux only where the job names no other.
      const linux = /ubuntu/.test(runsOn) || (/matrix/.test(runsOn) && !/macos|windows/i.test(job))
      return { text: job, linux }
    })

// A comment names what it explains, not what the job runs.
const uncommented = (text: string): string => text.replace(/(^|\s)#.*$/gm, "$1")

const workflows = tracked
  .filter((file) => /^\.github\/(?:workflows\/[^/]+\.ya?ml|actions\/.+\/action\.ya?ml)$/.test(file))
  .map((file) => ({ file, text: uncommented(readFileSync(join(root, file), "utf8")) }))

const names = (text: string, folder: string): boolean =>
  new RegExp(`(?:^|[^\\w./-])${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|\\b)`).test(text)

describe("the scopes of folders outside every package", () => {
  it("each read as a scope", () => {
    expect(scopes.filter(({ scope }) => !scope).map(({ file }) => file)).toEqual([])
  })

  it.each(scopes.map(({ file }) => ({ folder: dirname(file) })))(
    "narrow $folder, where a narrowing may sit",
    ({ folder }) => {
      expect(dirname(folder)).not.toBe(".")
      expect(
        never.filter(
          (each) =>
            folder === each || folder.startsWith(`${each}/`) || each.startsWith(`${folder}/`),
        ),
      ).toEqual([])
      expect(
        folders.filter(
          (each) =>
            folder === each || folder.startsWith(`${each}/`) || each.startsWith(`${folder}/`),
        ),
      ).toEqual([])
    },
  )

  it.each(scopes.map(({ file }) => ({ folder: dirname(file) })))(
    "narrow $folder, which no job off Linux and no action names",
    ({ folder }) => {
      const naming = workflows.flatMap(({ file, text }) =>
        file.includes("/actions/")
          ? names(text, folder)
            ? [file]
            : []
          : jobsOf(text)
              .filter((job) => !job.linux && names(job.text, folder))
              .map(() => file),
      )
      expect(naming).toEqual([])
    },
  )

  it.each(scopes.map(({ file }) => ({ folder: dirname(file) })))(
    "narrow $folder, which nothing else imports but what is narrowed too",
    ({ folder }) => {
      const narrowed = scopes.flatMap(({ scope }) => (scope ? [scope] : []))
      const importers = tracked.filter(
        (file) =>
          /\.[cm]?[jt]sx?$/.test(file) &&
          !file.startsWith(`${folder}/`) &&
          !scopeOver(narrowed, file) &&
          new RegExp(`from "[./]*/${folder.split("/").at(-1)}/|from "(?:\\.\\./)+${folder}/`).test(
            readFileSync(join(root, file), "utf8"),
          ),
      )
      expect(importers).toEqual([])
    },
  )
})

describe("a scope's file", () => {
  it("reads with what a change reaches and why", () => {
    expect(readScope("scripts/x", '{ "reaches": "repository", "why": "Only its tests." }')).toEqual(
      { folder: "scripts/x", reaches: "repository", why: "Only its tests." },
    )
  })

  it.each([
    '{ "reaches": "everything", "why": "x" }',
    '{ "reaches": "repository" }',
    '{ "reaches": "repository", "why": " " }',
    '{ "reaches": "repository", "why": "x", "platform": "neutral" }',
    "not json",
  ])("isn't a scope as %s, which runs everything", (text) => {
    expect(readScope("scripts/x", text)).toBeUndefined()
  })

  it("covers its folder, the nearest one winning", () => {
    const outer = { folder: "scripts", reaches: "repository" as const, why: "x" }
    const inner = { folder: "scripts/ratchet", reaches: "repository" as const, why: "y" }
    expect(scopeOver([outer, inner], "scripts/ratchet/a.json")).toBe(inner)
    expect(scopeOver([outer, inner], "scripts/flakes/a.ts")).toBe(outer)
    expect(scopeOver([inner], "scripts/ratchetting/a.ts")).toBeUndefined()
  })
})

describe("prose", () => {
  it("is a Markdown file", () => {
    expect(isProse("docs/development.md")).toBe(true)
    expect(isProse("AGENTS.md")).toBe(true)
    expect(isProse("docs/assets/a.webp")).toBe(false)
  })
})
