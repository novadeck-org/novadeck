import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { missingPackages } from "./browser-dependencies.ts"
import { type Failure, plan, run, unreached } from "./retry.ts"

// `PACKAGES="…" EXACT_HIT=… node scripts/ci/setup/browser-packages.ts <folder>`: installs the
// test browser's system packages the runner image lacks (`PACKAGES`, which
// browser-dependencies.ts names: nine font packages on 11-11) from their debs in `<folder>`,
// restored from a cache, with `apt-get install --no-download`, which reaches no network,
// resolves first, changes nothing where it can't (debs a later image can't take) and never
// downgrades as `dpkg -i` would. Where the folder has none, or they don't install, the folder
// is emptied and apt's own resolver downloads them, dependencies the image lacks included,
// into it, retried and failing fast, and they are installed from there. Only Playwright's own
// check then saying nothing is missing counts as done. Where `PACKAGES` is empty (the check
// couldn't tell), `playwright install-deps` runs as before, retried. In Actions it sets `path`
// (`cache`, `apt`, `install-deps`), `fetched`, and `save`: whether the folder goes under the
// exact key (`saves`).

export type Outcome = {
  /** Which way the packages came: the cache, apt's download, or Playwright's own install. */
  readonly path: "cache" | "apt" | "install-deps"
  /** Whether the folder holds debs this run downloaded, to be saved. */
  readonly fetched: boolean
}

/** What installing needs of the machine, as `main` gives it and the tests fake it. */
export type Machine = {
  /** The debs the folder holds. */
  readonly debs: () => readonly string[]
  /**
   * Installs the debs `files` with `apt-get install --no-download`: resolved first, nothing
   * changed where they can't be, no mirror reached; whether it did.
   */
  readonly local: (files: readonly string[]) => boolean
  /** What Playwright's check names missing now; `undefined` where it can't tell. */
  readonly missing: () => readonly string[] | undefined
  /** Empties the folder, so a download is all it holds. */
  readonly clear: () => void
  /** apt's download of `packages` and what they need into the folder; whether it did. */
  readonly download: (packages: readonly string[]) => boolean
  /** `playwright install-deps chromium`, retried; whether it did. */
  readonly installDeps: () => boolean
  readonly log: (line: string) => void
}

const done = (machine: Machine): boolean => {
  const left = machine.missing()
  machine.log(
    `Playwright's check after: ${left === undefined ? "couldn't tell" : left.length === 0 ? "none missing" : `${left.length} missing: ${left.join(", ")}`}`,
  )
  return left !== undefined && left.length === 0
}

/**
 * Installs `packages` (`undefined` where the check couldn't tell): from the folder's debs
 * where they cover them, else through apt's download, else fails. Only Playwright's check
 * saying none is missing counts. Throws where nothing worked.
 */
export const install = (packages: readonly string[] | undefined, machine: Machine): Outcome => {
  if (packages === undefined || packages.length === 0) {
    machine.log(
      "The check couldn't tell what's missing: playwright install-deps, through Ubuntu's mirrors",
    )
    if (machine.installDeps()) return { path: "install-deps", fetched: false }
    throw new Error("The test browser's system packages couldn't be installed")
  }
  const cached = machine.debs()
  if (cached.length > 0) {
    machine.log(
      `From the cache: apt-get install --no-download ${cached.length} debs, no mirror reached`,
    )
    if (machine.local(cached) && done(machine)) return { path: "cache", fetched: false }
    machine.log("The cache didn't cover them: through Ubuntu's mirrors")
  } else machine.log("No debs cached: through Ubuntu's mirrors")
  // Into an empty folder: debs a later image can't take, beside the current ones, would hand
  // apt two versions of one package; what is installed and saved is this download alone.
  machine.clear()
  if (!machine.download(packages))
    throw new Error("The test browser's system packages couldn't be downloaded")
  const fetched = machine.debs()
  machine.log(`Downloaded: apt-get install --no-download ${fetched.length} debs`)
  if (machine.local(fetched) && done(machine)) return { path: "apt", fetched: true }
  throw new Error(
    "The test browser's system packages were downloaded, but Playwright's check still names some missing",
  )
}

