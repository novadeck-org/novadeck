import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join, parse } from "node:path"

import { type Configuration, configurations } from "./cmake.ts"
import { machine, replaceFile, type Run, sha256, tar, windows } from "./machine.ts"
import type { EngineSpec } from "./spec.ts"

// GitHub makes the tarball on request; a slow one is retried by the next run, not waited on.
const downloadTimeout = 10 * 60 * 1000

/** Why the bytes are not the pinned tarball, naming what they are, or nothing when they are it. */
export const notPinned = (spec: EngineSpec, data: Uint8Array): string | undefined => {
  const digest = sha256(data)
  if (digest === spec.sourceSha256) return undefined
  // The digest and size tell a tarball GitHub made afresh from a cut-off or HTML response.
  return (
    `${spec.project}'s source tarball is not the one pinned (${spec.sourceUrl}): ` +
    `got ${data.length} bytes with sha256 ${digest}, not ${spec.sourceSha256}.`
  )
}

/** The source tarball at the pinned commit, checked before anything reads it and kept so later builds need no network. */
export const download = async (spec: EngineSpec, cache: string): Promise<string> => {
  const { project, version, commit, sourceUrl } = spec
  const tarball = join(cache, `${project}-${commit}.tar.gz`)
  if (existsSync(tarball) && !notPinned(spec, readFileSync(tarball))) return tarball
  console.log(`Downloading ${project} ${version}`)
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(downloadTimeout) })
  if (!response.ok) throw new Error(`Downloading ${sourceUrl} failed: ${response.status}`)
  const data = new Uint8Array(await response.arrayBuffer())
  const problem = notPinned(spec, data)
  if (problem) throw new Error(problem)
  await mkdir(cache, { recursive: true })
  await replaceFile(tarball, data)
  return tarball
}

/**
 * The folders a build of `commit` with these patches and CMake configurations uses: one in
 * the cache named by all three, so a changed patch or option extracts and builds afresh (an
 * option taken away would otherwise keep its old value in CMake's cache) and an unchanged
 * build reuses the last one, and a shorter name for Windows' build folder.
 */
export const buildKeys = (
  commit: string,
  patches: readonly Uint8Array[],
  built: readonly Configuration[],
): { readonly key: string; readonly short: string } => {
  const hash = createHash("sha256")
  for (const patch of patches) hash.update(patch)
  hash.update(JSON.stringify(built))
  const digest = hash.digest("hex")
  return {
    key: `${commit.slice(0, 12)}-${digest.slice(0, 12)}`,
    short: `${commit.slice(0, 8)}-${digest.slice(0, 6)}`,
  }
}

/**
 * The engine's patches as paths, in the order its spec lists them. The folder must hold
 * exactly those: a patch left out of the list would not apply, and one listed but missing
 * would ship the server without it.
 */
export const patchFiles = (spec: EngineSpec): string[] => {
  const folder = join(spec.root, "patches")
  const present = readdirSync(folder).filter((name) => name.endsWith(".patch"))
  const unlisted = present.filter((name) => !spec.patches.includes(name))
  const missing = spec.patches.filter((name) => !present.includes(name))
  if (unlisted.length > 0 || missing.length > 0) {
    throw new Error(
      `The ${spec.label}'s patch list and its patches folder differ: ` +
        [
          ...unlisted.map((name) => `${name} is not listed`),
          ...missing.map((name) => `${name} is not in the folder`),
        ].join(", ") +
        ".",
    )
  }
  return spec.patches.map((name) => join(folder, name))
}

// The file a diff's `--- ` or `+++ ` line names, without git's a/ and b/ prefixes, which
// `git apply` strips; nothing for /dev/null.
const headerPath = (line: string): string | undefined => {
  const name = line.slice(4).split("\t")[0]!.trim()
  return name === "/dev/null" ? undefined : name.replace(/^[ab]\//, "")
}

/**
 * The files a unified diff changes, as paths in the source: the new name, or the old one for
 * a file it deletes.
 */
export const patchTargets = (patch: string): string[] => {
  const lines = patch.split("\n")
  const targets = lines.flatMap((line, index) => {
    // A file's header is its old name's line followed by its new name's, which a removed
    // line and an added one would only mimic as "-- " and "++ " in a row.
    const next = lines[index + 1]
    if (!line.startsWith("--- ") || !next?.startsWith("+++ ")) return []
    const target = headerPath(next) ?? headerPath(line)
    return target === undefined ? [] : [target]
  })
  return [...new Set(targets)]
}

const contents = (path: string): Buffer | undefined =>
  existsSync(path) ? readFileSync(path) : undefined

/** The source with the engine's patches applied, and the folder to build it in. */
export const prepare = async (
  spec: EngineSpec,
  cache: string,
  tarball: string,
  run: Run,
): Promise<{ source: string; build: string }> => {
  const patches = patchFiles(spec)
  const { key, short } = buildKeys(
    spec.commit,
    patches.map((patch) => readFileSync(patch)),
    configurations(spec.options, machine),
  )
  const directory = join(cache, key)
  const source = join(directory, "source")
  if (!existsSync(join(directory, "patched"))) {
    await rm(directory, { recursive: true, force: true })
    await mkdir(source, { recursive: true })
    run(tar, ["-xzf", tarball, "--strip-components=1", "-C", source])
    // The source is a bare folder to git: inside this repository it would skip every file
    // this repository ignores, as the cache is, and report success.
    const bare = { ...process.env, GIT_CEILING_DIRECTORIES: cache }
    for (const patch of patches) {
      const targets = patchTargets(readFileSync(patch, "utf8"))
      if (targets.length === 0) throw new Error(`${patch} changes no file.`)
      const before = targets.map((target) => contents(join(source, target)))
      run("git", ["apply", "--whitespace=nowarn", patch], { cwd: source, env: bare })
      // A patch that did not take must stop the build, not ship an unpatched server. git
      // skips a file it reads as outside the folder and still succeeds, so each file the
      // patch names is checked for the change itself, apart from git.
      const unchanged = targets.filter((target, index) => {
        const after = contents(join(source, target))
        const earlier = before[index]
        return after === undefined || earlier === undefined
          ? after === earlier
          : after.equals(earlier)
      })
      if (unchanged.length > 0) {
        throw new Error(`${patch} did not change ${unchanged.join(", ")}.`)
      }
    }
    await writeFile(join(directory, "patched"), "")
  }
  return { source, build: windows ? windowsBuild(spec, short) : join(directory, "build") }
}

/**
 * The Windows build folder. MSBuild fails past 260 characters, and the Vulkan backend's
 * shader generator is a project nested deep inside the build tree, so on Windows the build
 * goes to a short folder at the drive's root, or where the engine's environment variable
 * says when it says anything.
 */
export const windowsBuild = (
  spec: EngineSpec,
  short: string,
  env: NodeJS.ProcessEnv = process.env,
): string =>
  env[spec.windowsBuild.env] || join(parse(spec.root).root, spec.windowsBuild.folder, short)
