import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { DomainError } from "../errors.js"

/** Where the tour runs: `~/.novadeck/tour`, a folder of Novadeck's own, never a git repository. */
export const tourFolder = (home: string = homedir()): string => join(home, ".novadeck", "tour")

/**
 * The file that marks the folder as the tour's: only a folder holding it, or an empty one, is
 * wiped, so a folder of the person's own at that path is never lost.
 */
export const tourMarker = ".novadeck-tour"

const markerText =
  "This folder is Novadeck's tour. Novadeck empties it each time the tour starts.\n"

/**
 * What the tour's folder holds, by name (none where it is missing), once it is known to be the
 * tour's. One that is no folder (a file, or a link to anywhere), or that holds files without
 * the marker, is the person's: it is a `CONFLICT`, and nothing in it changes.
 */
const tourEntries = async (folder: string): Promise<string[]> => {
  const found = await lstat(folder).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
  if (found && !found.isDirectory())
    throw new DomainError("CONFLICT", `${folder} isn't a folder Novadeck made for the tour.`)
  const entries = found ? await readdir(folder) : []
  if (entries.length > 0 && !entries.includes(tourMarker))
    throw new DomainError(
      "CONFLICT",
      `${folder} holds files Novadeck didn't put there, so the tour leaves it as it is. Move or remove that folder to take the tour.`,
    )
  return entries
}

/**
 * Refuses, as `resetTourFolder` would, a folder that isn't the tour's, changing nothing: asked
 * before the tour removes the projects open there, so a refusal leaves them be.
 */
export const checkTourFolder = async (folder: string): Promise<void> => {
  await tourEntries(folder)
}

/**
 * Empties the tour's folder and writes `files` there, by name, with the marker beside them.
 * The folder is made where it is missing. One that isn't the tour's is a `CONFLICT`
 * (`tourEntries`), and nothing in it changes: asked again here, as files may have come while
 * the projects there closed. The folder itself stays, emptied in place, so a shell still in it
 * as it closes doesn't keep it from going on Windows.
 */
export const resetTourFolder = async (
  folder: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> => {
  const entries = await tourEntries(folder)
  // `rm` removes a link inside, never what it points to. On Windows a file a closing shell
  // still holds is busy for a moment, which the retries wait out.
  await Promise.all(
    entries.map((entry) =>
      rm(join(folder, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ),
  )
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, tourMarker), markerText)
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      // A name may sit in a folder of its own (`.claude/settings.json`).
      await mkdir(dirname(join(folder, name)), { recursive: true })
      await writeFile(join(folder, name), content)
    }),
  )
}
