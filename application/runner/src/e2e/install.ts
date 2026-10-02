import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { promisify } from "node:util"

import { agentName, type AgentName } from "@novadeck/protocol"
import { z } from "zod"

/** The harnesses an end-to-end test can run: those `harnesses.json` pins. */
export type HarnessName = AgentName

// A version as it may appear in a folder's name: no path separator in it.
const versionPattern = /^[\w.+-]+$/

/** The version, once it is known to be safe in a path; `from` names where it came from. */
const safeVersion = (version: string, from: string): string => {
  if (!versionPattern.test(version) || /^\.+$/.test(version))
    throw new Error(`${from} gave ${JSON.stringify(version.slice(0, 80))}, which is no version`)
  return version
}

// A harness published on npm: its package and the version the tests run.
const npmPin = z.strictObject({
  package: z.string().min(1),
  version: z.string().regex(versionPattern),
  bin: z.string().min(1),
})

// A harness published only as an archive, as Antigravity is: the release's address,
// which names its version and stays put, its SHA-512, the program inside it, and the
// manifest its own installer reads for the newest release.
const archivePin = z.strictObject({
  archive: z.url(),
  sha512: z.string().regex(/^[0-9a-f]{128}$/),
  manifest: z.url(),
  version: z.string().regex(versionPattern),
  member: z.string().min(1),
  bin: z.string().min(1),
})

const pin = z.union([npmPin, archivePin])

/** Each harness's pinned release, from `harnesses.json`. */
export const pins = z
  .partialRecord(agentName, pin)
  .parse(JSON.parse(readFileSync(new URL("harnesses.json", import.meta.url), "utf8")))

// A harness's pin, or why it has none.
const pinOf = (name: HarnessName): z.infer<typeof pin> => {
  const found = pins[name]
  if (!found) throw new Error(`harnesses.json pins no ${name}`)
  return found
}

/**
 * Where installed harnesses are kept between runs: `NOVADECK_E2E_CACHE`, or a folder in
 * the user's cache.
 */
export const cacheFolder = (env: NodeJS.ProcessEnv = process.env): string =>
  env.NOVADECK_E2E_CACHE || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "novadeck", "e2e")

// npm beside the node running the tests, so whatever else is on PATH plays no part, or
// the first on the tests' own PATH when that node has none beside it.
const npm = (): string => {
  const name = process.platform === "win32" ? "npm.cmd" : "npm"
  const found = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)]
    .filter(Boolean)
    .map((folder) => join(folder, name))
    .find((path) => existsSync(path))
  if (!found)
    throw new Error(`No npm beside ${process.execPath} or on PATH, so no harness can be installed`)
  return found
}

/**
 * The environment npm installs with: a home of the cache's own, so neither npm nor a
 * package's install script reads or writes the developer's, a D-Bus address that leads
 * nowhere, so no install script reaches their keyring, and their proxy, should the
 * registry be reachable only through it.
 */
