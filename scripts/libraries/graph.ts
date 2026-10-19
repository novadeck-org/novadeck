import { order } from "./order.ts"

// The package graph behind the import fence: a library's package.json may name, among the
// workspace's own packages, only the libraries its design depends on. pnpm links at the
// root only the root's own dependencies, which the fence refuses by name, so a library
// imports only the workspace packages it declares, and with this it can't reach app code or
// another library through them.

type Manifest = {
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

/**
 * The package a dependency installs: the name in an alias (`npm:<name>@…`,
 * `workspace:<name>@…`, the version optional), or else its key, as for `workspace:*` or
 * `workspace:^1.0.0`.
 */
export const installed = (key: string, spec: string): string =>
  /^(?:npm|workspace):(@[^/@]+\/[^@/]+|[a-z][^@/]*)(?:@|$)/.exec(spec)?.[1] ?? key

/**
 * Whether a dependency installs from a path, which may be any folder of the workspace:
 * `link:`, `file:`, `portal:`, `workspace:` with a path, or a bare path as pnpm reads one
 * (`./`, `../`, `/`, `~/`, a backslash, a drive letter, or a tarball's name).
 */
export const fromPath = (spec: string): boolean =>
  /^(?:link:|file:|portal:|workspace:(?:\.|\/|~\/)|\.|\/|~\/|\\|[a-zA-Z]:)/.test(spec) ||
  /^[^:]*\.(?:tgz|tar|tar\.gz)$/.test(spec)

/**
 * The dependencies the library in `folder` (its name in libraries/) names in its
 * package.json outside its order, each as `kind key`: every one that installs an
 * `@novadeck/` package but the libraries its design depends on, and every one installed
 * from a path. A library not in the order may name none.
 */
export const strayDependencies = (folder: string, manifest: Manifest): readonly string[] => {
  const allowed = new Set((order[folder] ?? []).map((name) => `@novadeck/${name}`))
  return kinds.flatMap((kind) =>
    Object.entries(manifest[kind] ?? {})
      .filter(([key, spec]) => {
        if (fromPath(spec)) return true
        const name = installed(key, spec)
        return name.startsWith("@novadeck/") && !allowed.has(name)
      })
      .map(([key]) => `${kind} ${key}`),
  )
}
