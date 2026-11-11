import { installed } from "../../libraries/graph.ts"

// The workspace's package graph read from its manifests, as turbo reads it: an edge for each
// workspace package a package names in any kind of dependency. The replay works out each past
// merge's facts with it, where turbo, which reads only the checked-out tree, can't.

/** The part of a package.json the graph reads. */
export type Manifest = {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
}

const kinds = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

/** Each package's workspace dependencies, by name. */
export type Graph = ReadonlyMap<string, readonly string[]>

export const graphOf = (manifests: readonly Manifest[]): Graph => {
  const names = new Set(manifests.map(({ name }) => name))
  return new Map(
    manifests.map((manifest) => [
      manifest.name,
      [
        ...new Set(
          kinds
            .flatMap((kind) => Object.entries(manifest[kind] ?? {}))
            .map(([key, spec]) => installed(key, spec))
            .filter((name) => names.has(name) && name !== manifest.name),
        ),
      ].toSorted(),
    ]),
  )
}

/** `start` and every package it depends on, through any kind of dependency: turbo's `name...`. */
export const dependencies = (graph: Graph, start: string): readonly string[] => {
  const seen = new Set<string>()
  const visit = (name: string): void => {
    if (seen.has(name) || !graph.has(name)) return
    seen.add(name)
    for (const next of graph.get(name) ?? []) visit(next)
  }
  visit(start)
  return [...seen].toSorted()
}

/** The packages changed and every package that depends on one: turbo's `--affected`. */
export const affected = (graph: Graph, changed: Iterable<string>): readonly string[] => {
  const dependents = new Map<string, string[]>()
  for (const [name, each] of graph)
    for (const dependency of each)
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), name])
  const seen = new Set<string>()
  const visit = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    for (const next of dependents.get(name) ?? []) visit(next)
  }
  for (const name of changed) visit(name)
  return [...seen].toSorted()
}
