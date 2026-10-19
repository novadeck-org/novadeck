import { execFileSync } from "node:child_process"
import { posix } from "node:path"

import type { Api, Area, AreaLink, Data } from "../src/atlas.ts"
import type { Anchors } from "./anchors.ts"
import { areaOf } from "./areas.ts"

const { dirname, join, normalize } = posix

type Kind = AreaLink["kind"]
type Exports = { prefix: string; target: string }[]
// A package's own `imports` ("#name/*"), which only files inside its folder may use.
type Imports = { base: string; prefix: string; target: string }[]

const roots = ["application", "apps", "backend", "contract", "frontend", "harnesses", "engines"]
const sourcePattern = /\.(?:tsx?|rs)$/
const skipPattern = /\.(?:test|spec|e2e)\.|\/(?:e2e|testing|test|fixtures)\/|\/testing\.tsx?$/
const specifierPattern =
  /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g
const suffixes = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]

const unresolved = new Map<string, number>()

const trackedFiles = (repo: string, paths: string[]): string[] =>
  execFileSync("git", ["ls-files", ...paths], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\n")
    .filter(Boolean)

const specifiersOf = (source: string): string[] =>
  [...source.matchAll(specifierPattern)].map((match) => match[1] ?? match[2] ?? match[3] ?? "")

// The source file a built path points at: ./dist/client.js becomes src/client.ts.
const toSource = (target: string): string =>
  target
    .replace(/^\.\//, "")
    .replace(/^dist\//, "src/")
    .replace(/\.d\.ts$|\.js$/, ".ts")

const exportTarget = (value: unknown): string | null => {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return null
  const conditions = value as Record<string, unknown>
  return exportTarget(conditions.development ?? conditions.default ?? conditions.types)
}

// Workspace packages by name, each with its export subpaths mapped to source files.
const workspacePackages = (repo: string, anchors: Anchors): Map<string, Exports> => {
  const packages = new Map<string, Exports>()
  for (const file of trackedFiles(
    repo,
    roots.map((root) => `${root}/*/package.json`),
  )) {
    const text = anchors.read(file)
    if (text === null) continue
    const json = JSON.parse(text) as { name?: string; exports?: Record<string, unknown> }
    if (json.name === undefined) continue
    const base = dirname(file)
    const entries = Object.entries(json.exports ?? {}).flatMap(([subpath, value]) => {
      const target = exportTarget(value)
      return target === null
        ? []
        : [{ prefix: join(json.name as string, subpath), target: join(base, toSource(target)) }]
    })
    packages.set(json.name, entries)
  }
  return packages
}

// Every workspace package's own `imports`, with targets as repository paths.
const packageImports = (repo: string, anchors: Anchors): Imports =>
  trackedFiles(
    repo,
    roots.map((root) => `${root}/*/package.json`),
  ).flatMap((file) => {
    const text = anchors.read(file)
    if (text === null) return []
    const json = JSON.parse(text) as { imports?: Record<string, unknown> }
    const base = dirname(file)
    return Object.entries(json.imports ?? {}).flatMap(([prefix, value]) => {
      const target = exportTarget(value)
      return target === null ? [] : [{ base, prefix, target: join(base, target) }]
    })
  })

const resolveImport = (
  imports: Imports,
  known: Set<string>,
  from: string,
  specifier: string,
): string | null => {
  for (const entry of imports) {
    if (!from.startsWith(`${entry.base}/`)) continue
    if (!entry.prefix.includes("*")) {
      if (entry.prefix === specifier) return firstExisting(known, entry.target)
      continue
    }
    const [head, tail] = entry.prefix.split("*") as [string, string]
    if (!specifier.startsWith(head) || !specifier.endsWith(tail)) continue
    const middle = specifier.slice(head.length, specifier.length - tail.length)
    return firstExisting(known, entry.target.replace("*", middle))
  }
  return null
}

const firstExisting = (known: Set<string>, base: string): string | null => {
  const stem = base.replace(/\.js$/, "")
  for (const candidate of [base, stem]) {
    for (const suffix of suffixes) if (known.has(candidate + suffix)) return candidate + suffix
  }
  return null
}

const resolvePackage = (
  packages: Map<string, Exports>,
  known: Set<string>,
  specifier: string,
): string | null => {
  const exact = [...packages.values()].flat().find((entry) => entry.prefix === specifier)
  if (exact !== undefined) return firstExisting(known, exact.target)
  for (const entries of packages.values()) {
    for (const entry of entries) {
      if (!entry.prefix.includes("*")) continue
      const [head, tail] = entry.prefix.split("*") as [string, string]
      if (!specifier.startsWith(head) || !specifier.endsWith(tail)) continue
      const middle = specifier.slice(head.length, specifier.length - tail.length)
      return firstExisting(known, entry.target.replace("*", middle))
    }
  }
  return null
}

const resolveSpecifier = (
  packages: Map<string, Exports>,
  imports: Imports,
  known: Set<string>,
  from: string,
  specifier: string,
): string | null => {
  if (specifier.startsWith("#")) return resolveImport(imports, known, from, specifier)
  if (specifier.startsWith("."))
    return firstExisting(known, normalize(join(dirname(from), specifier)))
  if (specifier.startsWith("@novadeck/")) return resolvePackage(packages, known, specifier)
  return null
}

const note = (from: string, specifier: string) => {
  const pattern = specifier.startsWith("@novadeck/")
    ? "@novadeck/*"
    : specifier.startsWith(".")
      ? "relative"
      : specifier.startsWith("#")
        ? "#*"
        : "other"
  const key = `${pattern} (${from.split("/")[0]})`
  unresolved.set(key, (unresolved.get(key) ?? 0) + 1)
}

const tally = (
  links: Map<string, AreaLink>,
  from: string | null,
  to: string | null,
  kind: Kind,
) => {
  if (from === null || to === null || from === to) return
  const key = `${kind}\0${from}\0${to}`
  const link = links.get(key)
  if (link === undefined) links.set(key, { from, to, kind, weight: 1 })
  else link.weight += 1
}

// How areas depend on each other: imports between their files, procedures one calls and
// another serves, and tables one queries and another owns.
export const extractLinks = (
  repo: string,
  anchors: Anchors,
  areas: Area[],
  owned: { api: Api; data: Data },
): AreaLink[] => {
  const links = new Map<string, AreaLink>()
  const files = trackedFiles(repo, roots).filter(
    (file) => sourcePattern.test(file) && !skipPattern.test(file),
  )
  const known = new Set(trackedFiles(repo, roots))
  const packages = workspacePackages(repo, anchors)
  const imports = packageImports(repo, anchors)
  unresolved.clear()

  for (const file of files.filter((candidate) => !candidate.endsWith(".rs"))) {
    const source = anchors.read(file)
    if (source === null) continue
    for (const specifier of specifiersOf(source)) {
      const target = resolveSpecifier(packages, imports, known, file, specifier)
      if (target === null) {
        if (/^(?:\.|#|@novadeck\/)/.test(specifier)) note(file, specifier)
        continue
      }
      tally(links, areaOf(areas, file), areaOf(areas, target), "import")
    }
  }

  for (const procedure of owned.api.procedures) {
    const to = procedure.handler === null ? null : areaOf(areas, procedure.handler.file)
    for (const caller of procedure.callers) tally(links, areaOf(areas, caller.file), to, "call")
  }

  for (const table of owned.data.tables) {
    const to = areaOf(areas, table.anchor.file)
    for (const user of [...table.readers, ...table.writers])
      tally(links, areaOf(areas, user.file), to, "data")
  }

  if (process.env.ATLAS_DEBUG !== undefined) console.warn(unresolved)
  return [...links.values()].toSorted((a, b) => b.weight - a.weight)
}