/**
 * Whether the folder is saved under the exact key: where this run downloaded it, or installed
 * from debs restored for another image build (the prefix's), never where the exact key hit, as
 * a key is never rewritten.
 */
export const saves = (outcome: Outcome, exactHit: boolean): boolean =>
  !exactHit && (outcome.path === "apt" || outcome.path === "cache")

/**
 * apt settings for this step's own calls, removed after: no retry of its own and short
 * timeouts, so a dead mirror ends an attempt in seconds, not after apt's minutes of retries
 * (the retry around it waits and tries again).
 */
export const failFast = [
  // `apt-get update` exits 0 where it reached no mirror, warning only (apt 2.8): with this it
  // exits 100, so the retry around it retries.
  'APT::Update::Error-Mode "any";',
  'Acquire::Retries "0";',
  'Acquire::http::Timeout "10";',
  'Acquire::https::Timeout "10";',
  'Acquire::ftp::Timeout "10";',
].join("\n")

/**
 * Each apt call's limit: a healthy install took 9 to 17 s on main's runs before 11-11, 32 s at
 * the slowest but one; 90 s leaves room for a slow mirror and ends a hung one.
 */
export const aptPlan = { ...plan, limitSeconds: 90 }

/** `word` as one shell word, in single quotes. */
const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

/**
 * The mirrors a download attempt adds to the image's own, in the order it tries them, by how
 * many attempts before it couldn't reach a mirror. The first attempt uses the image's list
 * alone, so a normal day is unchanged. On 11-11 the `ubuntu.com` names couldn't be resolved
 * for hours while the archive was up: the Azure mirror the runners use first,
 * `azure.archive.ubuntu.com`, is a CNAME to a Traffic Manager name in Microsoft's zone, which
 * answered; and independent mirrors such as kernel.org's serve the same signed files. Taking
 * them is safe because apt's signature checking is untouched: the sources keep their
 * `Signed-By`, nothing is marked trusted, no key changes. A mirror only carries bytes, which the
 * image's Ubuntu keys verify, and apt refuses any that don't verify.
 */
export const fallbacks: readonly { readonly name: string; readonly mirrors: readonly string[] }[] =
  [
    { name: "the image's mirrors", mirrors: [] },
    {
      name: "Azure's mirror by its Traffic Manager name",
      mirrors: ["http://ubuntu-archive-asm.trafficmanager.net/ubuntu/"],
    },
    {
      name: "kernel.org's mirror",
      mirrors: [
        "http://mirrors.kernel.org/ubuntu/",
        "http://ubuntu-archive-asm.trafficmanager.net/ubuntu/",
      ],
    },
  ]

/** Which of `fallbacks` the next attempt uses: one further for each that couldn't reach a mirror. */
export const fallbackFor = (failures: readonly Failure[]): number =>
  Math.min(failures.filter(unreached).length, fallbacks.length - 1)

/**
 * A mirror list for apt's `mirror+file:` method: `mirrors` before the image's own. apt shuffles
 * mirrors of equal priority, and tries a lower priority first (checked with apt 2.8: kernel.org
 * at priority 1 served every fetch, at 10 none), so the fallbacks are 1 and the image's 10.
 */
export const mirrorList = (image: string, mirrors: readonly string[]): string =>
  [
    ...mirrors.map((mirror) => `${mirror}\tpriority:1`),
    ...image
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .map((line) => `${line.split("\t")[0]!.trim()}\tpriority:10`),
  ]
    .join("\n")
    .concat("\n")

