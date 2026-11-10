// What a pull request's CI runs, decided from the package graph and what each package and each
// folder outside a package says about itself (scripts/workspace/platform.ts, scopes.ts), with no
// list of paths to keep: which packages' tests run on each system, which E2E rows, and whether
// the app is packaged. Pure: `main.ts` gathers the facts. It fails open: any event but a pull
// request, a change outside every package that nothing narrows, and any fact it can't read or
// that contradicts another run everything.

import {
  adapterOf,
  quirks,
  rows,
  setups,
  systems,
  type Quirk,
  type Row,
  type Setup,
} from "../../e2e/plan/plan.ts"
import { isRead, type Platform } from "../../workspace/platform.ts"
import { isProse, type Scope, scopeOver } from "../../workspace/scopes.ts"

/** A workspace package: its name, its folder, its platform and what else it reads by path. */
export type Workspace = {
  readonly name: string
  /** Relative to the root, with `/` as separator. */
  readonly folder: string
  readonly platform: Platform
  readonly reads: readonly string[]
}

/** The facts a decision rests on; `undefined` where they couldn't be had. */
export type Facts = {
  /** The workflow's event (`pull_request`, `schedule`, `workflow_dispatch`, `push`). */
  readonly event: string
  /** Every workspace package, a missing declaration read as `system`. */
  readonly packages: readonly Workspace[] | undefined
  /** The scopes of folders outside every package, from their `ci-scope.json`. */
  readonly scopes: readonly Scope[] | undefined
  /** Names of the packages turbo calls affected: those changed and their dependents. */
  readonly affected: readonly string[] | undefined
  /** Paths git calls changed, relative to the repository's root, with `/` as separator. */
  readonly files: readonly string[] | undefined
  /** Names of the runner and every package it builds on: what the E2E suite runs. */
  readonly suite: readonly string[] | undefined
  /** Names of the desktop app and every package it is built from: what is packaged. */
  readonly packaged: readonly string[] | undefined
}

export type System = "linux" | "windows" | "macos"

/** The name the plan gives the repository's own tests (scripts/**\/*.test.ts), as turbo does. */
export const repository = "//"

/** The E2E workflow's jobs, as `scripts/e2e/plan` gives them. */
export type E2E = {
  readonly run: boolean
  /** The `runs-on` of each system the `e2e` job runs on. */
  readonly os: readonly string[]
  readonly e2e: readonly Setup[]
  readonly rows: readonly Row[]
  readonly quirks: readonly Quirk[]
}

export type Plan = {
  /** Why everything runs, or `undefined` where the plan follows the change. */
  readonly everything: string | undefined
  /**
   * The names of the packages whose tests run on each system, `//` for the repository's own,
   * or `all`: every package's and the repository's, whatever the workspace holds.
   */
  readonly tests: Readonly<Record<System, "all" | readonly string[]>>
  readonly e2e: E2E
  /** Whether the packaging jobs run. */
  readonly package: boolean
}

/** What the replay turns off to measure what each narrowing saves; CI uses neither. */
export type Options = {
  /** Whether prose outside every package reaches only its declared readers. */
  readonly prose?: boolean
  /** Whether Windows and macOS wait for a changed `system` package. */
  readonly gate?: boolean
}

