import { spawn } from "node:child_process"
import type { Dirent } from "node:fs"
import { readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"

import type { FolderListing } from "@novadeck/protocol"

import { DomainError } from "../errors.js"

/** The most entries one folder lists; a folder holding more says so (`truncated`). */
export const maxFolderEntries = 2000

/** How long git may take to say which entries it ignores, in milliseconds. */
const ignoreTimeout = 2000

type Entry = FolderListing["entries"][number]
/** An entry before git is asked, saying whether it is a link, which git names without a slash. */
type Found = Entry & { readonly link: boolean }

const invalid = (message: string): DomainError => new DomainError("INVALID_DIRECTORY", message)

/**
 * The names of a folder's path, which is relative to a project's root, `/` between names
 * and "" for the root itself. Refuses anything else, so a path can't lead out of the root.
 */
const segments = (folder: string): string[] => {
  if (folder === "") return []
  if (folder.includes("\\") || folder.includes("\0")) throw invalid("That isn't a folder path.")
  const names = folder.split("/")
  if (names.some((name) => name === "" || name === "." || name === ".."))
    throw invalid("That isn't a folder path.")
  return names
}

/** Whether `path` is `root` or lies inside it; both resolved alike. */
const within = (root: string, path: string): boolean => {
  const route = relative(root, path)
  return route === "" || (!isAbsolute(route) && route.split(sep)[0] !== "..")
}

/**
 * Which of the entries git ignores, by name, in the repository around `root`. Only reads:
 * a folder that is no repository, no git installed, git failing or taking too long all
 * mean nothing is ignored, as a listing never fails over it.
 */
const ignoredNames = (root: string, prefix: string, entries: Found[]): Promise<Set<string>> =>
  new Promise((resolve) => {
    const none = new Set<string>()
    if (entries.length === 0) return resolve(none)
    // A folder is named with a slash at its end, or a pattern for directories wouldn't match
    // it; but git refuses a path that goes beyond a link, which that slash does for a link.
    const paths = entries.map(
      (entry) => `${prefix}${entry.name}${entry.folder && !entry.link ? "/" : ""}`,
    )
    let finished = false
    const finish = (names: Set<string>) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(names)
    }
    // The fsmonitor is off because a repository's own config can name a program for it to
    // run, and reading a folder must never run anything a project brings along. Optional
    // locks are off so asking never touches the repository's index.
    const git = spawn(
      "git",
      ["-c", "core.fsmonitor=false", "-C", root, "check-ignore", "-z", "--stdin"],
      {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      },
    )
    const timer = setTimeout(() => {
      git.kill()
      finish(none)
    }, ignoreTimeout)
    const chunks: Buffer[] = []
    git.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    git.on("error", () => finish(none))
    git.stdin.on("error", () => {})
    git.on("close", (code) => {
      // Exit 1 means none of them is ignored; anything but 0 and 1 is a failure.
      if (code !== 0) return finish(none)
      const found = new Set(Buffer.concat(chunks).toString("utf8").split("\0"))
      finish(
        new Set(entries.filter((_, index) => found.has(paths[index]!)).map(({ name }) => name)),
      )
    })
    git.stdin.end(paths.map((path) => `${path}\0`).join(""))
  })

/** What a directory entry is for a listing: a folder, a file, or neither (undefined). */
const kindOf = async (directory: string, dirent: Dirent): Promise<Found | undefined> => {
  const entry = { name: dirent.name, ignored: false }
  if (dirent.isDirectory()) return { ...entry, folder: true, link: false }
  if (dirent.isFile()) return { ...entry, folder: false, link: false }
  if (!dirent.isSymbolicLink()) return undefined
  // A link is what it points at; one that points at nothing counts as a file.
  const target = await stat(join(directory, dirent.name)).catch(() => undefined)
  if (target === undefined) return { ...entry, folder: false, link: true }
  if (target.isDirectory()) return { ...entry, folder: true, link: true }
  return target.isFile() ? { ...entry, folder: false, link: true } : undefined
}

/**
 * One folder of a project's directory, `folder` being its path from the project's root
 * (`src/cart`, or "" for the root). Folders come first, then files, each by name; git's own
 * `.git` is left out. `INVALID_DIRECTORY` for a path that is badly formed, a folder that is
 * missing or no folder, or one that leads out of the root, as through a link.
 */
export const listFolder = async (root: string, folder: string): Promise<FolderListing> => {
  const names = segments(folder)
  const real = await realpath(root).catch(() => undefined)
  if (real === undefined) throw invalid("The project's folder is gone.")
  const directory = await realpath(join(real, ...names)).catch(() => undefined)
  if (directory === undefined) throw invalid("That folder is gone.")
  if (!within(real, directory)) throw invalid("That folder is outside the project.")
  const dirents = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code
    throw invalid(code === "ENOTDIR" ? "That isn't a folder." : "That folder can't be read.")
  })
  const found = await Promise.all(
    dirents.map((dirent) => (dirent.name === ".git" ? undefined : kindOf(directory, dirent))),
  )
  const listed = found.filter((entry) => entry !== undefined)
  listed.sort(
    (a, b) =>
      Number(b.folder) - Number(a.folder) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
  const entries = listed.slice(0, maxFolderEntries)
  // Named by where it really is, so a folder reached through a link in the project is too.
  const route = relative(real, directory).split(sep).join("/")
  const ignored = await ignoredNames(real, route === "" ? "" : `${route}/`, entries)
  return {
    entries: entries.map(({ name, folder: isFolder }) => ({
      name,
      folder: isFolder,
      ignored: ignored.has(name),
    })),
    truncated: listed.length > entries.length,
  }
}
