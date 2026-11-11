// Where Quality's tests run, from what the change's plan (scripts/ci/plan, from the package
// graph) says each system tests, and from what each package says it is. Pure: `main.ts` gathers
// the facts and the packages.

import { repository, type System } from "../../ci/plan/plan.ts"
import { type Package, platformOf } from "../../workspace/platform.ts"

/** The facts a decision rests on. */
export type Facts = {
  /**
   * What scripts/ci/plan says each system tests: the names of the packages, `//` for the
   * repository's own tests, or `all`, for a run that follows no change or one it can't read.
   */
  readonly tests: Readonly<Record<System, "all" | readonly string[]>>
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

/** One row of a Windows or macOS test job's matrix: what the steps read. */
export type Row = {
  readonly name: string
  readonly os: string
  readonly browser?: boolean
  readonly relay?: boolean
  readonly electron?: boolean
  readonly shard: number
  readonly command: string
}

/**
 * Windows's rows for every test, as Linux's in three parts (the root's `test:shard1`-`3`): what
 * it ran before it followed the change. Its two browser parts run the specs' Mac pass too
 * (frontend/specs' `eachPlatform`). quality.yml falls back to these where the plan's are missing.
 */
export const wholeWindows: readonly Row[] = [
  {
    name: "Test (Windows, 1/3)",
    os: "windows-latest",
    browser: true,
    relay: true,
    shard: 1,
    command: "npm run test:shard1",
  },
  {
    name: "Test (Windows, 2/3)",
    os: "windows-latest",
    browser: true,
    electron: true,
    shard: 2,
    command: "npm run test:shard2",
  },
  { name: "Test (Windows, 3/3)", os: "windows-latest", shard: 3, command: "npm run test:shard3" },
]

/**
 * Windows's one row for the `system` packages a change affects (`test:system`), with a browser,
 * the relay and Electron for the packages that need them.
 */
export const systemWindows: readonly Row[] = [
  {
    name: "Test (Windows)",
    os: "windows-latest",
    browser: true,
    relay: true,
    electron: true,
    shard: 0,
    command: "npm run test:system",
  },
]

/** macOS's row for every test (the root's `test`): what it ran before it followed the change. */
export const wholeMacos: readonly Row[] = [
  {
    name: "Test (macOS)",
    os: "macos-latest",
    browser: true,
    relay: true,
    electron: true,
    shard: 0,
    command: "npm run test",
  },
]

/** macOS's row for the `system` packages a change affects, one at a time (`test:system`). */
export const systemMacos: readonly Row[] = [{ ...wholeMacos[0]!, command: "npm run test:system" }]

/**
 * Three lists the plan gives real changes, as at #853's reland (scripts/ci/plan over a one-file
 * change to the file named): what the proof rows run `test:system` over. The first is canary
 * #854's, whose Windows job failed where the shards had passed, as `test:system` built the
 * relay before runner-adapter's tests; the second has the relay built and tested beside the
 * runner; the third is the widest narrowed list, browser packages in the serial group.
 */
export const proofLists: readonly {
  readonly key: string
  readonly change: string
  readonly packages: readonly string[]
}[] = [
  {
    key: "runner",
    change: "backend/runner/src/app.test.ts",
    packages: [
      "tools/atlas",
      "frontend/chat-contract",
      "apps/desktop",
      "backend/runner",
      "frontend/runner-adapter",
    ],
  },
  {
    key: "relay",
    change: "backend/relay/src/main.rs",
    packages: [
      "tools/atlas",
      "frontend/chat-contract",
      "apps/desktop",
      "backend/relay",
      "backend/runner",
      "frontend/runner-adapter",
    ],
  },
  {
    key: "terminal",
    change: "libraries/terminal/src/pty.ts",
    packages: [
      "tools/atlas",
      "tools/build-kit",
      "frontend/chat-contract",
      "apps/desktop",
      "harnesses/agy",
      "harnesses/claude",
      "harnesses/codex",
      "harnesses/core",
      "backend/runner",
      "frontend/runner-adapter",
      "libraries/terminal",
      "frontend/terminal-views",
    ],
  },
]

/** A proof row: a system's narrowed row over one of `proofLists`, under a name of its own. */
export type ProofRow = Row & { readonly proof: string; readonly packages: readonly string[] }

/** The proof rows of a system, one per list in `proofLists`. */
export const proofRows = (system: "windows" | "macos"): readonly ProofRow[] =>
  proofLists.map(({ key, packages }) => ({
    ...(system === "windows" ? systemWindows[0]! : systemMacos[0]!),
    name: `Proof (${system === "windows" ? "Windows" : "macOS"}, ${key})`,
    proof: key,
    packages,
  }))

// What decides how Windows's and macOS's tests run: a change to one of these can change the
// narrowed rows, which the change's own run, planned `all`, never runs.
const proven = [
  ".github/workflows/quality.yml",
  "scripts/quality/plan/",
  "scripts/ci/plan/",
  "scripts/workspace/",
  "package.json",
  "turbo.json",
  "pnpm-workspace.yaml",
]

/**
 * Whether a pull request's run proves the narrowed rows (`proofRows`): where it changes how they
 * test. A pull request whose files couldn't be read proves nothing: it runs every test anyway.
 */
export const proves = (files: readonly string[] | undefined): boolean =>
  files?.some((file) =>
    proven.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)),
  ) ?? false

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
  /** The Windows job's matrix: every test in three parts, or the affected `system` packages. */
  readonly windowsRows: readonly Row[]
  /** The folders of the packages Windows's `test:system` tests, when it runs that. */
  readonly windowsPackages: readonly string[]
  /** The macOS job's matrix: every test, or the affected `system` packages. */
  readonly macosRows: readonly Row[]
  /** The folders of the packages macOS's `test:system` tests, when it runs that. */
  readonly packages: readonly string[]
}

