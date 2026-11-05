import { crc32, inflateRawSync } from "node:zlib"

// Reads a ZIP archive held in memory, which is what a NuGet package is. The signing tools are
// unpacked from the very bytes whose checksum was just checked, so no other program reads
// the archive between the check and the unpacking. It reads what the pinned packages use:
// stored and deflated files, no ZIP64 and no encryption.

const endOfDirectory = 0x06054b50
const directoryEntry = 0x02014b50
const localEntry = 0x04034b50

/** The files of the ZIP archive under `folder`, by their paths inside that folder. */
export const unzip = (archive: Uint8Array, folder: string): Map<string, Buffer> => {
  const data = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  // The directory's end record closes the archive, before a comment of at most 65535 bytes.
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end === -1 || data.readUInt32LE(end) !== endOfDirectory || end + 22 > data.length) {
    throw new Error("The archive is not a ZIP file.")
  }
  const count = data.readUInt16LE(end + 10)
  let offset = data.readUInt32LE(end + 16)
  if (count === 0xffff || offset === 0xffffffff) throw new Error("The archive is a ZIP64 file.")

  const prefix = `${folder}/`
  const files = new Map<string, Buffer>()
  for (let entry = 0; entry < count; entry += 1) {
    if (data.readUInt32LE(offset) !== directoryEntry) {
      throw new Error("The ZIP file's directory is cut short.")
    }
    const flags = data.readUInt16LE(offset + 8)
    const method = data.readUInt16LE(offset + 10)
    const checksum = data.readUInt32LE(offset + 16)
    const packed = data.readUInt32LE(offset + 20)
    const size = data.readUInt32LE(offset + 24)
    const nameLength = data.readUInt16LE(offset + 28)
    const local = data.readUInt32LE(offset + 42)
    const name = data.toString("utf8", offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32)
    if (!name.startsWith(prefix) || name.endsWith("/")) continue

    const inside = name.slice(prefix.length)
    if (inside.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`The ZIP file names a path that leaves its folder: ${name}`)
    }
    if (flags & 1) throw new Error(`${name} is encrypted.`)
    if (data.readUInt32LE(local) !== localEntry) throw new Error(`${name} has no file header.`)
    // The local header repeats the name and has extra fields of its own length.
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
    const stored = data.subarray(start, start + packed)
    if (method !== 0 && method !== 8) throw new Error(`${name} is packed in an unknown way.`)
    const file = method === 0 ? Buffer.from(stored) : inflateRawSync(stored)
    if (file.length !== size || crc32(file) !== checksum) {
      throw new Error(`${name} does not match the ZIP file's record of it.`)
    }
    files.set(inside, file)
  }
  return files
}
