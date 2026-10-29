import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

import { afterEach, describe as context, describe, expect, it } from "vitest"

import { archiveName, type Entry, manifest, pack, publish, readStaging } from "./archive.ts"
import { sha256 } from "./host.ts"

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

const server: Entry = { name: "whisper-server", executable: true, data: text("server") }
const library: Entry = { name: "libggml.so.1", executable: false, data: text("library") }
const soname: Entry = { name: "libggml.so", link: "libggml.so.1" }

const folders: string[] = []
const folder = (): string => {
  const path = mkdtempSync(join(tmpdir(), "ggml-build-"))
  folders.push(path)
  return path
}

afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

// The 512-byte ustar header at `offset` in the uncompressed archive.
const header = (archive: Buffer, offset: number) => {
  const tarball = gunzipSync(archive)
  const read = (start: number, length: number) =>
    tarball.toString("latin1", offset + start, offset + start + length).replace(/\0.*$/s, "")
  return { name: read(0, 100), mode: read(100, 8), type: read(156, 1), link: read(157, 100) }
}

describe("the engine archive", () => {
  it("is named for the platform and architecture, universal on macOS", () => {
    expect(archiveName("whisper", "linux", "x64")).toBe("novadeck-whisper-linux-x64.tar.gz")
    expect(archiveName("murmur", "win32", "arm64")).toBe("novadeck-murmur-win32-arm64.tar.gz")
    expect(archiveName("whisper", "darwin", "arm64")).toBe(
      "novadeck-whisper-darwin-universal.tar.gz",
    )
  })

  it("is the same bytes for the same files in any order", () => {
    expect(pack([soname, server, library]).equals(pack([library, soname, server]))).toBe(true)
  })

  it("carries no time and names Unix in its gzip header", () => {
    const archive = pack([server])
    expect(archive.readUInt32LE(4)).toBe(0)
    expect(archive[9]).toBe(3)
  })

  it("sorts its entries by name and gives executables and links their modes", () => {
    const archive = pack([server, library, soname])
    expect(header(archive, 0)).toEqual({
      name: "libggml.so",
      mode: "0000777",
      type: "2",
      link: "libggml.so.1",
    })
    expect(header(archive, 512)).toMatchObject({
      name: "libggml.so.1",
      mode: "0000644",
      type: "0",
    })
    expect(header(archive, 1536)).toMatchObject({
      name: "whisper-server",
      mode: "0000755",
      type: "0",
    })
  })

  it("refuses a name longer than ustar holds", () => {
    expect(() => pack([{ ...server, name: "x".repeat(101) }])).toThrow(/too long for the archive/)
  })

  it("extracts with the system tar", () => {
    const into = folder()
    writeFileSync(join(into, "engine.tar.gz"), pack([server, library]))
    const result = spawnSync("tar", ["-xzf", "engine.tar.gz"], { cwd: into })
    expect(result.status).toBe(0)
    expect(readFileSync(join(into, "whisper-server"), "utf8")).toBe("server")
    expect(readFileSync(join(into, "libggml.so.1"), "utf8")).toBe("library")
  })

  context.skipIf(process.platform === "win32")("read from a staging folder", () => {
    it("keeps links as links and marks what can run", async () => {
      const staging = folder()
      writeFileSync(join(staging, "whisper-server"), "server", { mode: 0o755 })
      writeFileSync(join(staging, "libggml.so.1"), "library", { mode: 0o644 })
      symlinkSync("libggml.so.1", join(staging, "libggml.so"))
      const entries = await readStaging(staging)
      expect(entries.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
        soname,
        {
          name: "libggml.so.1",
          executable: false,
          data: readFileSync(join(staging, "libggml.so.1")),
        },
        {
          name: "whisper-server",
          executable: true,
          data: readFileSync(join(staging, "whisper-server")),
        },
      ])
    })
  })
})

describe("publishing the engine", () => {
  it("names the archive with its checksum, size and interface", () => {
    const data = pack([server])
    expect(manifest("novadeck-whisper-linux-x64.tar.gz", data, 3)).toEqual({
      file: "novadeck-whisper-linux-x64.tar.gz",
      sha256: sha256(data),
      size: data.length,
      interface: 3,
    })
  })

  it("writes the archive and engine.json into dist, creating it", async () => {
    const dist = join(folder(), "dist")
    const data = pack([server])
    await publish(dist, "novadeck-whisper-linux-x64.tar.gz", data, 1)
    expect(readFileSync(join(dist, "novadeck-whisper-linux-x64.tar.gz")).equals(data)).toBe(true)
    expect(JSON.parse(readFileSync(join(dist, "engine.json"), "utf8"))).toEqual(
      manifest("novadeck-whisper-linux-x64.tar.gz", data, 1),
    )
  })
})
