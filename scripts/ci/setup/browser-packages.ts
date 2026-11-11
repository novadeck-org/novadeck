import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { missingPackages } from "./browser-dependencies.ts"
import { plan, run } from "./retry.ts"

// `PACKAGES="…" node scripts/ci/setup/browser-packages.ts <folder>`: installs the test
// browser's system packages the runner image lacks (`PACKAGES`, which
// browser-dependencies.ts names: on ubuntu-24.04 on 11-11, nine font packages) from their debs
// in `<folder>`, restored from a cache, with `dpkg -i`, which reaches no network. Where the
// folder has none, or they don't cover what's missing, apt's own resolver downloads them,
// dependencies the image lacks included, into the folder, retried and failing fast, and they
// are installed from there; the action saves the folder for the next run. Only Playwright's
// own check saying nothing is missing counts as done. Where `PACKAGES` is empty (the check
// couldn't tell), `playwright install-deps` runs as before, retried. In Actions it sets
// `path` (`cache`, `apt`, `install-deps`) and `fetched`, whether the folder is new to save.

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
  /** Installs `files` with `dpkg -i`; whether it did. */
  readonly dpkg: (files: readonly string[]) => boolean
  /** What Playwright's check names missing now; `undefined` where it can't tell. */
  readonly missing: () => readonly string[] | undefined
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
    machine.log(`From the cache: dpkg -i ${cached.length} debs, no mirror reached`)
    if (machine.dpkg(cached) && done(machine)) return { path: "cache", fetched: false }
    machine.log("The cache didn't cover them: through Ubuntu's mirrors")
  } else machine.log("No debs cached: through Ubuntu's mirrors")
  if (!machine.download(packages))
    throw new Error("The test browser's system packages couldn't be downloaded")
  const fetched = machine.debs()
  machine.log(`Downloaded: dpkg -i ${fetched.length} debs`)
  if (machine.dpkg(fetched) && done(machine)) return { path: "apt", fetched: true }
  throw new Error(
    "The test browser's system packages were downloaded, but Playwright's check still names some missing",
  )
}

/**
 * apt settings for this step's own calls, removed after: no retry of its own and short
 * timeouts, so a dead mirror ends an attempt in seconds, not after apt's minutes of retries
 * (the retry around it waits and tries again).
 */
export const failFast = [
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

const failFastFile = "/etc/apt/apt.conf.d/99novadeck-fail-fast"

const sudo = (args: readonly string[], input?: string): boolean =>
  spawnSync("sudo", args, {
    stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
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
    dpkg: (files) => sudo(["dpkg", "-i", ...files]),
    missing: () => {
      const check = spawnSync(
        "pnpm",
        [
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
    download: (packages) => {
      mkdirSync(join(folder, "partial"), { recursive: true })
      sudo(["tee", failFastFile], failFast)
      try {
        const meaning = "The test browser's system packages couldn't be downloaded"
        if (run(meaning, ["sudo", "apt-get", "update", "-qq"], aptPlan) !== 0) return false
        const fetched = run(
          meaning,
          [
            "sudo",
            "apt-get",
            "install",
            "-y",
            "--no-install-recommends",
            "--download-only",
            "-o",
            `Dir::Cache::archives=${folder}`,
            ...packages,
          ],
          aptPlan,
        )
        // Root's files, which the cache's save must read; the lock and partial downloads aren't kept.
        sudo(["chown", "-R", `${process.getuid?.() ?? 0}`, folder])
        rmSync(join(folder, "partial"), { recursive: true, force: true })
        rmSync(join(folder, "lock"), { force: true })
        return fetched === 0
      } finally {
        sudo(["rm", "-f", failFastFile])
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
    `Test browser's packages: installed by ${outcome.path === "cache" ? "dpkg -i from the cache, no mirror reached" : outcome.path === "apt" ? "apt's download through Ubuntu's mirrors, then dpkg -i" : "playwright install-deps"}`,
  )
  const output = process.env.GITHUB_OUTPUT
  if (output) appendFileSync(output, `path=${outcome.path}\nfetched=${outcome.fetched}\n`)
}

if (import.meta.main) {
  try {
    main(process.argv[2] ?? join(process.env.RUNNER_TEMP ?? "/tmp", "browser-packages"))
  } catch (error) {
    console.log(`::error title=Setup::${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  }
}
