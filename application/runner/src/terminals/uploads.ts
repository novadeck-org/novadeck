import { randomUUID } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { maxUploadBytes } from "@novadeck/protocol"

import { DomainError } from "../errors.js"

// How long an upload stays before a later one sweeps it away: a pasted file is read
// within moments, but a prompt may wait a while before it is sent.
const keepMs = 7 * 24 * 60 * 60 * 1000
// How long a file being received waits for its next part.
const partMs = 60_000
// The folders the runner makes, one per upload: only these are ever swept away.
const ownFolder = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Names Windows keeps for devices, which no file can take, with or without an extension.
const device = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

// The longest name a file system takes, in UTF-8 bytes.
const maxNameBytes = 255

/** A name cut to `maxNameBytes`, keeping its extension. */
const fitted = (name: string): string => {
  if (Buffer.byteLength(name) <= maxNameBytes) return name
  const extension = /\.[^.]{1,32}$/.exec(name)?.[0] ?? ""
  const stem = Array.from(name.slice(0, name.length - extension.length))
  while (stem.length > 0 && Buffer.byteLength(stem.join("") + extension) > maxNameBytes) stem.pop()
  return (stem.join("") || "upload") + extension
}

/**
 * A file name safe to save under and to paste into any shell: its last segment, with
 * every character but letters (with their marks), digits, `.`, `_`, `-` and spaces replaced
 * by `_`, cut to what a file system takes, or `upload` where nothing usable is left. A
 * name Windows keeps for a device gets a `_` before it.
 */
export const safeName = (name: string): string => {
  const last = name.normalize("NFC").split(/[/\\]/).pop() ?? ""
  const clean = last.replace(/[^\p{L}\p{M}\p{N}._\- ]/gu, "_").trim()
  if (/^\.*$/.test(clean)) return "upload"
  return fitted(device.test(clean) ? `_${clean}` : clean)
}

type Part = { name?: string | undefined; path?: string | undefined; data: string }

/**
 * Files pasted into terminals, each saved in a folder of its own under `folder`,
 * or under a fresh temporary folder without one, readable by the runner's owner only.
 * Starting a file sweeps away uploads older than a week.
 */
export class Uploads {
  private root: Promise<string> | undefined
  /** Files being received, by path: their size so far and when their last part came. */
  private readonly receiving = new Map<string, { size: number; at: number }>()

  constructor(
    private readonly folder: string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Saves a part, starting a file with `name` or adding to the one at `path`; answers its path. */
  async save(part: Part): Promise<string> {
    const bytes = Buffer.from(part.data, "base64")
    if (part.path !== undefined) return this.add(part.path, bytes)
    if (bytes.length > maxUploadBytes) throw new DomainError("UPLOAD_TOO_LARGE")
    const root = await this.ready()
    await this.sweep(root)
    const path = join(root, randomUUID(), safeName(part.name ?? ""))
    try {
      // Recursive, so a root removed meanwhile, as by a temporary-file cleaner, returns.
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" })
    } catch (error) {
      await rm(dirname(path), { recursive: true, force: true })
      throw error
    }
    this.receiving.set(path, { size: bytes.length, at: this.now() })
    return path
  }

  private async add(path: string, bytes: Buffer): Promise<string> {
    const file = this.receiving.get(path)
    if (!file || this.now() - file.at > partMs) {
      this.receiving.delete(path)
      throw new DomainError("NOT_FOUND", "No upload is being received at that path.")
    }
    const size = file.size + bytes.length
    if (size > maxUploadBytes) {
      this.receiving.delete(path)
      await rm(dirname(path), { recursive: true, force: true })
      throw new DomainError("UPLOAD_TOO_LARGE")
    }
    this.receiving.set(path, { size, at: this.now() })
    await appendFile(path, bytes)
    return path
  }

  private ready(): Promise<string> {
    const folder = this.folder
    this.root ??= (
      folder === undefined
        ? mkdtemp(join(tmpdir(), "novadeck-uploads-"))
        : mkdir(folder, { recursive: true, mode: 0o700 }).then(() => folder)
    ).catch((error: unknown) => {
      // The next upload tries again.
      this.root = undefined
      throw error
    })
    return this.root
  }

  /**
   * Removes uploads older than a week, and forgets files whose parts stopped coming. Only
   * the folders it made go: the uploads folder may sit beside a database anywhere.
   */
  private async sweep(root: string): Promise<void> {
    const now = this.now()
    for (const [path, file] of this.receiving)
      if (now - file.at > partMs) this.receiving.delete(path)
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && ownFolder.test(entry.name))
        .map(async (entry) => {
          const folder = join(root, entry.name)
          const { mtimeMs } = await stat(folder).catch(() => ({ mtimeMs: now }))
          if (now - mtimeMs > keepMs)
            await rm(folder, { recursive: true, force: true }).catch(() => {})
        }),
    )
  }
}