const installEnvironment = (cache: string): NodeJS.ProcessEnv => {
  const proxies = Object.entries(process.env).filter(([name]) =>
    /^(https?_proxy|no_proxy)$/i.test(name),
  )
  return {
    ...Object.fromEntries(proxies),
    HOME: join(cache, "home"),
    USERPROFILE: join(cache, "home"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(cache, "no-bus")}`,
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(
      process.platform === "win32" ? ";" : ":",
    ),
    ...(process.platform === "win32" && { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }),
  }
}

const run = (args: readonly string[], cache: string) =>
  promisify(execFile)(npm(), [...args], {
    env: installEnvironment(cache),
    shell: process.platform === "win32",
    maxBuffer: 16 * 1024 * 1024,
  })

/**
 * How long a newest release looked up stands: long enough for a run that installs with
 * the network and then tests without it, as under `scripts/e2e/isolated`, to test what it
 * installed; short enough that the next day's run looks again.
 */
export const latestMs = 60 * 60 * 1000

/**
 * The newest release, as `lookup` finds it, remembered in `file` with when it was looked
 * up: a later call within `latestMs`, as from another process, reads it there instead of
 * looking again. A record that is missing, old, unreadable or not one, or whose version
 * isn't safe in a path, is looked up again and replaced.
 */
export const latestRelease = async <T extends { readonly version: string }>(
  file: string,
  release: z.ZodType<T>,
  lookup: () => Promise<T>,
  now = Date.now(),
): Promise<T> => {
  const record = z.strictObject({ at: z.number(), release })
  try {
    const read = record.parse(JSON.parse(await readFile(file, "utf8")))
    if (now - read.at >= 0 && now - read.at < latestMs) {
      safeVersion(read.release.version, file)
      return read.release
    }
  } catch {
    // None yet, or none to trust: looked up again.
  }
  const found = await lookup()
  // Written beside it, then moved into place, so no reader finds half a record.
  await mkdir(dirname(file), { recursive: true })
  const staging = `${file}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(staging, JSON.stringify({ at: now, release: found }))
  await rename(staging, file)
  return found
}

// Where the newest release of a harness looked up is remembered: beside its installs,
// though not among the folders a cache of them keeps.
const latestFile = (name: HarnessName): string => join(cacheFolder(), `${name}.latest`)

/**
 * The version to install: the pinned one, or with `NOVADECK_E2E_HARNESS=latest`, as a
 * nightly job checks for drift, the newest npm has, looked up once for every run within
 * the hour (`latestRelease`).
 */
const npmVersion = async (
  name: HarnessName,
  found: z.infer<typeof npmPin>,
  cache: string,
): Promise<string> => {
  if (process.env.NOVADECK_E2E_HARNESS !== "latest") return found.version
  const release = await latestRelease(
    latestFile(name),
    z.strictObject({ version: z.string() }),
    async () => {
      const { stdout } = await run(["view", found.package, "version"], cache)
      return { version: safeVersion(stdout.trim(), `npm view ${found.package} version`) }
    },
  )
  return release.version
}

/** A harness installed in the cache: the folder holding its program, and its version. */
export type Installed = { readonly bin: string; readonly version: string }

// Each harness's install in this process, by harness and which version it runs, so a
// file's tests and its setup share one, and `latest` is looked up once.
const installs = new Map<string, Promise<Installed>>()

/**
 * Installs the harness's pinned version into the cache, once, and returns the folder
 * holding its program and the version installed, the newest one with
 * `NOVADECK_E2E_HARNESS=latest`. It never uses a copy installed elsewhere on the machine.
 */
export const installHarness = (name: HarnessName): Promise<Installed> => {
  const key = `${name}:${process.env.NOVADECK_E2E_HARNESS === "latest" ? "latest" : "pinned"}`
  const known = installs.get(key)
  if (known) return known
  const found = pinOf(name)
  const install = "archive" in found ? installArchive(name, found) : installPackage(name, found)
  installs.set(key, install)
  return install
}

// A staging folder beside the final one, named so no other run picks the same.
const stagingFor = (folder: string): string => `${folder}.${randomBytes(6).toString("hex")}.tmp`

/**
 * Moves a staged install into place whole. Should another run have put the same version
 * there meanwhile, its folder is kept, as that run may be using it, and the staging goes.
 * A folder there without the program is no install this code made: it is never removed
 * in place, and the install fails naming it.
 */
const settle = async (staging: string, folder: string, program: string): Promise<void> => {
  const broken = () =>
    new Error(`${folder} holds no ${program}: delete that folder, then run the tests again`)
  if (existsSync(program)) return
  if (existsSync(folder)) throw broken()
  try {
    await rename(staging, folder)
  } catch (error) {
    if (existsSync(program)) return
    throw existsSync(folder) ? broken() : error
  }
}

const installPackage = async (
  name: HarnessName,
  found: z.infer<typeof npmPin>,
): Promise<Installed> => {
  const cache = cacheFolder()
  await mkdir(join(cache, "home"), { recursive: true })
  const { package: spec, bin } = found
  const wanted = await npmVersion(name, found, cache)
  const folder = join(cache, `${name}-${wanted}`)
  const bins = join(folder, "node_modules", ".bin")
  const installed = { bin: bins, version: wanted }
  if (existsSync(join(bins, bin))) return installed
  // Installed beside it first, then moved into place whole, so a run stopped halfway
  // leaves nothing that looks installed.
  const staging = stagingFor(folder)
  await mkdir(staging, { recursive: true })
  try {
    await run(
      [
        "install",
        "--prefix",
        staging,
        "--no-save",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        `${spec}@${wanted}`,
      ],
      cache,
    )
    if (!existsSync(join(staging, "node_modules", ".bin", bin)))
      throw new Error(`${spec}@${wanted} installed no ${bin} program`)
    await settle(staging, folder, join(bins, bin))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return installed
}

type Release = { readonly version: string; readonly url: string; readonly sha512: string }

const release = z.strictObject({ version: z.string(), url: z.url(), sha512: z.string() })

/**
 * The release to install: the pinned one, or with `NOVADECK_E2E_HARNESS=latest`, the
 * newest the harness's manifest names, with that manifest's SHA-512, looked up once for
 * every run within the hour (`latestRelease`).
 */
const archiveRelease = async (
  name: HarnessName,
  found: z.infer<typeof archivePin>,
): Promise<Release> => {
  if (process.env.NOVADECK_E2E_HARNESS !== "latest")
    return { version: found.version, url: found.archive, sha512: found.sha512 }
  return latestRelease(latestFile(name), release, async () => {
    const response = await fetch(found.manifest)
    if (!response.ok) throw new Error(`${found.manifest} answered ${response.status}`)
    const { version, url, sha512 } = release.loose().parse(await response.json())
    return { version: safeVersion(version, found.manifest), url, sha512 }
  })
}

/**
 * Installs a harness published as an archive: downloads the release, checks it against
 * its SHA-512 before anything of it runs, and keeps only its program, named as NovaDeck
 * runs it. Only Linux on x86-64 is pinned.
 */
const installArchive = async (
  name: HarnessName,
  found: z.infer<typeof archivePin>,
): Promise<Installed> => {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error(`${name}'s end-to-end tests run on Linux x86-64 only`)
  const wanted = await archiveRelease(name, found)
  const folder = join(cacheFolder(), `${name}-${wanted.version}`)
  const bins = join(folder, "bin")
  const installed = { bin: bins, version: wanted.version }
  if (existsSync(join(bins, found.bin))) return installed
  // Unpacked beside it first, then moved into place whole, as a package is.
  const staging = stagingFor(folder)
  await mkdir(join(staging, "bin"), { recursive: true })
  try {
    const response = await fetch(wanted.url)
    if (!response.ok) throw new Error(`${wanted.url} answered ${response.status}`)
    const archive = Buffer.from(await response.arrayBuffer())
    const sha512 = createHash("sha512").update(archive).digest("hex")
    if (sha512 !== wanted.sha512)
      throw new Error(`${wanted.url} doesn't match its SHA-512: got ${sha512}`)
    await writeFile(join(staging, "release.tar.gz"), archive)
    await promisify(execFile)("tar", ["-xzf", "release.tar.gz", found.member], { cwd: staging })
    await rename(join(staging, found.member), join(staging, "bin", found.bin))
    await rm(join(staging, "release.tar.gz"))
    await settle(staging, folder, join(bins, found.bin))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return installed
}
