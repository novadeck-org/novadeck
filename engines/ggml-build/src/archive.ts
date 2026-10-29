import { lstatSync, readFileSync, readlinkSync } from "node:fs"
import { mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

import { replaceFile, sha256 } from "./host.ts"

// The archive is flat, so the runner can unpack it with the system `tar` and run the server
// where it stands. It is written here, not by whichever tar the computer has, so the same
// files make the same bytes on every run and every platform: entries sorted, no
// timestamps, owner and group 0, and a gzip header with no time and the Unix operating
// system. bsdtar and GNU tar extract it.

/** A staged file, or a link that keeps its target. */
export type Entry =
  | { readonly name: string; readonly executable: boolean; readonly data: Uint8Array }
  | { readonly name: string; readonly link: string }

/** The engine's archive for this platform: macOS builds one universal binary. */
export const archiveName = (name: string, platform: NodeJS.Platform, arch: string): string =>
  `novadeck-${name}-${platform}-${platform === "darwin" ? "universal" : arch}.tar.gz`

/** The staged files as the archive holds them. */
export const readStaging = async (staging: string): Promise<Entry[]> =>
  (await readdir(staging)).map((name) => {
    const path = join(staging, name)
    const stat = lstatSync(path)
    return stat.isSymbolicLink()
      ? { name, link: readlinkSync(path) }
      : { name, executable: (stat.mode & 0o111) !== 0, data: readFileSync(path) }
  })

const block = 512

const field = (header: Buffer, offset: number, length: number, value: string): void => {
  header.write(value, offset, length, "latin1")
}

const octal = (header: Buffer, offset: number, length: number, value: number): void => {
  field(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`)
}

// One ustar entry, with the owner, group and time every build gives it. Staged names are
// flat and short.
const record = (entry: Entry): Uint8Array[] => {
  if (Buffer.byteLength(entry.name) > 100) {
    throw new Error(`${entry.name} is too long for the archive.`)
  }
  const link = "link" in entry
  const data = link ? new Uint8Array(0) : entry.data
  const header = Buffer.alloc(block)
  field(header, 0, 100, entry.name)
  octal(header, 100, 8, link ? 0o777 : entry.executable ? 0o755 : 0o644)
  octal(header, 108, 8, 0)
  octal(header, 116, 8, 0)
  octal(header, 124, 12, data.length)
  octal(header, 136, 12, 0)
  header.fill(" ", 148, 156)
  field(header, 156, 1, link ? "2" : "0")
  if (link) field(header, 157, 100, entry.link)
  field(header, 257, 6, "ustar\0")
  field(header, 263, 2, "00")
  const sum = header.reduce((total, byte) => total + byte, 0)
  field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  const padding = Buffer.alloc((block - (data.length % block)) % block)
  return [header, data, padding]
}

const byName = (a: Entry, b: Entry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** The gzipped tarball of the entries, the same bytes for the same entries in any order. */
export const pack = (entries: readonly Entry[]): Buffer => {
  const records = entries.toSorted(byName).flatMap(record)
  const gzipped = gzipSync(Buffer.concat([...records, Buffer.alloc(block * 2)]), { level: 9 })
  gzipped.writeUInt32LE(0, 4)
  gzipped[9] = 3
  return gzipped
}

/** The manifest the runner reads to fetch and check the archive. */
export const manifest = (
  archive: string,
  data: Uint8Array,
  engineInterface: number,
): { file: string; sha256: string; size: number; interface: number } => ({
  file: archive,
  sha256: sha256(data),
  size: data.length,
  interface: engineInterface,
})

/**
 * Writes the archive and its `engine.json` into `dist`, each replaced whole and the manifest
 * last, so a runner reading meanwhile sees the old engine or the new one and never a
 * manifest without its archive.
 */
export const publish = async (
  dist: string,
  archive: string,
  data: Uint8Array,
  engineInterface: number,
): Promise<void> => {
  await mkdir(dist, { recursive: true })
  const written = manifest(archive, data, engineInterface)
  await replaceFile(join(dist, archive), data)
  await replaceFile(join(dist, "engine.json"), `${JSON.stringify(written, null, 2)}\n`)
  console.log(`Built ${archive} (${data.length} bytes, sha256 ${written.sha256})`)
}
