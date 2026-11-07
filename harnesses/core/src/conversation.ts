import { readdir, stat } from "node:fs/promises"
import { posix, win32 } from "node:path"

import type { Install } from "./harness.js"

/**
 * Whether a conversation can still be found in a harness's files: `gone` only where its
 * file is missing and the folder that would hold it is there, `unknown` for anything else
 * (a folder that isn't there, a permission error), which leaves the conversation to the
 * resume itself to settle.
 */
export type Conversation = "found" | "gone" | "unknown"

/** What `stat` says of a path; a name in the way (ENOTDIR) is as missing as one not there. */
export type Presence = "present" | "absent" | "unreadable"

/** A session id as a file name: no separator, nothing that reaches out of the folder. */
export const sessionName = /^[0-9A-Za-z][0-9A-Za-z-]{7,79}$/

/** The path rules of the install's platform, whatever machine this runs on. */
export const rulesOf = (install: Pick<Install, "platform">): typeof posix =>
  install.platform === "win32" ? win32 : posix

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

/** The names in a folder, or why there are none: `absent` for a folder not there. */
export const names = async (
  folder: string,
): Promise<readonly string[] | "absent" | "unreadable"> => {
  try {
    return await readdir(folder)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable"
  }
}

/**
 * The answer for a conversation kept as one file in a folder that is there: `found`, `gone`
 * when the file is missing, or `unknown` where the folder or the file can't be told.
 */
export const fileIn = async (folder: string, file: string): Promise<Conversation> => {
  const seen = await presence(file)
  if (seen === "present") return "found"
  if (seen === "unreadable") return "unknown"
  return (await presence(folder)) === "present" ? "gone" : "unknown"
}
