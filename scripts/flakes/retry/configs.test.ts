import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "../../test"

const root = join(import.meta.dirname, "..", "..", "..")
const trees = [
  "apps",
  "backend",
  "contract",
  "engines",
  "frontend",
  "harnesses",
  "libraries",
  "tools",
]

// Configs that take no retry: a probe's forensic capture, run by hand, which a retry would muddle.
const exempt = new Set(["backend/runner/vitest.agy-capture.config.ts"])

/** Every workspace package whose tests Vitest runs, by its folder. */
const vitestPackages = trees
  .filter((tree) => existsSync(join(root, tree)))
  .flatMap((tree) => readdirSync(join(root, tree)).map((name) => `${tree}/${name}`))
  .filter((folder) => {
    const manifest = join(root, folder, "package.json")
    if (!existsSync(manifest)) return false
    const { scripts } = JSON.parse(readFileSync(manifest, "utf8")) as {
      readonly scripts?: Readonly<Record<string, string>>
    }
    return /^vitest\b/.test(scripts?.test ?? "")
  })

/** The config Vitest loads for a package: vitest.config.ts, else vite.config.ts. */
const configOf = (folder: string): string =>
  ["vitest.config.ts", "vite.config.ts"]
    .map((file) => `${folder}/${file}`)
    .find((file) => existsSync(join(root, file))) ?? `${folder}/vitest.config.ts`

const wrapped = (file: string): boolean =>
  existsSync(join(root, file)) &&
  /^export default retryOnCi\(/m.test(readFileSync(join(root, file), "utf8"))

describe("CI's retries", () => {
  it("reach every package Vitest tests, so none retries unrecorded or misses its retries", () => {
    expect(vitestPackages.length).toBeGreaterThan(20)
    expect(vitestPackages.map(configOf).filter((file) => !wrapped(file))).toEqual([])
  })

  it("reach every other Vitest config a package keeps, but for the exempt", () => {
    const others = vitestPackages.flatMap((folder) =>
      readdirSync(join(root, folder))
        .filter((file) => /^vitest\..+\.config\.ts$/.test(file))
        .map((file) => `${folder}/${file}`),
    )
    expect(others).toContain("backend/runner/vitest.e2e.config.ts")
    expect(others.filter((file) => !exempt.has(file) && !wrapped(file))).toEqual([])
  })

  it("count the end-to-end suite's as the E2E suite's, and its probes' as probes", () => {
    const text = readFileSync(join(root, "backend/runner/vitest.e2e.config.ts"), "utf8")
    expect(text).toContain(
      'export default retryOnCi(config, { suite: process.env.NOVADECK_E2E_PROBES ? "probes" : "e2e" })',
    )
  })
})