// Files in a package that no build reads: its tests, specs and end-to-end scenarios, and
// its prose. A change to only these can't change the packaged app.
const unbuilt = [/\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/, /(?:^|\/)src\/(?:specs|e2e)\//, /\.md$/]

/** The package a file is in, or `undefined` where it is in none. */
export const packageOf = (file: string, packages: readonly Workspace[]): Workspace | undefined =>
  packages.find(({ folder }) => file.startsWith(`${folder}/`))

/** The E2E jobs for the harnesses `selected` of `ids`, on the systems `os`. */
const e2eOf = (selected: readonly string[], os: readonly string[], ids: readonly string[]): E2E => {
  // With nothing to run the jobs are skipped, but their matrices still name every row: a
  // skipped job's matrix is never run, and an empty one is an error where Actions reads it.
  const chosen = selected.length > 0 ? selected : ids
  const where = selected.length > 0 ? os : Object.values(systems)
  const e2e = setups(chosen, ids)
  return {
    run: selected.length > 0,
    os: where,
    e2e,
    rows: rows(where, e2e),
    quirks: quirks(chosen),
  }
}

/** Everything, on every system, for the reason given. */
const everything = (why: string, ids: readonly string[]): Plan => ({
  everything: why,
  tests: { linux: "all", windows: "all", macos: "all" },
  e2e: e2eOf(ids, Object.values(systems), ids),
  package: true,
})

/** Why the facts can't be followed, or `undefined` where they can. */
const unreadable = (facts: Facts, prose: boolean): string | undefined => {
  if (facts.event !== "pull_request") return `a ${facts.event || "run with no event"}`
  const { packages, scopes, affected, files, suite, packaged } = facts
  const missing = Object.entries({ packages, scopes, affected, files, suite, packaged }).find(
    ([, fact]) => fact === undefined,
  )?.[0]
  if (missing !== undefined || !packages || !scopes || !affected || !files || !suite || !packaged)
    return `the ${missing ?? "facts"} couldn't be read`
  const known = new Set(packages.map(({ name }) => name))
  const unknown = [...affected, ...suite, ...packaged].find((name) => !known.has(name))
  if (unknown !== undefined) return `${unknown} isn't a workspace package`
  // Outside every package, only prose and a folder whose scope narrows it are followed.
  const outside = files.find(
    (file) => !packageOf(file, packages) && !(prose && isProse(file)) && !scopeOver(scopes, file),
  )
  if (outside !== undefined) return `${outside} is outside every package`
  const missed = files
    .map((file) => packageOf(file, packages)?.name)
    .find((name) => name !== undefined && !affected.includes(name))
  if (missed !== undefined) return `${missed} changed but isn't affected`
  return undefined
}

/**
 * What runs for a change. Linux runs the tests of every affected package (turbo's, and each
 * package that declares it reads a changed path), and the repository's own tests, which read
 * the packages' files and are quick. Windows and macOS run those of every affected `system`
 * package, and only when a changed package is `system`: a `neutral` package's tests can't come
 * out differently by system, so its change shows on Linux, as the E2E plan has always held for
 * the protocol. Prose outside every package reaches only its readers; a folder whose scope is
 * `repository` reaches only the repository's tests, on Linux, and its readers. The E2E rows are each changed harness's,
 * or every harness's where a package the runner builds on changed that is no harness's own, on
 * every system where such a package is `system` and on Linux alone otherwise. The app is
 * packaged where a changed file is one a package it is built from builds.
 */
export const plan = (facts: Facts, ids: readonly string[], options: Options = {}): Plan => {
  const { prose = true, gate = true } = options
  const why = unreadable(facts, prose)
  if (why !== undefined) return everything(why, ids)
  // Read above: every fact is there.
  const packages = facts.packages!
  const files = facts.files!
  const suite = new Set(facts.suite)
  const packaged = new Set(facts.packaged)
  const inside = files.filter((file) => packageOf(file, packages))
  const changed = new Set(inside.map((file) => packageOf(file, packages)!.name))
  const readers = packages
    .filter(({ reads }) => files.some((file) => isRead(reads, file)))
    .map(({ name }) => name)
  const affected = new Set([...facts.affected!, ...readers])
  const system = new Set(
    packages.filter(({ platform }) => platform === "system").map(({ name }) => name),
  )
  const onAll = !gate || [...changed].some((name) => system.has(name))
  const linux = packages
    .map(({ name }) => name)
    .filter((name) => affected.has(name))
    .toSorted()
  const others = onAll ? linux.filter((name) => system.has(name)) : []

  const adapters = new Set(ids.map(adapterOf))
  const run = [...changed].filter((name) => suite.has(name))
  const selected = run.some((name) => !adapters.has(name))
    ? ids
    : ids.filter((id) => changed.has(adapterOf(id)))
  const os = run.some((name) => system.has(name)) ? Object.values(systems) : [systems.linux]

  return {
    everything: undefined,
    tests: { linux: [repository, ...linux], windows: others, macos: others },
    e2e: e2eOf(selected, os, ids),
    package: inside.some(
      (file) =>
        packaged.has(packageOf(file, packages)!.name) &&
        !unbuilt.some((pattern) => pattern.test(file)),
    ),
  }
}
