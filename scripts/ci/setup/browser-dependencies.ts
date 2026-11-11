import { execFileSync, spawnSync } from "node:child_process"
import { appendFileSync, closeSync, openSync, readdirSync, readSync } from "node:fs"
import { join } from "node:path"

// `node scripts/ci/setup/browser-dependencies.ts <browsers folder>`: what the cached test
// browser lacks on this Linux machine, by Playwright's own check of its system packages
// (`playwright install-deps --dry-run chromium`, which reads dpkg and reaches no network) and by
// `ldd` over every ELF file it holds. The setup action (.github/actions/setup) installs the
// browser's dependencies with apt only where something is missing, so a runner image that has
// them all keeps Ubuntu's mirrors off a pull request's path: on 11-11 they were unreachable for
// 40 minutes, and every job with a cached browser failed before any test ran. Prints what it
// found; in Actions it sets `missing`, the number missing, or `unknown` where it couldn't tell,
// which the action takes as missing, so it installs them as before.

/**
 * The packages Playwright's dry run names as missing: `[]` where it passed (exit 0), and
 * `undefined` where it failed without naming any, as it couldn't tell.
 */
export const missingPackages = (
  status: number | null,
  output: string,
): readonly string[] | undefined => {
  if (status === 0) return []
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
 * where Playwright's check couldn't tell or no browser was found to check.
 */
export const verdict = (
  packages: readonly string[] | undefined,
  binaries: number,
  libraries: readonly string[],
): string =>
  packages === undefined || binaries === 0 ? "unknown" : String(packages.length + libraries.length)

const ldd = (file: string): string => {
  try {
    return execFileSync("ldd", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch (error) {
    // `ldd` fails on a static file; a missing library is still listed on stdout.
    return (error as { stdout?: string }).stdout ?? ""
  }
}

export const main = (folder: string | undefined): void => {
  const check = spawnSync(
    "pnpm",
    ["--filter", "@novadeck/specs", "exec", "playwright", "install-deps", "--dry-run", "chromium"],
    { encoding: "utf8" },
  )
  const packages = missingPackages(check.status, `${check.stdout ?? ""}\n${check.stderr ?? ""}`)
  let binaries: readonly string[] = []
  try {
    if (folder) binaries = elfFiles(folder)
  } catch (error) {
    console.error(`Couldn't read ${folder}: ${error instanceof Error ? error.message : error}`)
  }
  const libraries = [...new Set(binaries.flatMap((file) => notFound(ldd(file))))].toSorted()
  const found = verdict(packages, binaries.length, libraries)
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
        ? "Nothing missing: apt skipped"
        : `Installing the browser's dependencies with apt (${found === "unknown" ? "couldn't tell" : `${found} missing`})`,
    ].join("\n"),
  )
  const output = process.env.GITHUB_OUTPUT
  if (output) appendFileSync(output, `missing=${found}\n`)
}

if (import.meta.main) main(process.argv[2])
