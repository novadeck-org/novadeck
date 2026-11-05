import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, test } from "vitest"

import { frontendSources, workingFiles } from "./files.ts"

let repo = ""
afterEach(() => rmSync(repo, { recursive: true, force: true }))

// A `.DS_Store`, or a package folder a branch switch left with only its ignored
// node_modules, sits beside the packages: neither has source.
test("reads the packages under frontend/ and apps/, past entries that are no package", () => {
  repo = mkdtempSync(join(tmpdir(), "atlas-files-"))
  for (const dir of ["frontend/ui/src/parts", "frontend/gone/node_modules", "apps/desktop/src"])
    mkdirSync(join(repo, dir), { recursive: true })
  writeFileSync(join(repo, "frontend/ui/src/parts/box.tsx"), "")
  writeFileSync(join(repo, "frontend/ui/src/box.test.tsx"), "")
  writeFileSync(join(repo, "apps/desktop/src/main.ts"), "")
  writeFileSync(join(repo, "frontend/.DS_Store"), "")
  writeFileSync(join(repo, "apps/.DS_Store"), "")
  expect(frontendSources(repo)).toEqual([
    "frontend/ui/src/parts/box.tsx",
    "apps/desktop/src/main.ts",
  ])
})

// Areas and links read the same files the folder scans do: a file not yet added counts, one
// deleted but not yet `git rm`ed doesn't, ignored files never do, and a name outside ASCII
// comes through whole.
test("lists the working tree's files, as the folder scans see them", () => {
  repo = mkdtempSync(join(tmpdir(), "atlas-files-"))
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=atlas", "-c", "user.email=atlas@test", ...args], {
      cwd: repo,
    })
  git("init", "-q")
  mkdirSync(join(repo, "src/new"), { recursive: true })
  mkdirSync(join(repo, "node_modules"))
  writeFileSync(join(repo, ".gitignore"), "node_modules\n")
  writeFileSync(join(repo, "src/kept.ts"), "")
  writeFileSync(join(repo, "src/gone.ts"), "")
  git("add", ".")
  git("commit", "-q", "-m", "files")
  rmSync(join(repo, "src/gone.ts"))
  writeFileSync(join(repo, "src/new/added.ts"), "")
  writeFileSync(join(repo, "src/ł日本.ts"), "")
  writeFileSync(join(repo, "node_modules/dep.ts"), "")
  expect(workingFiles(repo).toSorted()).toEqual(
    [".gitignore", "src/kept.ts", "src/new/added.ts", "src/ł日本.ts"].toSorted(),
  )
  expect(workingFiles(repo, ["src/new"])).toEqual(["src/new/added.ts"])
})
