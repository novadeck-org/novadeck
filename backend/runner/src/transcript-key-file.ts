// A standalone runner's transcript key: a file, as a server has no keychain to wrap one. The
// file holds the base64 of 32 bytes, as `openssl rand -base64 32` prints (URL-safe or unpadded
// too), and is made at
// 0600 where it is missing. It keeps transcripts out of the database file alone (a copy
// attached to a report, a backup of just the database) and from the machine's other users; not
// from root, the runner's own user, or a copy of the whole data folder. A key kept encrypted
// at rest is a path away: a systemd credential (`$CREDENTIALS_DIRECTORY/…`) or a Docker secret.
// The desktop app keeps its key behind the system's keychain instead (apps/desktop's
// transcript-key.ts).
import { randomBytes, randomUUID } from "node:crypto"
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"

import type { Log } from "@novadeck/log"

const keyBytes = 32

type Files = {
  readFile(path: string): Promise<Buffer>
  /**
   * Puts a new file holding `data` at `path` whole, failing with EEXIST where one is: written
   * beside it and linked into place, so no reader, nor a crash, finds it half written.
   */
  create(path: string, data: string, mode: number): Promise<void>
  mode(path: string): Promise<number>
}

/** Writes `data` to a new file at `path`, flushed to disk; EEXIST where one is. */
const writeNew = async (path: string, data: string, mode: number): Promise<void> => {
  const handle = await open(path, "wx", mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Puts `data` at `path` whole, as `Files.create` says; `linkFile` is `link` but for tests of a
 * volume without hard links.
 */
export const createWhole = async (
  path: string,
  data: string,
  mode: number,
  linkFile: (from: string, to: string) => Promise<void> = link,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeNew(temporary, data, mode)
    try {
      await linkFile(temporary, path)
    } catch (error) {
      // A volume without hard links (FAT, some network or FUSE mounts): written in place,
      // still only where no file is.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS")
        throw error
      await writeNew(path, data, mode)
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

const files: Files = {
  readFile: (path) => readFile(path),
  create: (path, data, mode) => createWhole(path, data, mode),
  mode: async (path) => (await stat(path)).mode,
}

/**
 * The key in `text`, or null where it is not the base64 of 32 bytes: standard or URL-safe,
 * padded or not, with space around it, as secret stores write it.
 */
const keyIn = (text: string): Uint8Array | null => {
  const trimmed = text.trim()
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(trimmed)) return null
  const key = Buffer.from(trimmed.replaceAll("-", "+").replaceAll("_", "/"), "base64")
  return key.length === keyBytes ? key : null
}

/**
 * The key in `path`, made there where the file is missing; null where none can be had:
 * the file is unreadable, or holds no key, which is left as it is, as it may be the key every
 * saved transcript needs, or a path given wrong. A file other users can read is still used,
 * with a warning, as a Docker secret usually is. The key is never logged.
 */
export const loadTranscriptKeyFile = async (
  host: { readonly path: string; readonly platform: NodeJS.Platform; readonly log: Log },
  io: Files = files,
): Promise<Uint8Array | null> => {
  const { path, platform, log } = host
  const read = async (): Promise<Uint8Array | null> => {
    const key = keyIn((await io.readFile(path)).toString("utf8"))
    if (!key) {
      log.warn(
        "transcript-key.invalid",
        "Transcripts are not kept: the key file holds no key, and is left as it is.",
        { data: { path } },
      )
      return null
    }
    // Windows keeps no such mode: the file has its folder's access, the user's own.
    if (platform !== "win32" && ((await io.mode(path).catch(() => 0)) & 0o077) !== 0)
      log.warn("transcript-key.shared", "Other users can read the transcript key file.", {
        data: { path },
      })
    log.info("transcript-key.loaded", "The transcript key was loaded.", { data: { path } })
    return key
  }
  try {
    try {
      return await read()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    try {
      await io.create(path, `${randomBytes(keyBytes).toString("base64")}\n`, 0o600)
      log.info("transcript-key.created", "A new transcript key was made.", { data: { path } })
    } catch (error) {
      // Another runner made it meanwhile: its key is the one.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    return await read()
  } catch (error) {
    log.warn("transcript-key.unavailable", "Transcripts are not kept: no key could be had.", {
      data: { path },
      err: error,
    })
    return null
  }
}
