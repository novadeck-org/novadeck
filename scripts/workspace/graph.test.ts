import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { fromPath, installed } from "../libraries/graph.ts"

// The boundaries the package graph holds now that each part is a package of its own (step 5):
// what an app or a frontend package may depend on, which the import rules used to say. pnpm
// resolves only what a package declares (the root's own dependencies aside, which resolve from
// anywhere and which the import fence refuses by name in libraries and browser code alone), so
// these edges are the whole of what it can reach;
// scripts/libraries/graph.test.ts holds the libraries' side (no app package, only their order).

type Manifest = {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
}

const root = join(import.meta.dirname, "..", "..")
const trees = [
  "apps",
  "frontend",
  "backend",
  "contract",
  "tools",
  "libraries",
  "harnesses",
  "engines",
]

/** Every workspace package in the trees above, by its folder. */
const packages = new Map<string, Manifest>(
  trees
    .filter((tree) => existsSync(join(root, tree)))
    .flatMap((tree) =>
      readdirSync(join(root, tree))
        .map((name) => `${tree}/${name}`)
        .filter((folder) => existsSync(join(root, folder, "package.json")))
        .map((folder): [string, Manifest] => [
          folder,
          JSON.parse(readFileSync(join(root, folder, "package.json"), "utf8")) as Manifest,
        ]),
    ),
)
const byName = new Map([...packages].map(([folder, manifest]) => [manifest.name, folder]))

const manifest = (folder: string): Manifest => {
  const found = packages.get(folder)
  if (!found) throw new Error(`No package at ${folder}`)
  return found
}

const kinds = {
  shipped: ["dependencies", "peerDependencies", "optionalDependencies"],
  any: ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"],
} as const

/** The workspace packages a package names, by folder, an alias by what it installs. */
const named = (folder: string, kind: keyof typeof kinds): readonly string[] => {
  const each = manifest(folder)
  return kinds[kind]
    .flatMap((list) => Object.entries(each[list] ?? {}))
    .flatMap(([key, spec]) => {
      const found = byName.get(installed(key, spec))
      return found ? [found] : []
    })
}

/**
 * Every workspace package a package's code can reach: what it names in any kind of
 * dependency, as a bundle or a test takes them all, then through what each of those ships.
 */
const reaches = (folder: string): ReadonlySet<string> => {
  const seen = new Set<string>()
  const visit = (next: string): void => {
    if (seen.has(next)) return
    seen.add(next)
    for (const further of named(next, "shipped")) visit(further)
  }
  for (const first of named(folder, "any")) visit(first)
  return seen
}

// What step 3 called a backend: the adapters the UI is kept from, and the backend itself.
const backends = new Set([
  "frontend/runner-adapter",
  "frontend/demo",
  "frontend/demo-debug",
  "contract/runner-client",
  "backend/runner",
  "backend/relay",
])

describe("the package graph", () => {
  it("finds the packages it holds to", () => {
    for (const folder of [
      "apps/desktop",
      "apps/try",
      "frontend/ui",
      "frontend/toolkit",
      "frontend/demo",
      "frontend/demo-debug",
      "frontend/runner-adapter",
      "contract/runner-client",
      "harnesses/core",
    ])
      expect(packages.has(folder), folder).toBe(true)
  })

  it("names no workspace package by a path, which pnpm installs whatever its name", () => {
    expect(
      [...packages].flatMap(([folder, each]) =>
        kinds.any.flatMap((list) =>
          Object.entries(each[list] ?? {})
            .filter(([, spec]) => fromPath(spec))
            .map(([key]) => `${folder} ${list} ${key}`),
        ),
      ),
    ).toEqual([])
  })

  it("keeps the desktop app off the demo and its debug panel", () => {
    expect(
      ["frontend/demo", "frontend/demo-debug"].filter((folder) =>
        reaches("apps/desktop").has(folder),
      ),
    ).toEqual([])
  })

  it("gives the desktop app the runner adapter as its only adapter", () => {
    const adapters = named("apps/desktop", "any").filter((folder) =>
      ["frontend/runner-adapter", "frontend/demo", "frontend/demo-debug"].includes(folder),
    )
    expect(adapters).toEqual(["frontend/runner-adapter"])
  })

  it("lets the try app reach none of the runner's adapter, its client or the debug panel", () => {
    const reached = reaches("apps/try")
    expect(
      ["frontend/runner-adapter", "contract/runner-client", "frontend/demo-debug"].filter(
        (folder) => reached.has(folder),
      ),
    ).toEqual([])
  })

  it("keeps the UI and what it reaches off every backend", () => {
    const reached = reaches("frontend/ui")
    expect([...backends].filter((folder) => reached.has(folder))).toEqual([])
  })

  it("keeps the adapters and the terminal views, and what they reach, off the app's chrome", () => {
    expect(
      ["frontend/runner-adapter", "frontend/demo", "frontend/demo-debug", "frontend/terminal-views"]
        .filter((folder) => reaches(folder).has("frontend/ui"))
        .map((folder) => `${folder} -> frontend/ui`),
    ).toEqual([])
  })

  it("keeps the toolkit off every other frontend package, its tests' render helpers aside", () => {
    // The toolkit is what every feature draws with, so nothing of the app may sit under it.
    // The test kit is the one exception, as a dev dependency of its tests: what it ships (the
    // model, for its fixtures) is the tests' reach, not the toolkit's.
    const own = named("frontend/toolkit", "any").filter((folder) => folder !== "frontend/test-kit")
    const shipped = new Set<string>()
    const visit = (next: string): void => {
      if (shipped.has(next)) return
      shipped.add(next)
      for (const further of named(next, "shipped")) visit(further)
    }
    for (const folder of own) visit(folder)
    expect(
      [...shipped]
        .filter((folder) => folder.startsWith("frontend/"))
        .map((f) => `frontend/toolkit -> ${f}`),
    ).toEqual([])
    expect(named("frontend/toolkit", "shipped").filter((f) => f.startsWith("frontend/"))).toEqual(
      [],
    )
  })

  it("keeps the toolkit's shipped code off the test kit, which only its tests may import", () => {
    const src = join(root, "frontend", "toolkit", "src")
    const shipped = (readdirSync(src, { recursive: true }) as string[])
      .map((file) => file.split("\\").join("/"))
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    expect(shipped.length).toBeGreaterThan(10)
    expect(
      shipped.filter((file) =>
        readFileSync(join(src, file), "utf8").includes("@novadeck/test-kit"),
      ),
    ).toEqual([])
  })

  it("keeps each harness, and what it reaches, off the runner and the other adapters", () => {
    const harnesses = [...packages.keys()].filter((folder) => folder.startsWith("harnesses/"))
    const offending = harnesses.flatMap((folder) =>
      [...reaches(folder)]
        .filter(
          (dependency) =>
            dependency.startsWith("backend/") ||
            (dependency.startsWith("harnesses/") && dependency !== "harnesses/core"),
        )
        .map((dependency) => `${folder} -> ${dependency}`),
    )
    expect(offending).toEqual([])
  })
})