// The image's mirror list, which its sources name as `mirror+file:`, and the archive's own
// names, which a source without the list names directly.
const imageMirrors = "/etc/apt/apt-mirrors.txt"
const archives = [
  "http://azure.archive.ubuntu.com/ubuntu/",
  "http://archive.ubuntu.com/ubuntu/",
  "http://security.ubuntu.com/ubuntu/",
]

/**
 * A copy of a sources file whose Ubuntu archive is the mirror list `list`: each `mirror+file:`
 * of the image's list, and each of the archive's own names, becomes `mirror+file:<list>`. All
 * else stays as it is, `Signed-By` included.
 */
export const alternateSources = (text: string, list: string): string =>
  [`mirror+file:${imageMirrors}`, ...archives].reduce(
    (sources, uri) => sources.replaceAll(uri, `mirror+file:${list}`),
    text,
  )

/** Where an attempt's own apt state lives: sources, mirror list and package lists of its own. */
export type Alternate = { readonly parts: string; readonly lists: string }

/**
 * The shell one download attempt runs: apt's lists refreshed, then the debs into `folder`;
 * through `alternate`'s sources and lists where given, the system's left as they are.
 */
export const downloadScript = (
  folder: string,
  packages: readonly string[],
  alternate?: Alternate,
): string => {
  const own = alternate
    ? [
        `-o ${quoted("Dir::Etc::sourcelist=/dev/null")}`,
        `-o ${quoted(`Dir::Etc::sourceparts=${alternate.parts}`)}`,
        `-o ${quoted(`Dir::State::Lists=${alternate.lists}`)}`,
        // Nor the system's package caches, which another source list would rewrite.
        `-o ${quoted("Dir::Cache::pkgcache=")}`,
        `-o ${quoted("Dir::Cache::srcpkgcache=")}`,
      ].join(" ")
    : ""
  const apt = own ? `apt-get ${own}` : "apt-get"
  return [
    `${apt} update -qq &&`,
    `${apt} install -y --no-install-recommends --download-only`,
    `-o ${quoted(`Dir::Cache::archives=${folder}`)}`,
    ...packages.map(quoted),
  ].join(" ")
}

/**
 * Writes the apt state an attempt through `mirrors` reads, under `root`: the image's sources
 * with their archive pointed at a mirror list of `mirrors` then the image's own, and an empty
 * lists folder. Returns where, for `downloadScript`.
 */
const writeAlternate = (root: string, level: number, mirrors: readonly string[]): Alternate => {
  const at = join(root, `mirrors-${level}`)
  const parts = join(at, "sources.list.d")
  const lists = join(at, "lists")
  mkdirSync(parts, { recursive: true })
  mkdirSync(join(lists, "partial"), { recursive: true })
  const list = join(at, "apt-mirrors.txt")
  writeFileSync(
    list,
    mirrorList(
      existsSync(imageMirrors) ? readFileSync(imageMirrors, "utf8") : archives.join("\n"),
      mirrors,
    ),
  )
  const sources = [
    ...(existsSync("/etc/apt/sources.list") ? [["system.list", "/etc/apt/sources.list"]] : []),
    ...readdirSync("/etc/apt/sources.list.d")
      .filter((name) => name.endsWith(".sources") || name.endsWith(".list"))
      .map((name) => [name, join("/etc/apt/sources.list.d", name)]),
  ]
  for (const [name, path] of sources)
    writeFileSync(join(parts, name!), alternateSources(readFileSync(path!, "utf8"), list))
  return { parts, lists }
}

const failFastFile = "/etc/apt/apt.conf.d/99novadeck-fail-fast"

// `tee` writes the snippet to the file and would echo it into the log too: its stdout is dropped.
const sudo = (args: readonly string[], input?: string): boolean =>
  spawnSync("sudo", args, {
    stdio: [
      input === undefined ? "ignore" : "pipe",
      input === undefined ? "inherit" : "ignore",
      "inherit",
    ],
    input,
  }).status === 0

