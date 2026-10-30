import { readdirSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"

import { describe, expect, it } from "vitest"

// The Package workflow keeps each engine it built in a cache, keyed on hashes of files, and
// rebuilds and re-signs it only when the key changes, which makes every user download it
// again. So the key hashes exactly what the build reads: a file it leaves out would ship a
// stale engine, and one more (a package.json, whose devDependencies Dependabot bumps) would
// rebuild the same engine for nothing.

const root = join(import.meta.dirname, "..", "..", "..")
const workflow = readFileSync(join(root, ".github/workflows/package.yml"), "utf8")
const read = (file: string): string => readFileSync(join(root, file), "utf8")

// Every file under `folder`, as a path from the repository's root, but what the build writes
// and the packages it installs.
const skipped = new Set(["node_modules", "dist", ".cache"])
const filesUnder = (folder: string): string[] =>
  readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) =>
    skipped.has(entry.name)
      ? []
      : entry.isDirectory()
        ? filesUnder(`${folder}/${entry.name}`)
        : [`${folder}/${entry.name}`],
  )
const engineFiles = filesUnder("engines")

// The files the `hashFiles(...)` calls in a part of a key hash: each call's patterns in order,
// a `!` one taking back what those before it matched.
const hashed = (part: string): string[] => {
  const patterns = [...part.matchAll(/hashFiles\(([^)]*)\)/g)].flatMap(([, call]) =>
    [...call!.matchAll(/'([^']+)'/g)].map((match) => match[1]!),
  )
  return engineFiles.filter((file) =>
    patterns.reduce(
      (taken, pattern) =>
        pattern.startsWith("!")
          ? taken && !posix.matchesGlob(file, pattern.slice(1))
          : taken || posix.matchesGlob(file, pattern),
      false,
    ),
  )
}

// The engine's cache key, split where it adds what only Linux's and Windows' builds use.
const keyOf = (engine: string): { everywhere: string; linux: string; windows: string } => {
  const key = new RegExp(`^\\s+key: ${engine}-engine-(.*)$`, "m").exec(workflow)?.[1]
  if (!key) throw new Error(`The Package workflow has no cache key for the ${engine} engine`)
  const [everywhere, platforms] = key.split("${{ matrix.target == 'linux' &&")
  const [linux, windows] = platforms?.split("|| matrix.target == 'win' &&") ?? []
  if (!everywhere || !linux || !windows) {
    throw new Error(`The ${engine} engine's cache key has no part for Linux's or Windows' builds`)
  }
  return { everywhere, linux, windows }
}

// The repository's files a script runs: it and every module it imports, in this repository,
// the shared build's by its package's entry.
const sharedEntry = posix.join(
  "engines/ggml-build",
  (JSON.parse(read("engines/ggml-build/package.json")) as { exports: { ".": string } }).exports[
    "."
  ],
)
const modulesOf = (script: string, found = new Set<string>()): Set<string> => {
  if (found.has(script)) return found
  found.add(script)
  const imports = /^(?:import|export)\b[^"';=]*?\bfrom "([^"]+)"|^import "([^"]+)"/gm
  for (const match of read(script).matchAll(imports)) {
    const specifier = match[1] ?? match[2]!
    if (specifier === "@novadeck/ggml-build") modulesOf(sharedEntry, found)
    else if (specifier.startsWith("."))
      modulesOf(posix.join(posix.dirname(script), specifier), found)
  }
  return found
}

describe.each(["whisper", "murmur"])("the %s engine's cache key", (engine) => {
  const key = keyOf(engine)

  it("hashes the build's scripts and the engine's patches, and nothing else", () => {
    const patches = engineFiles.filter((file) => file.startsWith(`engines/${engine}/patches/`))
    expect(patches.length).toBeGreaterThan(0)
    const inputs = [...modulesOf(`engines/${engine}/scripts/build.ts`), ...patches]
    // The script pins the upstream source by its commit and checksum.
    expect(read(`engines/${engine}/scripts/build.ts`)).toMatch(/sourceSha256: "[0-9a-f]{64}"/)
    expect(inputs).toContain("engines/ggml-build/src/cmake.ts")
    expect(hashed(key.everywhere).toSorted()).toEqual(inputs.toSorted())
  })

  it("runs the script it hashes as it is, the way Linux's container runs it", () => {
    const manifest = JSON.parse(read(`engines/${engine}/package.json`)) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts["build:engine"]).toBe("node scripts/build.ts")
    expect(workflow).toContain(
      `--workdir "$PWD/engines/${engine}" novadeck-engine-build node scripts/build.ts`,
    )
  })

  it("leaves out the packages' manifests and tests", () => {
    const left = engineFiles.filter((file) => !hashed(key.everywhere).includes(file))
    expect(left).toContain(`engines/${engine}/package.json`)
    expect(left).toContain("engines/ggml-build/package.json")
    expect(left).toContain("engines/ggml-build/src/cache-keys.test.ts")
  })

  it("hashes the image Linux builds in, and names the Vulkan SDK Windows builds with", () => {
    expect(hashed(key.linux)).toEqual(["engines/ggml-build/Dockerfile"])
    expect(key.linux).toContain("env.ENGINE_BUILD_BASE")
    expect(key.windows).toContain("env.ENGINE_VULKAN_SDK")
  })
})

describe("the Vulkan SDK", () => {
  it("is the same version in the Linux image as on Windows", () => {
    const windows = /^\s+ENGINE_VULKAN_SDK: (\S+)$/m.exec(workflow)?.[1]
    const linux = /^ARG VULKAN_SDK_VERSION=(\S+)$/m.exec(read("engines/ggml-build/Dockerfile"))?.[1]
    expect(windows).toBeDefined()
    expect(linux).toBe(windows)
  })
})
