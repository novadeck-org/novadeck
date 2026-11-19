import type { FolderListing } from "../../../frontend/core/src/files.ts"
import type { Work, WorkFile } from "../../../frontend/core/src/works.ts"

// The Files panel bench's synthetic project and works: pure, so the page and the tests make the
// same ones. Everything is seeded, so two runs feed the panel the same tree and the same files.

export type Config = {
  /** Folders under the root; every one holds at least one file, so every one can open. */
  readonly folders: number
  /** Files in all, spread over the root and the folders. */
  readonly files: number
  /** Worktrees tracked, each owned by an agent with a handle. */
  readonly worktrees: number
  /** Worktrees whose work changes in each poll. */
  readonly changed: number
  /** Files each worktree changes. */
  readonly filesPerWorktree: number
  /** Polls measured, after the warm-up ones. */
  readonly polls: number
  /** Polls fed before the measured ones, not reported. */
  readonly warmup: number
  /** Agent turn ends measured after the polls: each has every open folder read again. */
  readonly turns: number
  /** Whether each poll ends with a `synced`, which the runner's stream doesn't send after its first. */
  readonly synced: boolean
  readonly seed: number
}

export const defaults: Config = {
  folders: 300,
  files: 3000,
  worktrees: 20,
  changed: 3,
  filesPerWorktree: 10,
  polls: 15,
  warmup: 3,
  turns: 0,
  synced: false,
  seed: 1,
}

/** The problem with a config, in words, or undefined where it holds. */
export const configProblem = (config: Config): string | undefined => {
  const whole: readonly (keyof Config)[] = [
    "folders",
    "files",
    "worktrees",
    "changed",
    "filesPerWorktree",
    "polls",
    "warmup",
    "turns",
    "seed",
  ]
  for (const key of whole) {
    const value = config[key] as number
    if (!Number.isInteger(value) || value < 0) return `${key} takes a whole number, 0 or more`
  }
  if (config.folders < 1 || config.worktrees < 1 || config.polls < 1)
    return "folders, worktrees and polls take 1 or more"
  if (config.files <= config.folders) return "files must exceed folders, so every folder holds one"
  if (config.changed > config.worktrees) return "changed can't exceed worktrees"
  if (config.filesPerWorktree < 1 && config.changed > 0) return "filesPerWorktree takes 1 or more"
  return undefined
}

// A small seeded generator (mulberry32).
export const random = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Project = {
  /** Every folder's entries, by its path from the root ("" for the root). */
  readonly listings: ReadonlyMap<string, FolderListing>
  /** Every file's path, in the order made. */
  readonly files: readonly string[]
  /** The folders' paths, the root excluded. */
  readonly folders: readonly string[]
}

const extensions = ["ts", "tsx", "json", "md", "css"] as const

/**
 * A tree of `folders` folders, four to a parent, and `files` files dealt out over the root and
 * the folders in turn, so each holds at least one while there are more files than folders.
 */
export const makeProject = ({ folders, files }: Pick<Config, "folders" | "files">): Project => {
  const folderPaths: string[] = []
  const children = new Map<string, { name: string; folder: boolean }[]>([["", []]])
  for (let index = 1; index <= folders; index++) {
    const parent = index <= 4 ? "" : folderPaths[Math.floor((index - 1) / 4) - 1]!
    const name = `dir${index}`
    const path = parent === "" ? name : `${parent}/${name}`
    folderPaths.push(path)
    children.set(path, [])
    children.get(parent)!.push({ name, folder: true })
  }
  const places = ["", ...folderPaths]
  const filePaths: string[] = []
  for (let index = 0; index < files; index++) {
    const folder = places[index % places.length]!
    const name = `file${index}.${extensions[index % extensions.length]}`
    filePaths.push(folder === "" ? name : `${folder}/${name}`)
    children.get(folder)!.push({ name, folder: false })
  }
  const listings = new Map(
    [...children].map(([path, entries]) => [
      path,
      { entries: entries.map((entry) => ({ ...entry, ignored: false })), truncated: false },
    ]),
  )
  return { listings, files: filePaths, folders: folderPaths }
}

/** The handle of the agent that owns worktree `index`. */
export const handleOf = (index: number): string => `a${index + 1}`

/** The terminal id that owns worktree `index`. */
export const terminalOf = (index: number): string => `t${index + 1}`

export const rootOf = (index: number): string => `/work/wt${index + 1}`

/** The paths each worktree changes: a seeded draw from the project's files, overlap allowed. */
export const changedPaths = (project: Project, config: Config): readonly (readonly string[])[] => {
  const next = random(config.seed)
  return Array.from({ length: config.worktrees }, () =>
    Array.from(
      { length: config.filesPerWorktree },
      () => project.files[Math.floor(next() * project.files.length)]!,
    ),
  )
}

const fileOf = (path: string, index: number, at: number): WorkFile => ({
  path,
  status: index % 5 === 0 ? "added" : "modified",
  changedAt: at,
  added: 3 + (index % 7),
  removed: index % 4,
  unreadAdded: 3 + (index % 7),
  unreadRemoved: index % 4,
  conflict: false,
})

/** A worktree's work, its files stamped `at`. `index` -1 makes none: the seed work. */
export const workOf = (
  index: number,
  paths: readonly string[],
  at: number,
  projectId: string,
): Work => {
  const files = [...new Set(paths)].map((path, place) => fileOf(path, place, at))
  return {
    root: index < 0 ? "/work/seed" : rootOf(index),
    terminalId: index < 0 ? "seed" : terminalOf(index),
    projectId,
    working: true,
    branch: `feat/bench-${index + 1}`,
    base: "main",
    firstSeenAt: at,
    merged: false,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    unreadAdded: 0,
    unreadRemoved: 0,
    files,
    truncated: false,
    folder: { repo: "", project: "" },
    conflicts: [],
  }
}

/** The worktrees that change in poll `poll`: `changed` of them, rotating through all. */
export const changedIn = (poll: number, { worktrees, changed }: Config): readonly number[] =>
  Array.from({ length: changed }, (_, place) => (poll * changed + place) % worktrees)

/**
 * The seed work: one file in every folder, so each folder has a change inside and starts open
 * (the panel opens the folders with changes once, when it first has the root). It is let go
 * before anything is measured, and the folders stay open.
 */
export const seedPaths = (project: Project): readonly string[] =>
  ["", ...project.folders].flatMap((folder) => {
    const prefix = folder === "" ? "" : `${folder}/`
    const file = project.files.find(
      (path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"),
    )
    return file === undefined ? [] : [file]
  })
