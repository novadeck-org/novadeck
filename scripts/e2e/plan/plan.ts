// What the E2E workflow runs, decided from what a pull request changed. Pure: `main.ts`
// gathers the facts (the event, turbo's affected packages, git's changed files).

// The table's source, which imports nothing, so the plan needs no package built first.
import { harnesses } from "../../../application/protocol/src/harnesses.ts"

/** The facts a decision rests on; `undefined` where they couldn't be had. */
export type Facts = {
  /** The workflow's event (`pull_request`, `schedule`, `workflow_dispatch`). */
  readonly event: string
  /** Names of the workspace packages turbo calls affected, dependents included. */
  readonly affected: readonly string[] | undefined
  /** The runner and every package it builds on, dependencies of dependencies included. */
  readonly runner: readonly string[] | undefined
  /** Paths git calls changed, relative to the repository's root, with `/` as separator. */
  readonly files: readonly string[] | undefined
}

// The packages a change in which runs no harness of its own: the runner is reported
// affected by any package it depends on, an adapter's too, which would run everything for a
// change to one harness; its own changes are told by its files instead (`sharedFolders`).
// Any other package the runner builds on (harness-core, the protocol, the relay, the
// engines, the libraries, or one added later) can break any harness, so it runs everything.
// A package it doesn't build on (the UI, the host, the viewers) can break none.
const unshared = new Set(["@novadeck/runner"])

// What lies outside every package yet inside what the suite runs on or how CI runs it, and
// the runner, where the suite and the pins live. A change to any of these runs every harness.
const sharedFiles = new Set([
  ".github/workflows/e2e.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
])
export const sharedFolders = [
  ".github/actions/e2e-harness-cache/",
  "application/runner/",
  // The terminal library, with node-pty's patch: the suite's pty. The emulator's patches
  // belong to its package, which reaches the suite as an affected package like any other.
  "libraries/terminal/",
  "scripts/e2e/",
]

// Linux is where the suite runs for any change that can reach the runner. Windows and macOS
// run it only where the system itself can tell: what starts processes, owns a pty, speaks
// the wire, or installs and drives a harness. Each is slower and, on macOS, scarce (a free
// account runs about five macOS jobs at once), so what is platform-neutral stays off them:
//
// - Linux alone: the protocol (schemas and types, no system call), the engines (the suite
//   builds none), the lockfile and the dependency configuration (`package.json`,
//   `pnpm-workspace.yaml`, `turbo.json`: a moved version that breaks one system shows on
//   every system that installs it, and the next change to the runner, a harness or the
//   nightly run finds it; node-pty, the one native module the suite loads, is pinned in
//   the catalog here too, but its patch is named for its version under
//   `libraries/terminal/`, so a bump renames or drops it there, which runs every system).
// - Every system: the runner, `libraries/terminal` (the pty and the host), `libraries/wire`,
//   the emulator's headless side, the harnesses, the relay, `libraries/sandbox` (the suite's
//   own sandbox, whose process tables and Git Bash lookup differ on each system), node-pty's
//   patch (Windows code alone, in `libraries/terminal`), and the way CI runs the suite (`scripts/e2e/`,
//   the workflow, the harness cache's actions), which changes how each system runs it.
//
// The emulator's browser-only side (its view, renderer and the patch of xterm's browser
// package) is not the headless side the suite runs, so it stays off them
// (`browserOnlyFiles`); the rest of the emulator, new files included, runs every system.
const allSystemsFiles = new Set([".github/workflows/e2e.yml"])
export const browserOnlyFiles = [
  "libraries/emulator/patches/@xterm__xterm@",
  "libraries/emulator/src/browser.",
  "libraries/emulator/src/renderer.",
  "libraries/emulator/src/view.",
]
export const allSystemsFolders = [
  ".github/actions/e2e-harness-cache/",
  "application/relay/",
  "application/runner/",
  "harnesses/",
  "libraries/emulator/",
  "libraries/sandbox/",
  "libraries/terminal/",
  "libraries/wire/",
  "scripts/e2e/",
]

/** The runners a job runs on, one per system, in the order of the matrix. */
export const systems = {
  linux: "ubuntu-latest",
  windows: "windows-latest",
  macos: "macos-latest",
} as const
const everySystem: readonly string[] = [systems.linux, systems.windows, systems.macos]

/** The adapter package of a harness. */
export const adapterOf = (id: string): string => `@novadeck/harness-${id}`

