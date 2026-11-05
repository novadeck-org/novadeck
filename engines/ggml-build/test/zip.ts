import { crc32, deflateRawSync } from "node:zlib"

/** A file for `zipOf`: its path, its text, and whether it is deflated rather than stored. */
export type Zipped = readonly [name: string, text: string, deflated?: boolean]

/** A ZIP archive of the files, as a NuGet package is one, for the tests of what reads them. */
export const zipOf = (files: readonly Zipped[]): Buffer => {
  const locals: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const [name, text, deflated = false] of files) {
    const data = Buffer.from(text)
    const packed = deflated ? deflateRawSync(data) : data
    const path = Buffer.from(name)
    // What the local header and the directory's entry share, from the version on.
    const shared = Buffer.alloc(26)
    shared.writeUInt16LE(20, 0)
    shared.writeUInt16LE(deflated ? 8 : 0, 4)
    shared.writeUInt32LE(crc32(data), 10)
    shared.writeUInt32LE(packed.length, 14)
    shared.writeUInt32LE(data.length, 18)
    shared.writeUInt16LE(path.length, 22)
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), shared, path, packed])
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    shared.copy(entry, 6)
    entry.writeUInt32LE(offset, 42)
    locals.push(local)
    directory.push(entry, path)
    offset += local.length
  }
  const entries = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(entries.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, entries, end])
}
