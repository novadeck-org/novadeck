import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join, parse } from "node:path"

import { replaceFile, type Run, sha256, tar, windows } from "./machine.ts"
import type { EngineSpec } from "./spec.ts"

/** The source tarball at the pinned commit, checked before anything reads it and kept so later builds need no network. */
export const download = async (spec: EngineSpec, cache: string): Promise<string> => {
  const { project, version, commit, sourceUrl, sourceSha256 } = spec
  const tarball = join(cache, `${project}-${commit}.tar.gz`)
  if (existsSync(tarball) && sha256(readFileSync(tarball)) === sourceSha256) return tarball
  console.log(`Downloading ${project} ${version}`)
  const response = await fetch(sourceUrl)
  if (!response.ok) throw new Error(`Downloading ${sourceUrl} failed: ${response.status}`)
  const data = new Uint8Array(await response.arrayBuffer())
  if (sha256(data) !== sourceSha256) {
    throw new Error(`${project}'s source tarball is not the one pinned (${sourceUrl}).`)
  }
  await mkdir(cache, { recursive: true })
  await replaceFile(tarball, data)
  return tarball
}

/**
 * The folders a build of `commit` with these patches uses: one in the cache named by both,
 * so a changed patch extracts and builds afresh and an unchanged one reuses the last build,
 * and a shorter name for Windows' build folder.
 */
export const buildKeys = (
  commit: string,
  patches: readonly Uint8Array[],
): { readonly key: string; readonly short: string } => {
  const hash = createHash("sha256")
  for (const patch of patches) hash.update(patch)
  const digest = hash.digest("hex")
  return {
    key: `${commit.slice(0, 12)}-${digest.slice(0, 12)}`,
    short: `${commit.slice(0, 8)}-${digest.slice(0, 6)}`,
  }
}

/** The source with the engine's patches applied, and the folder to build it in. */
export const prepare = async (
  spec: EngineSpec,
  cache: string,
  tarball: string,
  run: Run,
): Promise<{ source: string; build: string }> => {
  const patchesDirectory = join(spec.root, "patches")
  const patches = readdirSync(patchesDirectory)
    .filter((name) => name.endsWith(".patch"))
    .toSorted()
    .map((name) => join(patchesDirectory, name))
  const { key, short } = buildKeys(
    spec.commit,
    patches.map((patch) => readFileSync(patch)),
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
      run("git", ["apply", "--whitespace=nowarn", patch], { cwd: source, env: bare })
      // A patch that did not take must stop the build, not ship an unpatched server.
      run("git", ["apply", "--reverse", "--check", patch], { cwd: source, env: bare })
    }
    await writeFile(join(directory, "patched"), "")
  }
  return { source, build: windows ? windowsBuild(spec, short) : join(directory, "build") }
}

// MSBuild fails past 260 characters, and the Vulkan backend's shader generator is a project
// nested deep inside the build tree, so on Windows the build goes to a short folder at the
// drive's root, or where the engine's environment variable says.
const windowsBuild = (spec: EngineSpec, short: string): string =>
  process.env[spec.windowsBuild.env] ?? join(parse(spec.root).root, spec.windowsBuild.folder, short)
