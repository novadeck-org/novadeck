import { execFileSync } from "node:child_process"
import { join } from "node:path"

import { roots } from "../content/areas.ts"
import { builtins, categories, roles } from "../content/stack.ts"
import type { Area, Dependency, PackageStack } from "../src/atlas.ts"
import type { Anchors } from "./anchors.ts"

type Manifest = {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
}

// A library's curated role: its own entry, else its scope's (`@xterm/*`).
const roleOf = (name: string) =>
  roles[name] ?? (name.startsWith("@") ? roles[`${name.split("/")[0]}/*`] : undefined) ?? null

const dependency = (name: string, version: string, kind: Dependency["kind"]): Dependency => {
  const role = roleOf(name)
  return {
    name,
    version,
    kind,
    role: role?.role ?? null,
    category: role?.category ?? null,
    lead: role?.lead ?? false,
  }
}

const fromManifest = (manifest: Manifest): Dependency[] =>
  [
    ...Object.entries(manifest.dependencies ?? {}).map(([name, version]) => ({
      name,
      version,
      dev: false,
    })),
    ...Object.entries(manifest.devDependencies ?? {}).map(([name, version]) => ({
      name,
      version,
      dev: true,
    })),
  ]
    // Type packages only describe another dependency.
    .filter(({ name }) => !name.startsWith("@types/"))
    .map(({ name, version, dev }) =>
      dependency(
        name,
        version,
        version.startsWith("workspace:") ? "workspace" : dev ? "dev" : "runtime",
      ),
    )

// `name = "1"` and `name = { version = "1", … }` under any [*dependencies] table.
const fromCargo = (text: string): Dependency[] => {
  const found: Dependency[] = []
  let table = ""
  for (const line of text.split("\n")) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line)
    if (header) {
      table = header[1]!
      continue
    }
    if (!table.endsWith("dependencies")) continue
    const entry = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*?version\s*=\s*"([^"]+)")/.exec(line)
    if (entry)
      found.push(
        dependency(entry[1]!, entry[2] ?? entry[3]!, table.includes("dev-") ? "dev" : "runtime"),
      )
  }
  return found
}

// Built-in modules a package imports, which no manifest lists.
const builtinsIn = (repo: string, dir: string, node: string | undefined): Dependency[] =>
  builtins.flatMap((module) => {
    try {
      execFileSync("git", ["grep", "-q", "-F", `"${module}"`, "--", dir], { cwd: repo })
      return [dependency(module, node ? `node ${node}` : "node", "runtime")]
    } catch {
      return []
    }
  })

// Curated libraries in the order content/stack.ts lists them, the rest by shelf, then name.
const order = Object.keys(roles)
const keyOf = (name: string) =>
  name in roles ? name : name.startsWith("@") ? `${name.split("/")[0]}/*` : name
const rank = (dep: Dependency) => {
  const at = order.indexOf(keyOf(dep.name))
  return at === -1 ? order.length + categories.length : at
}

// Each package's dependencies, from its package.json (and Cargo.toml), with roles.
export const extractStacks = (repo: string, anchors: Anchors, areas: Area[]): PackageStack[] => {
  const known = new Set(areas.map((area) => area.id))
  const node = anchors.readJson<Manifest>("package.json")?.engines?.["node"]
  return roots.flatMap((root) => {
    const path = join(root.dir, "package.json")
    const manifest = anchors.readJson<Manifest>(path)
    if (!known.has(root.token) || manifest === null) return []
    const cargo = anchors.read(join(root.dir, "Cargo.toml"))
    const deps = [
      ...builtinsIn(repo, root.dir, node),
      ...fromManifest(manifest),
      ...(cargo === null ? [] : fromCargo(cargo)),
    ].toSorted((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    return [
      {
        token: root.token,
        name: manifest.name ?? root.token,
        manifest: { file: path, line: anchors.find(path, '"dependencies"') ?? 1 },
        deps,
      },
    ]
  })
}
