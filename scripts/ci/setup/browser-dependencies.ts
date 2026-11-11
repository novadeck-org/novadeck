import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs"
import { join } from "node:path"

// `node scripts/ci/setup/browser-dependencies.ts <browsers folder>`: what the test browser
// lacks on this Linux machine, cached or about to be downloaded, by Playwright's own check of
// its system packages (`playwright install-deps --dry-run chromium`, which reads dpkg and
// reaches no network) and by `ldd` over every ELF file a cached browser holds. Quality's jobs,
// the Counter run and the setup action install the browser's dependencies with apt only where
// something is missing, and a cache miss downloads the browser alone where nothing is, so a
// runner image that has them all keeps Ubuntu's mirrors off a pull request's path: on 11-11
// they couldn't be resolved for hours, and every job with a cached browser failed before any
// test ran. Prints what it found; in Actions it sets `missing`, the number missing, or
// `unknown` where it couldn't tell, which the jobs take as missing, installing as before.

/**
 * The packages Playwright's dry run names as missing: `[]` only where it passed saying so
 * ("All system dependencies are installed."), and `undefined` where it couldn't tell, so the
 * packages are installed. Playwright 1.64 also exits 0 after "Cannot install dependencies for
 * <platform>", and its older dry runs printed the apt command with exit 0: neither is "none".
 */
export const missingPackages = (
  status: number | null,
  output: string,
): readonly string[] | undefined => {
  if (status === 0)
    return output.includes("All system dependencies are installed.") ? [] : undefined
  const lines = output.split(/\r?\n/)
  const start = lines.findIndex((line) => /^Missing system dependencies \(\d+\):\s*$/.test(line))
  if (start < 0) return undefined
  const named: string[] = []
  for (const line of lines.slice(start + 1)) {
    const name = /^\s+(\S+)\s*$/.exec(line)?.[1]
    if (name === undefined) break
    named.push(name)
  }
  return named.length > 0 ? named : undefined
}

/**
 * The cache key of the debs that install `packages`: the runner image's OS and version, its
 * architecture, and a digest of Playwright's version with the packages it names missing. A
 * new image that ships more or fewer of them, another Ubuntu, another architecture or another
 * Playwright, whose list may differ, each makes a new key; the debs' own versions don't, so a
 * key's debs can age behind the archive; where a later image can't take them, the install
 * changes nothing and downloads afresh.
 */
export const cacheKey = (found: {
  readonly os: string
  readonly arch: string
  readonly playwright: string
  readonly packages: readonly string[]
}): string =>
  `browser-packages-${found.os}-${found.arch}-${createHash("sha256")
    .update(`${found.playwright}\n${[...found.packages].toSorted().join(" ")}`)
    .digest("hex")
    .slice(0, 16)}`

/** The libraries `ldd`'s output names as not found, each once, in order. */
export const notFound = (ldd: string): readonly string[] => [
  ...new Set(
    ldd
      .split(/\r?\n/)
      .map((line) => /^\s*(\S+)\s+=>\s+not found\s*$/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined),
  ),
]

const elf = (file: string): boolean => {
  const handle = openSync(file, "r")
  try {
    const head = Buffer.alloc(4)
    return readSync(handle, head, 0, 4, 0) === 4 && head.toString("latin1") === "\x7fELF"
  } finally {
    closeSync(handle)
  }
}

/** Every ELF file under `folder`: the browser's executables and its shared libraries. */
export const elfFiles = (folder: string): readonly string[] =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(elf)

/**
 * What the action reads: how many are missing, packages and libraries together, or `unknown`
 * where Playwright's check couldn't tell. Before a cache miss's download there is no browser to
 * run `ldd` over, and Playwright's list, which names the libraries' packages too, decides alone.
 */
export const verdict = (
  packages: readonly string[] | undefined,
  libraries: readonly string[],
): string => (packages === undefined ? "unknown" : String(packages.length + libraries.length))

const ldd = (file: string): string => {
  try {
    return execFileSync("ldd", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch (error) {
    // `ldd` fails on a static file; a missing library is still listed on stdout.
    return (error as { stdout?: string }).stdout ?? ""
  }
}

/** This image's OS and version, as /etc/os-release names them, such as `ubuntu-24.04`. */
const osRelease = (): string => {
  const release = readFileSync("/etc/os-release", "utf8")
  const field = (name: string) =>
    new RegExp(`^${name}="?([^"\\n]*)"?$`, "m").exec(release)?.[1] ?? "unknown"
  return `${field("ID")}-${field("VERSION_ID")}`
}

const quiet = (command: string, args: readonly string[]): string =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()

export const main = (folder: string | undefined): void => {
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
  const packages = missingPackages(check.status, `${check.stdout ?? ""}\n${check.stderr ?? ""}`)
  let binaries: readonly string[] = []
  try {
    // Before a cache miss's download there is none yet.
    if (folder && existsSync(folder)) binaries = elfFiles(folder)
  } catch (error) {
    console.error(`Couldn't read ${folder}: ${error instanceof Error ? error.message : error}`)
  }
  const libraries = [...new Set(binaries.flatMap((file) => notFound(ldd(file))))].toSorted()
  const found = verdict(packages, libraries)
  const key =
    packages && packages.length > 0
      ? cacheKey({
          os: osRelease(),
          arch: quiet("dpkg", ["--print-architecture"]),
          playwright: quiet("pnpm", [
            "--config.verify-deps-before-run=false",
            "--filter",
            "@novadeck/specs",
            "exec",
            "playwright",
            "--version",
          ]),
          packages,
        })
      : ""
  console.log(
    [
      `Test browser's system packages (Playwright's check): ${
        packages === undefined
          ? `couldn't tell (exit ${check.status ?? check.error?.message})`
          : packages.length === 0
            ? "none missing"
            : `${packages.length} missing: ${packages.join(", ")}`
      }`,
      `Test browser's libraries (ldd over ${binaries.length} binaries under ${folder ?? "(none given)"}): ${
        libraries.length === 0
          ? "none missing"
          : `${libraries.length} missing: ${libraries.join(", ")}`
      }`,
      found === "0"
        ? "Nothing missing: no package installed"
        : `Installing the browser's packages (${found === "unknown" ? "couldn't tell" : `${found} missing`})${key ? `, cache ${key}` : ""}`,
    ].join("\n"),
  )
  const output = process.env.GITHUB_OUTPUT
  if (output)
    appendFileSync(output, `missing=${found}\npackages=${(packages ?? []).join(" ")}\nkey=${key}\n`)
}

if (import.meta.main) main(process.argv[2])
