import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, test } from "vitest"

import { frontendSources } from "./files.ts"

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
