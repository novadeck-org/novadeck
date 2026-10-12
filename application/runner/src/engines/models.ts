import { readdir, rm } from "node:fs/promises"
import { basename, join } from "node:path"

/**
 * Where a model file lives under `directory`: named by the first twelve digits of its
 * checksum as well as its name, so a file re-uploaded under the same name is another
 * file and is fetched, not mistaken for the one already there.
 */
export const modelFile = (
  directory: string,
  artifact: { readonly url: string; readonly sha256: string },
): string => join(directory, "models", `${artifact.sha256.slice(0, 12)}-${basename(artifact.url)}`)

/** Removes every file in `directory`'s models folder but those in `keep`: the models a pin bump replaced. */
export const pruneModels = async (directory: string, keep: readonly string[]): Promise<void> => {
  const folder = join(directory, "models")
  const wanted = new Set(keep.map((path) => basename(path)))
  const entries = await readdir(folder).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => !wanted.has(entry))
      .map((entry) => rm(join(folder, entry), { recursive: true, force: true })),
  )
}