/**
 * The harnesses whose rows run. All of them when nothing says otherwise (a nightly or
 * manual run, or facts missing, which can't be told from everything changing); none when
 * the change is nothing the suite runs on.
 */
export const select = (facts: Facts, ids: readonly string[]): readonly string[] => {
  if (facts.event !== "pull_request") return ids
  const { affected, files, runner } = facts
  if (!affected || !files || !runner) return ids
  const adapters = new Set(ids.map(adapterOf))
  const reached = affected.filter((name) => runner.includes(name))
  if (reached.some((name) => !adapters.has(name) && !unshared.has(name))) return ids
  if (files.some((file) => sharedFiles.has(file) || sharedFolders.some((f) => file.startsWith(f))))
    return ids
  return ids.filter((id) => affected.includes(adapterOf(id)))
}

/**
 * The systems the rows run on. Linux alone unless a change can break a system but not the
 * others (`allSystemsFolders`); all three when nothing says otherwise, as for `select`.
 */
export const selectSystems = (facts: Facts): readonly string[] => {
  if (facts.event !== "pull_request") return everySystem
  const { files } = facts
  if (!files) return everySystem
  return files.some(
    (file) =>
      allSystemsFiles.has(file) ||
      (allSystemsFolders.some((f) => file.startsWith(f)) &&
        !browserOnlyFiles.some((f) => file.startsWith(f))),
  )
    ? everySystem
    : [systems.linux]
}

/** One row of the `e2e` job's matrix. */
export type Setup = {
  readonly agents: string
  readonly name: string
  readonly files?: string
}

/** One row of the `quirks` job's matrix. */
export type Quirk = {
  readonly agents: string
  readonly name: string
  readonly files: string
  readonly autorun?: true
}

// A harness's display name, as the protocol's table has it; its id where the table has no
// row for it yet.
const nameOf = (id: string): string => harnesses.find((each) => each.id === id)?.name ?? id

/**
 * The rows of the `e2e` job: each selected harness alone, then Mixed, which runs every
 * harness at once for the scenarios across harnesses (`*.mixed.e2e.ts`) the others skip.
 */
export const setups = (selected: readonly string[], ids: readonly string[]): readonly Setup[] =>
  selected.length === 0
    ? []
    : [
        ...selected.map((id) => ({ agents: id, name: nameOf(id) })),
        { agents: ids.join(","), name: "Mixed", files: "mixed.e2e.ts" },
      ]

const core = "messaging.e2e.ts requests.e2e.ts lifecycle.e2e.ts"

/**
 * The rows of the `quirks` job, one per selected harness. Each runs the core scenarios;
 * Claude Code's job also runs the registry's PATH, which needs no harness and so runs in
 * one job. Antigravity's runs the cmd AutoRun last, as it turns Antigravity's messaging
 * off by design.
 */
export const quirks = (selected: readonly string[]): readonly Quirk[] =>
  selected.map((id) => ({
    agents: id,
    name: nameOf(id),
    files: id === "claude" ? `${core} windows-quirks.e2e.ts` : core,
    ...(id === "agy" ? { autorun: true as const } : {}),
  }))

/** What the workflow's jobs read. */
export type Plan = {
  readonly run: boolean
  /** The `runs-on` of each system the `e2e` job runs on; the `quirks` job needs Windows. */
  readonly os: readonly string[]
  readonly e2e: readonly Setup[]
  readonly quirks: readonly Quirk[]
}

export const plan = (facts: Facts, ids: readonly string[]): Plan => {
  const selected = select(facts, ids)
  // With nothing to run the jobs are skipped, but their matrices still name every row: a
  // skipped job's matrix is never run, and an empty one is an error where Actions reads it.
  const rows = selected.length > 0 ? selected : ids
  return {
    run: selected.length > 0,
    os: selected.length > 0 ? selectSystems(facts) : everySystem,
    e2e: setups(rows, ids),
    quirks: quirks(rows),
  }
}

/** The package names of `turbo ls --output json`, or `undefined` if it isn't that. */
export const parseAffected = (output: string): readonly string[] | undefined => {
  try {
    const items = (JSON.parse(output) as { packages?: { items?: unknown } }).packages?.items
    if (!Array.isArray(items)) return undefined
    const found = items.map((item: { name?: unknown }) => item?.name)
    return found.every((name) => typeof name === "string") ? (found as string[]) : undefined
  } catch {
    return undefined
  }
}
