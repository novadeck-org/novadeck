import { existsSync, realpathSync } from "node:fs"
import { lstat, mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, posix, win32 } from "node:path"

import { TourError } from "./errors.js"

/** How many folders the tour may use: `tour`, then `tour-2` up to `tour-99`. */
export const tourFolderCount = 99

/**
 * Where the tour runs: `~/.novadeck/tour` or, the nth time one is kept by the person (and so no
 * longer the tour's), `tour-2`, `tour-3`, and so on. Folders of Novadeck's own.
 */
export const tourFolder = (home: string = homedir(), nth = 1): string =>
  join(home, ".novadeck", nth === 1 ? "tour" : `tour-${nth}`)

// The names of the tour's folders: `tour`, and `tour-2` to `tour-99`.
const folderName = /^tour(?:-([2-9]|[1-9]\d))?$/

/**
 * The file that marks the folder as the tour's: only a folder holding it, or an empty one, is
 * wiped, so a folder of the person's own at that path is never lost.
 */
export const tourMarker = ".novadeck-tour"

/** Whether the folder holds the marker. Asked often, so it is one synchronous look. */
export const hasMarker = (folder: string): boolean => existsSync(join(folder, tourMarker))

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
    throw new TourError(`${folder} isn't a folder Novadeck made for the tour.`)
  const entries = found ? await readdir(folder) : []
  if (entries.length > 0 && !entries.includes(tourMarker))
    throw new TourError(
      `${folder} holds files Novadeck didn't put there, so the tour leaves it as it is. Move or remove that folder to take the tour.`,
    )
  return entries
}

/**
 * The folder the next run uses: the first of `tour`, `tour-2`, ... that is missing, empty or
 * the tour's own (holding the marker), so a run wipes it. One the person keeps (files and no
 * marker) is passed over, never refused. Only `tour` itself being no folder (a file, or a
 * link: nothing of Novadeck's to put there) or all of them being taken is a `CONFLICT`. Changes
 * nothing: asked before the tour removes the projects open at the folder.
 */
export const chooseTourFolder = async (home: string = homedir()): Promise<string> => {
  for (let nth = 1; nth <= tourFolderCount; nth++) {
    const folder = tourFolder(home, nth)
    // eslint-disable-next-line no-await-in-loop -- Looked at in turn: the first that fits wins.
    const found = await lstat(folder).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (!found) return folder
    if (!found.isDirectory()) {
      if (nth === 1) throw new TourError(`${folder} isn't a folder Novadeck made for the tour.`)
      continue
    }
    // eslint-disable-next-line no-await-in-loop -- As above.
    const entries = await readdir(folder)
    if (entries.length === 0 || entries.includes(tourMarker)) return folder
  }
  throw new TourError(
    `Every folder ${join(home, ".novadeck")} keeps for the tour (tour to tour-${tourFolderCount}) holds files Novadeck didn't put there. Move or remove one of them to take the tour.`,
  )
}

// The path with its links resolved, or as it is where it can't be (missing, say).
const realPath = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Whether `path` is `folder` or inside it. Windows' and macOS' file systems don't tell cases
 * apart (macOS' as installed), so neither does this there.
 */
export const withinFolder = (
  path: string,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  const paths = platform === "win32" ? win32 : posix
  const fold = (text: string) =>
    platform === "win32" || platform === "darwin" ? text.toLowerCase() : text
  const inner = paths.relative(fold(paths.resolve(folder)), fold(paths.resolve(path)))
  return inner === "" || (inner.split(paths.sep)[0] !== ".." && !paths.isAbsolute(inner))
}

/**
 * Whether `path` is `folder` or inside it, by the path as given or by real paths on both sides,
 * as a terminal's folder is reported as its shell or the launcher resolved it.
 */
export const insideFolder = (
  path: string,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): boolean =>
  withinFolder(path, folder, platform) || withinFolder(realPath(path), realPath(folder), platform)

// The tour's folder (of the `tour`, `tour-2`, ... names) that `path` is in, as the path is
// given, or as it is with links resolved: a terminal's folder is reported as its shell or the
// launcher resolved it, and the home folder or `~/.novadeck` may be a symlink. None if it is in
// none of them.
export const folderOf = (
  path: string,
  home: string,
  platform: NodeJS.Platform,
): string | undefined => {
  const paths = platform === "win32" ? win32 : posix
  const root = tourFolder(home)
  const parent = dirname(root)
  for (const [at, base] of [
    [path, parent],
    [realPath(path), realPath(parent)],
  ] as const) {
    if (!withinFolder(at, base, platform)) continue
    // Folded as `withinFolder` folds, so a path that differs from the home in case only counts.
    const fold = (text: string) =>
      platform === "win32" || platform === "darwin" ? text.toLowerCase() : text
    const first =
      paths.relative(fold(paths.resolve(base)), fold(paths.resolve(at))).split(paths.sep)[0] ?? ""
    if (folderName.test(first)) return join(base, first)
  }
  return undefined
}

/**
 * Whether `path` is the tour's folder or inside it: one of the names the tour uses (`tour`,
 * `tour-2`, ...) in `~/.novadeck` and holding the marker, so a folder the person kept
 * (`keepTourFolder`) is no longer the tour's.
 */
export const inTourFolder = (
  path: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean => {
  const folder = folderOf(path, home, platform)
  return folder !== undefined && hasMarker(folder)
}

/**
 * Hands the folder to the person, from the tour's side: the tour's Claude Code settings, which
 * let teammates edit unasked, are removed (and `.claude` with them where nothing else is in it),
 * and then the marker, so the folder is no longer the tour's: no later run wipes or reuses it
 * and no tour rule applies there. The marker goes last, so a failure before it leaves a folder
 * that is still the tour's and can be kept again. A folder without the marker isn't the tour's,
 * and is left as it is. The project's note and git are `releaseSandbox`'s.
 */
export const keepTourFolder = async (folder: string): Promise<void> => {
  if (!hasMarker(folder)) return
  const claude = join(folder, ".claude")
  await rm(join(claude, "settings.json"), { force: true })
  // `rmdir` only where it is empty; a folder with the person's own files stays.
  await rmdir(claude).catch(() => undefined)
  await rm(join(folder, tourMarker), { force: true })
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