export const main = (folder: string): void => {
  const named = (process.env.PACKAGES ?? "").split(/\s+/).filter(Boolean)
  const machine: Machine = {
    debs: () => {
      try {
        return readdirSync(folder)
          .filter((name) => name.endsWith(".deb"))
          .map((name) => join(folder, name))
      } catch {
        return []
      }
    },
    local: (files) =>
      sudo(["apt-get", "install", "-y", "--no-install-recommends", "--no-download", ...files]),
    missing: () => {
      const check = spawnSync(
        "pnpm",
        [
          "--config.verify-deps-before-run=false",
          "--filter",
          "@novadeck/specs",
          "exec",
          "playwright",
          "install-deps",
          "--dry-run",
          "chromium",
        ],
        { encoding: "utf8" },
      )
      return missingPackages(check.status, `${check.stdout ?? ""}\n${check.stderr ?? ""}`)
    },
    clear: () => {
      sudo(["rm", "-rf", folder])
      mkdirSync(folder, { recursive: true })
    },
    download: (packages) => {
      mkdirSync(join(folder, "partial"), { recursive: true })
      // The fallbacks' apt state, beside the folder (not in it, as the folder is saved).
      const scratch = `${folder}.apt`
      sudo(["tee", failFastFile], failFast)
      try {
        // Each attempt refreshes the lists and downloads in one, so a mirror back mid-step
        // serves the next attempt, which a passed update and three tries of the download alone
        // couldn't. One that couldn't reach a mirror sends the next through `fallbacks`.
        let used = 0
        const fetched = run(
          "The test browser's system packages couldn't be downloaded",
          (failures) => {
            used = fallbackFor(failures)
            const { name, mirrors } = fallbacks[used]!
            console.log(`Downloading through ${name}`)
            const alternate = used === 0 ? undefined : writeAlternate(scratch, used, mirrors)
            return ["sudo", "sh", "-c", downloadScript(folder, packages, alternate)]
          },
          // It runs no dpkg: an apt it leaves past the wait is ended, not waited on again.
          { ...aptPlan, reap: true },
        )
        if (fetched === 0) console.log(`Downloaded through ${fallbacks[used]!.name}`)
        // Root's files, which the cache's save must read; the lock and partial downloads aren't kept.
        sudo(["chown", "-R", `${process.getuid?.() ?? 0}`, folder])
        rmSync(join(folder, "partial"), { recursive: true, force: true })
        rmSync(join(folder, "lock"), { force: true })
        return fetched === 0
      } finally {
        sudo(["rm", "-f", failFastFile])
        sudo(["rm", "-rf", scratch])
      }
    },
    installDeps: () => {
      sudo(["tee", failFastFile], failFast)
      try {
        return (
          run(
            "The test browser's system packages couldn't be installed",
            [
              "pnpm",
              "--config.verify-deps-before-run=false",
              "--filter",
              "@novadeck/specs",
              "exec",
              "playwright",
              "install-deps",
              "chromium",
            ],
            aptPlan,
          ) === 0
        )
      } finally {
        sudo(["rm", "-f", failFastFile])
      }
    },
    log: (line) => console.log(line),
  }
  const outcome = install(named, machine)
  console.log(
    `Test browser's packages: installed by ${outcome.path === "cache" ? "apt-get install --no-download from the cache, no mirror reached" : outcome.path === "apt" ? "apt's download through Ubuntu's mirrors, then apt-get install --no-download" : "playwright install-deps"}`,
  )
  // The restore's exact hit (`EXACT_HIT`), whose key is never rewritten.
  const save = saves(outcome, process.env.EXACT_HIT === "true")
  const output = process.env.GITHUB_OUTPUT
  if (output)
    appendFileSync(output, `path=${outcome.path}\nfetched=${outcome.fetched}\nsave=${save}\n`)
}

if (import.meta.main) {
  try {
    main(process.argv[2] ?? join(process.env.RUNNER_TEMP ?? "/tmp", "browser-packages"))
  } catch (error) {
    console.log(`::error title=Setup::${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  }
}
