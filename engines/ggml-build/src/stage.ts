import { lstatSync, readFileSync, readlinkSync } from "node:fs"
import { cp, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

import { machine } from "./machine.ts"

/** Whether the file is a shared library or backend module on this platform, versioned Linux ones included. */
export const isLibrary = (name: string, platform: NodeJS.Platform): boolean => {
  if (platform === "win32") return name.endsWith(".dll")
  if (platform === "darwin") return name.endsWith(".dylib")
  return name.endsWith(".so") || name.includes(".so.")
}

// Two files the build wrote under one name are the same when they are the same link or the
// same bytes; flattened into staging, either would do.
const same = (a: string, b: string): boolean => {
  const linked = lstatSync(a).isSymbolicLink()
  if (linked !== lstatSync(b).isSymbolicLink()) return false
  return linked ? readlinkSync(a) === readlinkSync(b) : readFileSync(a).equals(readFileSync(b))
}

/**
 * Gathers the server and every library and module it loads into `staging`, emptied first,
 * flat, wherever the generator put them. Links keep their names, as the server asks for them by
 * soname. Two different files under one name stop the build: which one the engine shipped
 * would be chance, and the server loads every `ggml-*` module beside it.
 */
export const stage = async (
  build: string,
  staging: string,
  executable: string,
  platform: NodeJS.Platform = machine.platform,
): Promise<void> => {
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const files = (await readdir(build, { recursive: true, withFileTypes: true })).filter(
    (file) => !file.isDirectory(),
  )
  const wanted = new Map<string, string>()
  for (const file of files) {
    if (file.name !== executable && !isLibrary(file.name, platform)) continue
    if (file.parentPath.includes("CMakeFiles")) continue
    const path = join(file.parentPath, file.name)
    const earlier = wanted.get(file.name)
    if (earlier !== undefined && !same(earlier, path)) {
      throw new Error(`The build produced two different ${file.name}: ${earlier} and ${path}.`)
    }
    wanted.set(file.name, earlier ?? path)
  }
  if (!wanted.has(executable)) throw new Error(`The build produced no ${executable}.`)
  await Promise.all(
    [...wanted].map(([name, path]) => cp(path, join(staging, name), { verbatimSymlinks: true })),
  )
}
