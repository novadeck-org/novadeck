// What the E2E workflow runs, decided from what a pull request changed. Pure: `main.ts`
// gathers the facts (the event, turbo's affected packages, git's changed files).

// The table's source, which imports nothing, so the plan needs no package built first.
import { harnesses } from "../../../contract/protocol/src/harnesses.ts"

/** The facts a decision rests on; `undefined` where they couldn't be had. */
export type Facts = {
  /** The workflow's event (`pull_request`, `merge_group`, `schedule`, `workflow_dispatch`). */
  readonly event: string
  /** Names of the workspace packages turbo calls affected, dependents included. */
  readonly affected: readonly string[] | undefined
  /** The runner and every package it builds on, dependencies of dependencies included. */
  readonly runner: readonly string[] | undefined
  /** Paths git calls changed, relative to the repository's root, with `/` as separator. */
  readonly files: readonly string[] | undefined
  /** Whether the pull request is a draft; anything else reads as not, so macOS runs. */
  readonly draft?: boolean
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
  "backend/runner/",
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
  "backend/relay/",
  "backend/runner/",
  "backend/tour/",
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
 * Whether a run follows its change: a pull request's, against its base, and a merge queue's
 * group's, against the group's parent (`merge_group.base_sha`). Any other event runs everything.
 */
export const followsChange = (event: string): boolean =>
  event === "pull_request" || event === "merge_group"

/**
 * The harnesses whose rows run. All of them when nothing says otherwise (a nightly or
 * manual run, or facts missing, which can't be told from everything changing); none when
 * the change is nothing the suite runs on.
 */
export const select = (facts: Facts, ids: readonly string[]): readonly string[] => {
  if (!followsChange(facts.event)) return ids
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
 * The systems a run's jobs run on: for a change it follows (`followsChange`), Linux alone unless it can break
 * one system but not the others (`touchesSystem`); all three otherwise, and when that can't be
 * told (`undefined`), as for `select`. Quality's tests decide by this rule too, with their own
 * answer to whether a change touches the system (scripts/quality/plan).
 */
export const systemsFor = (event: string, touchesSystem: boolean | undefined): readonly string[] =>
  followsChange(event) && touchesSystem === false ? [systems.linux] : everySystem

/** Whether a changed file is one the suite can run differently on each system. */
const e2eTouchesSystem = (file: string): boolean =>
  allSystemsFiles.has(file) ||
  (allSystemsFolders.some((f) => file.startsWith(f)) &&
    !browserOnlyFiles.some((f) => file.startsWith(f)))

/**
 * The systems the rows run on. Linux alone unless a change can break a system but not the
 * others (`allSystemsFolders`); all three when nothing says otherwise, as for `select`.
 */
export const selectSystems = (facts: Facts): readonly string[] =>
  systemsFor(facts.event, facts.files?.some(e2eTouchesSystem))

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

/**
 * The core scenarios: what the quirks jobs and macOS on a pull request run of each harness.
 * `priority.e2e.ts` is among them, as macOS and Windows are where it runs and a pull request
 * runs only these on macOS.
 */
export const core =
  "messaging.e2e.ts requests.e2e.ts lifecycle.e2e.ts images.e2e.ts priority.e2e.ts"

// Every harness: a message crossing under a cmd AutoRun that prints (the file sets it, on CI only).
const autorunFile = "windows-autorun.e2e.ts"

/**
 * The rows of the `quirks` job, one per selected harness. Each runs the core scenarios;
 * Claude Code's job also runs the registry's PATH, which needs no harness and so runs in
 * one job. Each also runs `windows-autorun.e2e.ts`, a message crossing under a printing AutoRun
 * (the file sets it itself, on CI only, and puts it back). Antigravity's runs, last, the cmd AutoRun, as that turns Antigravity's messaging
 * off outside Novadeck's terminals by design.
 */
export const quirks = (selected: readonly string[]): readonly Quirk[] =>
  selected.map((id) => ({
    agents: id,
    name: nameOf(id),
    files:
      id === "claude" ? `${core} windows-quirks.e2e.ts ${autorunFile}` : `${core} ${autorunFile}`,
    ...(id === "agy" ? { autorun: true as const } : {}),
  }))

/** A system's key in `durations.json` and `jobLimits` (`linux`), from its `runs-on`. */
const keyOf = (system: string): keyof typeof systems =>
  (Object.keys(systems) as (keyof typeof systems)[]).find((key) => systems[key] === system) ??
  "linux"

/**
 * Each suite file's recorded time, in seconds, in each harness's job on each system: the median
 * of green runs, a harness's shards added up within a run (`durations.ts` writes it).
 */
export type Durations = {
  readonly [harness: string]: {
    readonly [system: string]: { readonly [file: string]: number } | undefined
  }
}

/** What a harness's suite is split by: the suite's files (`chat.e2e.ts`) and their times. */
export type Sharding = { readonly suite: readonly string[]; readonly durations: Durations }

/** The `e2e` jobs' limits, in minutes, as `e2e.yml` sets them (a test holds the two alike). */
export const jobLimits = { linux: 20, windows: 45, macos: 36 } as const

/**
 * What a job spends outside its test files, in minutes: checkout, the setup action, the
 * harnesses' caches and install, the relay's build, Vitest's own start, and uploads. The p90 of
 * the green runs of 2026-11-13 to 11-15, which `durations.json` was recorded from: 81 s on
 * Linux, 136 on Windows, 151 on macOS.
 */
export const jobOverhead = { linux: 1.4, windows: 2.3, macos: 2.5 } as const

/**
 * How much slower than its files' medians a shard may run: a job's slowest green run of those
 * days took up to 1.18 times its median (Claude Code's second Windows half), most within 1.1.
 */
export const slowest = 1.15

/**
 * How much of its job's limit a shard may take at worst, its files' medians slowed by `slowest`
 * and its job's overhead added: the rest is room for a slower runner yet.
 */
export const shardShare = 0.75

// How many jobs each harness's suite runs in on each system, so that each, split by its files'
// recorded times, stays within `shardShare` of its limit at worst (a test holds every one there).
// On 2026-11-13 to 11-15, in two halves of a fixed list, Claude Code's second Linux half took up
// to 19.6 of its 20 minutes and Codex's 16.7; Codex's whole macOS job 33.7 of 36, Antigravity's
// whole macOS job 28.4 and its whole Windows job 33.9 of 45. Split again, two Linux shards would
// still take up to 89% (Claude Code) and 81% (Codex), and Antigravity's two would sit at the
// line. Linux runners are many and quick to start, so a third job there costs a minute of
// setup. A second macOS job takes another scarce runner (about five run at once, so two of a
// whole-suite run's seven wait for one, as Mixed's frees the first within about 8 minutes),
// but only the whole suite runs these: a night, a dispatch, a merge queue. A pull request's
// macOS job runs the core scenarios (`macosRows`). Mixed runs whole everywhere.
const shardsOn: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map([
  [
    "claude",
    new Map([
      // A fourth on Linux: with its tour's teammates opening where they should, a test that ran
      // only skipped before takes about a minute more, past the line in a shard of three.
      [systems.linux, 4],
      // Its two Windows shards took up to 30.4 of 45 minutes (68%) on 2026-11-17's night, and a
      // suite file more put the planned worst past the line: a third, as Windows runners are many.
      [systems.windows, 3],
      [systems.macos, 2],
    ]),
  ],
  [
    "codex",
    new Map([
      [systems.linux, 3],
      [systems.windows, 2],
      [systems.macos, 2],
    ]),
  ],
  [
    // Its suite runs about twice Antigravity's: 46 minutes on Linux and 58 on Windows, the
    // median of three runs of 2026-11-23, where three Linux shards ran one past its 20 minutes.
    // Its macOS times are Linux's half a tenth slower, as Antigravity's are, until a night
    // records them.
    "opencode",
    new Map([
      [systems.linux, 4],
      [systems.windows, 3],
      [systems.macos, 3],
    ]),
  ],
  [
    // pi's suite is opencode's less the scenarios it lacks (no approvals, questions, plans,
    // background work or images), so its shards start as opencode's, and its recorded times
    // (`durations.json`) start as opencode's, until a night records its own.
    "pi",
    new Map([
      [systems.linux, 4],
      [systems.windows, 3],
      [systems.macos, 3],
    ]),
  ],
  [
    "agy",
    new Map([
      [systems.linux, 3],
      [systems.windows, 2],
      [systems.macos, 2],
    ]),
  ],
])

/** How many jobs a harness's suite runs in on a system: one unless `shardsOn` says more. */
export const shardsOf = (harness: string, system: string): number =>
  shardsOn.get(harness)?.get(system) ?? 1

/**
 * The suite's files in `count` shards of about the same recorded time: the longest first, each
 * onto the shard with the least so far (on a tie, the one with fewer files, then the earlier). A
 * file with no time recorded, as a new one, weighs as the median of those that have one. Each
 * shard's files are sorted; there are never more shards than files.
 */
export const split = (
  suite: readonly string[],
  times: { readonly [file: string]: number } | undefined,
  count: number,
): readonly (readonly string[])[] => {
  // No shard without a file, which would run the whole suite, or none of it.
  const many = Math.max(1, Math.min(count, suite.length))
  const known = suite.flatMap((file) => (times?.[file] === undefined ? [] : [times[file]!]))
  const sorted = known.toSorted((a, b) => a - b)
  const middle = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!
  const weight = (file: string) => times?.[file] ?? middle
  const shards = Array.from({ length: many }, () => ({ load: 0, files: [] as string[] }))
  for (const file of suite.toSorted((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((least, shard) =>
      shard.load < least.load ||
      (shard.load === least.load && shard.files.length < least.files.length)
        ? shard
        : least,
    )
    lightest.load += weight(file)
    lightest.files.push(file)
  }
  return shards.map((shard) => shard.files.toSorted())
}

/** One job of the `e2e` matrix: its system, its name, and the row it runs. */
export type Row = {
  readonly os: string
  readonly job: string
  readonly setup: Setup & { readonly part?: number }
}

// A job's name: the Linux ones bare, the others with their system, and a shard's number of all.
const jobName = (
  name: string,
  os: string,
  part: { readonly at: number; readonly of: number } | undefined,
): string => {
  const system = os === systems.windows ? "Windows" : os === systems.macos ? "macOS" : undefined
  const tags = [system, part === undefined ? undefined : `${part.at}/${part.of}`].filter(Boolean)
  return tags.length > 0 ? `${name} (${tags.join(", ")})` : name
}

/**
 * The `e2e` job's matrix, each system's rows in turn: a row as it is, or, for a harness split
 * on a system (`shardsOn`), one per shard (`split`). Each shard but the last names its files;
 * the last runs every other file, so one the plan wasn't told of (added, or renamed) still runs.
 * Without the suite and its times (`sharding`), nothing is split: each row runs whole.
 */
export const rows = (
  os: readonly string[],
  each: readonly Setup[],
  sharding?: Sharding,
): readonly Row[] =>
  os.flatMap((system) =>
    each.flatMap((setup): Row[] => {
      const shards =
        sharding === undefined
          ? []
          : split(
              sharding.suite,
              sharding.durations[setup.agents]?.[keyOf(system)],
              shardsOf(setup.agents, system),
            )
      if (shards.length < 2)
        return [{ os: system, job: jobName(setup.name, system, undefined), setup }]
      const named = shards.slice(0, -1).flat()
      return shards.map((files, at) => ({
        os: system,
        job: jobName(setup.name, system, { at: at + 1, of: shards.length }),
        setup: {
          ...setup,
          files:
            at < shards.length - 1
              ? files.map((file) => `src/e2e/${file}`).join(" ")
              : named.map((file) => `--exclude src/e2e/${file}`).join(" "),
          part: at + 1,
        },
      }))
    }),
  )

/** What the workflow's jobs read. */
export type Plan = {
  readonly run: boolean
  /** The `runs-on` of each system the `e2e` jobs run on; the `quirks` job needs Windows. */
  readonly os: readonly string[]
  readonly e2e: readonly Setup[]
  /** The jobs that run: `os` by `e2e`, with the long harnesses split (`shardsOn`). */
  readonly rows: readonly Row[]
  /**
   * The matrix of each system's job: Linux's, Windows's, and macOS's, which starts only once
   * Linux's have passed. Each names its rows whether `os` has the system or not, as a skipped
   * job's matrix must still be one; `os` says which run.
   */
  readonly jobs: { readonly [system in keyof typeof systems]: readonly Row[] }
  readonly quirks: readonly Quirk[]
  /**
   * Whether macOS's rows were chosen but held back, as the pull request is a draft: marking
   * it ready runs them. The `E2E` gate fails while they are, so a draft's run can't stand for
   * the pull request once it can merge.
   */
  readonly held: boolean
}

/** The name of macOS's one row on a pull request, which runs the core scenarios. */
export const coreName = "Core scenarios"

/**
 * macOS's rows. On a pull request, one job: the core scenarios (`core`) of every chosen
 * harness, which the suite runs one after another, as macOS runners are the scarcest and each
 * job pays their queue and its setup again. On any other event, a nightly run, a dispatch,
 * a merge queue's or one this doesn't know, the whole suite, as Linux and Windows run it: the
 * pinned night (a dispatch on main) runs on macOS what a pull request leaves out. In the core
 * set's measured macOS times (PR runs of 2026-11-10: messaging, requests, lifecycle and images
 * took 106 s for Antigravity, 149 for Codex and 163 for Claude Code), the job takes about ten
 * minutes with its setup, against about 95 job minutes in five jobs for the whole suite then
 * (about 107 in seven, as its harnesses' shards are now: `shardsOn`).
 */
export const macosRows = (
  event: string,
  chosen: readonly string[],
  ids: readonly string[],
  sharding: Sharding,
) =>
  event === "pull_request"
    ? [
        {
          os: systems.macos,
          job: jobName(coreName, systems.macos, undefined),
          setup: { agents: chosen.join(","), name: coreName, files: core },
        },
      ]
    : rows([systems.macos], setups(chosen, ids), sharding)

export const plan = (facts: Facts, ids: readonly string[], sharding: Sharding): Plan => {
  const selected = select(facts, ids)
  // With nothing to run the jobs are skipped, but their matrices still name every row: a
  // skipped job's matrix is never run, and an empty one is an error where Actions reads it.
  const chosen = selected.length > 0 ? selected : ids
  const systemsChosen = selected.length > 0 ? selectSystems(facts) : everySystem
  // A draft runs no macOS job: its rows wait for the pull request to be marked ready.
  const held = selected.length > 0 && facts.draft === true && systemsChosen.includes(systems.macos)
  const os = held ? systemsChosen.filter((system) => system !== systems.macos) : systemsChosen
  const e2e = setups(chosen, ids)
  const jobs = {
    linux: rows([systems.linux], e2e, sharding),
    windows: rows([systems.windows], e2e, sharding),
    macos: macosRows(facts.event, chosen, ids, sharding),
  }
  return {
    run: selected.length > 0,
    held,
    os,
    e2e,
    rows: [
      ...jobs.linux,
      ...(os.includes(systems.windows) ? jobs.windows : []),
      ...(os.includes(systems.macos) ? jobs.macos : []),
    ],
    jobs,
    quirks: quirks(chosen),
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
