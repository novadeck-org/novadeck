import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"

import { dependencies, graphOf, type Manifest } from "../ci/plan/graph.ts"
import { type Declared, workspacePackages, workspaceTrees } from "./platform.ts"

// Where a file sits in the workspace, for the lint rules (fence.ts, reach.ts), which see one file
// at a time: its root (the nearest folder above it with a `pnpm-workspace.yaml`), its package,
// and what that package depends on. Each is read once per run and kept.

const roots = new Map<string, string | undefined>()
/** The workspace's root above a folder, or `undefined` where there is none. */
export const rootAbove = (folder: string): string | undefined => {
  if (roots.has(folder)) return roots.get(folder)
  const parent = dirname(folder)
  const found = existsSync(join(folder, "pnpm-workspace.yaml"))
    ? folder
    : parent === folder
      ? undefined
      : rootAbove(parent)
  roots.set(folder, found)
  return found
}

const trees = new Map<string, ReadonlySet<string>>()
const treesOf = (root: string): ReadonlySet<string> => {
  const found =
    trees.get(root) ??
    new Set(workspaceTrees(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")))
  trees.set(root, found)
  return found
}

/** A path relative to the root, with `/` as separator. */
export const fromRoot = (root: string, path: string): string =>
  relative(root, path).split(sep).join("/")

/** The package folder (relative to the root) a path relative to the root is in, if any. */
export const packageFolderOf = (root: string, path: string): string | undefined => {
  const [tree, name] = path.split("/")
  if (!tree || !name || !treesOf(root).has(tree)) return undefined
  const folder = `${tree}/${name}`
  return existsSync(join(root, folder, "package.json")) ? folder : undefined
}

/** A file's workspace package: the root, and the package's folder relative to it. */
export const packageOf = (file: string): { root: string; folder: string } | undefined => {
  const root = rootAbove(dirname(file))
  if (!root) return undefined
  const folder = packageFolderOf(root, fromRoot(root, file))
  return folder ? { root, folder } : undefined
}

const manifests = new Map<string, Declared>()
/** A package's package.json, by its folder. */
export const manifestOf = (root: string, folder: string): Declared => {
  const key = join(root, folder)
  const found =
    manifests.get(key) ?? (JSON.parse(readFileSync(join(key, "package.json"), "utf8")) as Declared)
  manifests.set(key, found)
  return found
}

const folders = new Map<string, readonly string[]>()
/** Every package's folder, relative to the root. */
export const packageFolders = (root: string): readonly string[] => {
  const found = folders.get(root) ?? workspacePackages(root).map(({ folder }) => folder)
  folders.set(root, found)
  return found
}

const closures = new Map<string, ReadonlySet<string>>()
/**
 * The folders of a package and of every package it depends on, through any kind of
 * dependency: what turbo counts it affected by.
 */
export const closureOf = (root: string, folder: string): ReadonlySet<string> => {
  const key = join(root, folder)
  const cached = closures.get(key)
  if (cached) return cached
  const packages = workspacePackages(root)
  const graph = graphOf(packages.map(({ manifest }) => manifest as Manifest))
  const folderOf = new Map(packages.map(({ folder: each, manifest }) => [manifest.name, each]))
  const found = new Set(
    dependencies(graph, String(manifestOf(root, folder).name)).flatMap(
      (name) => folderOf.get(name) ?? [],
    ),
  )
  closures.set(key, found)
  return found
}
