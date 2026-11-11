import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// What each workspace package says about itself in its package.json, under `novadeck`:
//
//     "novadeck": { "platform": "system" | "neutral" }
//
// `system`: its code or tests touch the operating system (processes, a PTY, signals, native
// modules, Electron's main process, shell or filesystem behavior that differs by system).
// `neutral`: its tests can't come out differently on Linux, Windows and macOS, including through
// what it depends on, so they run on Linux alone, even when a `system` package it depends on
// changed. The lint fence (`fence.ts`) keeps a `neutral` package from importing what would make
// it `system`, but sees only its own imports: the nightly full run on every system covers what
// it can't see. CI reads the declaration to choose where a package's tests run; one missing or
// misspelled reads as `system`, so a mistake runs more, never less.

export type Platform = "system" | "neutral"

/** The part of a package.json this reads. */
export type Declared = {
  readonly name?: unknown
  readonly novadeck?: { readonly platform?: unknown; readonly reads?: unknown }
}

/** A package's platform as it declares it, or `undefined` where it declares none or no known one. */
export const declaredPlatform = (manifest: Declared): Platform | undefined => {
  const platform = manifest.novadeck?.platform
  return platform === "system" || platform === "neutral" ? platform : undefined
}

/** A package's platform as CI takes it: what it declares, and `system` where that can't be read. */
export const platformOf = (manifest: Declared): Platform => declaredPlatform(manifest) ?? "system"

/**
 * What a package's code or tests read by path outside its own folder and the packages it
 * depends on, each a folder or file relative to the repository's root (`""` for all of it):
 *
 *     "novadeck": { "platform": "neutral", "reads": ["frontend", "apps"] }
 *
 * The package graph can't see such a read, so CI counts the package affected by a change under
 * any of them, and the reach fence (reach.ts) refuses one it doesn't list. `undefined` where the
 * list can't be read, which CI takes as everything.
 */
export const declaredReads = (manifest: Declared): readonly string[] | undefined => {
  const reads = manifest.novadeck?.reads
  if (reads === undefined) return []
  if (!Array.isArray(reads)) return undefined
  const readable = reads.every(
    (each): each is string =>
      typeof each === "string" &&
      !each.startsWith("/") &&
      !each.endsWith("/") &&
      !each.includes("\\") &&
      !each.split("/").some((part) => part === ".." || part === "."),
  )
  return readable ? reads : undefined
}

/** Whether a path relative to the root is under one of `reads`. */
export const isRead = (reads: readonly string[], path: string): boolean =>
  reads.some((read) => read === "" || path === read || path.startsWith(`${read}/`))

/**
 * The folder globs of `pnpm-workspace.yaml`'s `packages`, read without a YAML parser: each is a
 * `- tree/*` line under the key. Anything else there (a deeper glob, a negation) is refused,
 * as the folders below couldn't then be told from it.
 */
export const workspaceTrees = (yaml: string): readonly string[] => {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line))
  if (start === -1) throw new Error("pnpm-workspace.yaml has no packages")
  const trees: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue
    const entry = /^\s+-\s+["']?([^"'\s]+)["']?\s*$/.exec(line)?.[1]
    if (!entry) break
    const tree = /^([a-z][a-z0-9-]*)\/\*$/.exec(entry)?.[1]
    if (!tree) throw new Error(`pnpm-workspace.yaml: ${entry} is not a folder of packages`)
    trees.push(tree)
  }
  return trees
}

/** A workspace package: its folder, relative to the root with `/`, and its package.json. */
export type Package = { readonly folder: string; readonly manifest: Declared }

/** Every workspace package under `root`, in folder order. */
export const workspacePackages = (root: string): readonly Package[] =>
  workspaceTrees(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"))
    .filter((tree) => existsSync(join(root, tree)))
    .flatMap((tree) =>
      readdirSync(join(root, tree))
        .map((name) => `${tree}/${name}`)
        .filter((folder) => existsSync(join(root, folder, "package.json"))),
    )
    .toSorted()
    .map((folder) => ({
      folder,
      manifest: JSON.parse(readFileSync(join(root, folder, "package.json"), "utf8")) as Declared,
    }))

// What makes a package `system` when it imports it at run time (a type alone is erased).
// Node's modules for processes, the system's own facts, terminals and sockets, by their names
// with and without `node:`; Electron, whose main side is the system's, and the native modules;
// the sandbox, which runs and kills processes; and the subpaths of a workspace package that run
// a PTY, a host, a shell or Electron's main side, as the browser code's fence names them.
// What reads and writes files is left out: what a test reads by a path joined from its own
// folder is the same on every system, and what differs (modes, links, case) is rare in a
// package that also does nothing above.
const systemBuiltins = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "dns/promises",
  "net",
  "os",
  "tls",
  "tty",
])
const systemPackages = new Set(["electron", "node-pty", "koffi", "@novadeck/sandbox"])
const systemSubpaths = ["pty", "host", "shell", "electron", "browser/host"]

// From `os`, the temporary folder alone: where a test writes its scratch files, the same on
// every system once joined.
const neutralFromOs = new Set(["tmpdir"])

/**
 * Why importing `source` at run time makes a package `system`, or `undefined` where it doesn't.
 * `names` are the bindings an import takes by name (`undefined` for a namespace, a default, a
 * re-export or a dynamic import, which take everything).
 */
export const systemImport = (source: string, names?: readonly string[]): string | undefined => {
  const builtin = source.startsWith("node:") ? source.slice("node:".length) : source
  if (systemBuiltins.has(builtin)) {
    if (builtin === "os" && names && names.every((name) => neutralFromOs.has(name)))
      return undefined
    return `Node's ${builtin} module reaches the system`
  }
  const [scope = "", name = "", ...rest] = source.split("/")
  const bare = scope.startsWith("@") ? `${scope}/${name}` : scope
  if (systemPackages.has(bare)) return `${bare} reaches the system`
  const subpath = (scope.startsWith("@") ? rest : [name, ...rest]).join("/")
  if (
    scope === "@novadeck" &&
    systemSubpaths.some((each) => subpath === each || subpath.startsWith(`${each}/`))
  )
    return `${source} runs on the system's side`
  return undefined
}

// The properties of `process` that read or act on the system it runs on.
const systemProcess = new Set(["platform", "arch", "kill", "getuid", "getgid"])

/** Why reading `process.<property>` makes a package `system`, or `undefined` where it doesn't. */
export const systemProperty = (property: string): string | undefined =>
  systemProcess.has(property) ? `process.${property} differs by system` : undefined
