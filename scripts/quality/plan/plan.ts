// Where Quality's tests run, decided from what a pull request changed and from what each
// package says it is. Pure: `main.ts` gathers the facts (the event, turbo's affected packages,
// git's changed files) and the packages.

import { systems, systemsFor } from "../../e2e/plan/plan.ts"
import { type Package, platformOf } from "../../workspace/platform.ts"

/** The facts a decision rests on; `undefined` where they couldn't be had. */
export type Facts = {
  /** The workflow's event (`pull_request`, `schedule`, `workflow_dispatch`). */
  readonly event: string
  /** Names of the workspace packages turbo calls affected, dependents included. */
  readonly affected: readonly string[] | undefined
  /** Paths git calls changed, relative to the repository's root, with `/` as separator. */
  readonly files: readonly string[] | undefined
  /** Whether the pull request is a draft; anything else reads as not, so macOS runs. */
  readonly draft?: boolean
}

/**
 * The packages whose tests run on every system: those that declare `"novadeck": { "platform":
 * "system" }` (scripts/workspace/platform.ts), and any that declares nothing it can read, so a
 * mistake runs more on Windows and macOS, never less. A `neutral` package's tests run on Linux
 * alone on a pull request, and on every system in the nightly run.
 */
export const systemPackages = (packages: readonly Package[]): readonly Package[] =>
  packages.filter(({ manifest }) => platformOf(manifest) === "system")

/**
 * Whether a change can make a test pass on one system and fail on another: it affects a
 * `system` package, itself or through one it builds on, or it changes a file outside every
 * package other than prose, as the workflows, the scripts and the root's configuration change
 * how every system runs its tests. `undefined` where the facts are missing.
 */
export const touchesSystem = (facts: Facts, packages: readonly Package[]): boolean | undefined => {
  const { affected, files } = facts
  if (!affected || !files) return undefined
  const system = new Set(systemPackages(packages).map(({ manifest }) => manifest.name))
  if (affected.some((name) => system.has(name))) return true
  return files.some(
    (file) =>
      !file.endsWith(".md") && !packages.some(({ folder }) => file.startsWith(`${folder}/`)),
  )
}

/** What Quality's jobs read. */
export type Plan = {
  /** Whether the Windows and macOS tests run. */
  readonly windows: boolean
  readonly macos: boolean
  /**
   * Whether macOS's tests were needed but held back, as the pull request is a draft: marking
   * it ready runs them. The `Test` gate fails while they are, so a draft's run can't stand
   * for the pull request once it can merge.
   */
  readonly held: boolean
  /**
   * The folders of the packages macOS's job tests (`test:system`): every `system` package. It
   * is a list so that a plan which knows which of them a change affects can name only those.
   */
  readonly packages: readonly string[]
}

/**
 * The systems Quality's tests run on, by E2E's rule (`systemsFor`): every system unless the run
 * is a pull request whose change touches no system; Linux, which runs every test, always. A
 * draft holds macOS's back (`held`), Windows's not.
 */
export const plan = (facts: Facts, packages: readonly Package[]): Plan => {
  const chosen = systemsFor(facts.event, touchesSystem(facts, packages))
  const macos = chosen.includes(systems.macos)
  return {
    windows: chosen.includes(systems.windows),
    macos: macos && facts.draft !== true,
    held: macos && facts.draft === true,
    packages: systemPackages(packages).map(({ folder }) => folder),
  }
}

/** Turbo's filters for the packages in `folders`. */
export const filters = (folders: readonly string[]): readonly string[] =>
  folders.map((folder) => `--filter=./${folder}`)

/**
 * The folders `test:system` tests: those `NOVADECK_TEST_PACKAGES` names (a JSON list, the plan's
 * `packages`), or every `system` package where it names none or can't be read.
 */
export const testedFolders = (
  named: string | undefined,
  packages: readonly Package[],
): readonly string[] => {
  const every = systemPackages(packages).map(({ folder }) => folder)
  if (!named) return every
  try {
    const list: unknown = JSON.parse(named)
    const known = new Set(packages.map(({ folder }) => folder))
    if (Array.isArray(list) && list.length > 0 && list.every((folder) => known.has(folder)))
      return list as string[]
  } catch {}
  console.error(`NOVADECK_TEST_PACKAGES isn't a list of packages: testing every system package`)
  return every
}
