import { cp, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

import { machine } from "./machine.ts"

/** Whether the file is a shared library or backend module on this platform, versioned Linux ones included. */
export const isLibrary = (name: string, platform: NodeJS.Platform): boolean => {
  if (platform === "win32") return name.endsWith(".dll")
  if (platform === "darwin") return name.endsWith(".dylib")
  return name.endsWith(".so") || name.includes(".so.")
}

/**
 * Gathers the server and every library and module it loads into `staging`, emptied first,
 * flat, wherever the generator put them. Links keep their names, as the server asks for them by
 * soname.
 */
export const stage = async (build: string, staging: string, executable: string): Promise<void> => {
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const files = (await readdir(build, { recursive: true, withFileTypes: true })).filter(
    (file) => !file.isDirectory(),
  )
  const wanted = files.filter(
    (file) =>
      (file.name === executable || isLibrary(file.name, machine.platform)) &&
      !file.parentPath.includes("CMakeFiles"),
  )
  if (!wanted.some((file) => file.name === executable)) {
    throw new Error(`The build produced no ${executable}.`)
  }
  await Promise.all(
    wanted.map((file) =>
      cp(join(file.parentPath, file.name), join(staging, file.name), {
        verbatimSymlinks: true,
      }),
    ),
  )
}