/**
 * The folders of the packages a list of names names, or `undefined` where the list is `all` or
 * names one that is no package of the workspace: then the system runs every test, as before
 * the plan followed the change. `all` is the plan's answer where it couldn't read a fact, the
 * packages' declarations among them, so it can't be narrowed by them. The repository's own
 * tests (`//`), which a Windows or macOS list never names, are `test:system`'s anyway.
 */
export const foldersOf = (
  tests: "all" | readonly string[],
  packages: readonly Package[],
): readonly string[] | undefined => {
  if (tests === "all") return undefined
  const named = tests.filter((name) => name !== repository)
  const found = named.map((name) => packages.find(({ manifest }) => manifest.name === name))
  if (found.some((each) => each === undefined)) return undefined
  return found.map((each) => each!.folder)
}

/**
 * Where Quality's tests run. Linux runs every test, always. Windows and macOS run the tests of
 * the packages the change's plan names for them (scripts/ci/plan: the affected `system` ones,
 * dependents and `reads` included), and none where it names none; where it says `all` (a run
 * that follows no change, or a fact it couldn't read), every test, the root's `test` and
 * `test:shard1`-`3` as before. A draft holds macOS's back (`held`), Windows's not.
 */
export const plan = (facts: Facts, packages: readonly Package[]): Plan => {
  const windows = foldersOf(facts.tests.windows, packages)
  const macos = foldersOf(facts.tests.macos, packages)
  const macosNeeded = macos === undefined || macos.length > 0
  return {
    windows: windows === undefined || windows.length > 0,
    macos: macosNeeded && facts.draft !== true,
    held: macosNeeded && facts.draft === true,
    // A skipped job's matrix still has to be a list of rows where Actions reads it.
    windowsRows: windows === undefined || windows.length === 0 ? wholeWindows : systemWindows,
    windowsPackages: windows ?? [],
    macosRows: macos === undefined || macos.length === 0 ? wholeMacos : systemMacos,
    packages: macos ?? [],
  }
}

/** Turbo's filters for the packages in `folders`. */
export const filters = (folders: readonly string[]): readonly string[] =>
  folders.map((folder) => `--filter=./${folder}`)

/**
 * Whether a package's tests run one package at a time on every system, as the root's `test`
 * runs them: the UI's and the apps' packages and the runner, whose browsers, Electron and real
 * processes contend for the runner's cores.
 */
export const serialEverywhere = (folder: string): boolean =>
  folder.startsWith("frontend/") || folder.startsWith("apps/") || folder === "backend/runner"

/**
 * The groups of folders `test:system` hands turbo, each with its `--concurrency`. On macOS,
 * every package one at a time: a macOS runner has three cores, and the packages' real
 * processes, PTYs and wall-clock bounds failed there when 23 packages ran at once (#784).
 * Elsewhere as the root's `test`: the rest at turbo's concurrency, then those that run one at
 * a time everywhere (`serialEverywhere`). An empty group is left out.
 */
export const invocations = (
  folders: readonly string[],
  platform: NodeJS.Platform,
): readonly { readonly folders: readonly string[]; readonly concurrency?: number }[] => {
  if (platform === "darwin") return folders.length > 0 ? [{ folders, concurrency: 1 }] : []
  const together = folders.filter((folder) => !serialEverywhere(folder))
  const serial = folders.filter(serialEverywhere)
  return [
    ...(together.length > 0 ? [{ folders: together }] : []),
    ...(serial.length > 0 ? [{ folders: serial, concurrency: 1 }] : []),
  ]
}

/**
 * Turbo's arguments for one of `invocations`' groups: its packages' tests, at its concurrency,
 * each package's test command given `extra`. With `keepGoing`, as the proof rows run, every
 * package's tests run though one fails (`--continue`), so one run shows each that fails.
 */
export const turboTestArgs = (
  group: { readonly folders: readonly string[]; readonly concurrency?: number | undefined },
  keepGoing: boolean,
  extra: readonly string[] = [],
): readonly string[] => [
  "turbo",
  "run",
  "test",
  "--output-logs=new-only",
  ...(keepGoing ? ["--continue"] : []),
  ...(group.concurrency === undefined ? [] : [`--concurrency=${group.concurrency}`]),
  ...filters(group.folders),
  "--",
  "--reporter=default",
  "--reporter=hanging-process",
  ...extra,
]

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
