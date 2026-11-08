import { readdir, stat } from "node:fs/promises"
import { posix, win32 } from "node:path"

import type { Install } from "./harness.js"
import { beside } from "./paths.js"

/**
 * Whether a conversation can still be found in a harness's files: `gone` only where its
 * file is missing and a real folder that would hold it is there, `unknown` for anything
 * else (a folder that isn't there or isn't one, a permission error), which leaves the
 * conversation to the resume itself to settle.
 */
export type Conversation = "found" | "gone" | "unknown"

/** What the runner saw of a session when it bound, which says where its files are. */
export type Known = {
  /** The transcript path its hooks named. */
  readonly transcript?: string | undefined
}

/**
 * Checks for conversations over one pass through a list: each folder it reads is read once
 * and shared by every row, so a long list costs a listing per folder, not per row. Make
 * one per pass; it keeps what it read.
 */
export type ConversationScan = {
  readonly conversation: (sessionId: string, known?: Known) => Promise<Conversation>
}

/** A session id as a file name: no separator, nothing that reaches out of the folder. */
export const sessionName = /^[0-9A-Za-z][0-9A-Za-z-]{7,79}$/

/** The path rules of the install's platform, whatever machine this runs on. */
export const rulesOf = (install: Pick<Install, "platform">): typeof posix =>
  install.platform === "win32" ? win32 : posix

/** What `stat` says of a path; a name in the way (ENOTDIR) is as missing as one not there. */
export type Presence = "present" | "absent" | "unreadable"

/** Whether `path` is there, by `stat` alone: `existsSync` reads a permission error as missing. */
export const presence = async (path: string): Promise<Presence> => {
  try {
    await stat(path)
    return "present"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable"
  }
}

/** Whether `path` is a folder (following links): a folder not there is `absent`, a file `file`. */
export const folderState = async (
  path: string,
): Promise<"folder" | "file" | "absent" | "unreadable"> => {
  try {
    return (await stat(path)).isDirectory() ? "folder" : "file"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable"
  }
}

/** A folder as `readdir` finds it. */
export type Listing =
  | { readonly kind: "names"; readonly names: readonly string[] }
  | { readonly kind: "missing" | "file" | "unreadable" }

// How many folders are read at once: the pool is small and a long list must not queue
// thousands of reads at the event loop.
const reading = 32

/** A reader of folders that reads each once, at most `reading` at a time, and keeps what it read. */
export const lister = (): ((folder: string) => Promise<Listing>) => {
  const kept = new Map<string, Promise<Listing>>()
  const waiting: (() => void)[] = []
  let active = 0
  const turn = async () => {
    if (active >= reading) await new Promise<void>((go) => waiting.push(go))
    active += 1
  }
  const release = () => {
    active -= 1
    waiting.shift()?.()
  }
  const read = async (folder: string): Promise<Listing> => {
    await turn()
    try {
      return { kind: "names", names: await readdir(folder) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return { kind: "missing" }
      return { kind: code === "ENOTDIR" ? "file" : "unreadable" }
    } finally {
      release()
    }
  }
  return (folder) => {
    let found = kept.get(folder)
    if (!found) {
      found = read(folder)
      kept.set(folder, found)
    }
    return found
  }
}

/**
 * The answer for a conversation kept as one file in a folder: `found`, `gone` when the file
 * is missing from a folder that is there, `unknown` where the folder is not one or either
 * can't be told.
 */
export const fileIn = async (folder: string, file: string): Promise<Conversation> => {
  const seen = await presence(file)
  if (seen === "present") return "found"
  if (seen === "unreadable") return "unknown"
  return (await folderState(folder)) === "folder" ? "gone" : "unknown"
}

// What `reportedOr` found away from a reported path, by that path and session, for the
// runner's life: a file a harness writes stays where it is. Bounded, oldest out first.
const foundAway = new Map<string, string>()
const foundAwayCap = 256

/**
 * The transcript a session's hooks reported, unless that path holds no file and `find`
 * finds the session's own file elsewhere in its harness's store: Claude Code resumed in
 * another folder than it began in reports a path under that folder's project, and goes on
 * writing the file where the session began. Where neither is there, the reported path, as
 * a new session creates its file only after its first hooks. One `stat`, and `find`'s own
 * reads only while the reported file is missing and nothing was found for it before.
 */
export const reportedOr = async (
  reported: string,
  sessionId: string,
  find: () => Promise<string | undefined>,
): Promise<string> => {
  // The reported file first: one written there since is the one the harness writes now.
  if ((await presence(reported)) !== "absent") return reported
  const key = `${reported}\0${sessionId}`
  const kept = foundAway.get(key)
  if (kept !== undefined) return kept
  const found = await find().catch(() => undefined)
  if (found === undefined || found === reported) return reported
  const oldest = foundAway.size >= foundAwayCap ? foundAway.keys().next() : undefined
  if (oldest && !oldest.done) foundAway.delete(oldest.value)
  foundAway.set(key, found)
  return found
}

/** The home a transcript path names, above the folder `marker` it sits under; none if it sits under none. */
export const homeOfTranscript = (
  transcript: string | undefined,
  marker: string,
): string | undefined => (transcript === undefined ? undefined : beside(transcript, marker, ".")[0])
