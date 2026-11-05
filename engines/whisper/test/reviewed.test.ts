import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { blobId, patchedFile, requireReviewedFile } from "../scripts/reviewed.ts"

const encode = (text: string) => new TextEncoder().encode(text)

const patchOf = (path: string, after: string) =>
  `diff --git a/${path} b/${path}\nindex 1234567..${after} 100644\n--- a/${path}\n+++ b/${path}\n`

describe("a file's blob id", () => {
  it("is the one git gives it", () => {
    // `git hash-object` of an empty file and of "hello\n".
    expect(blobId(encode(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
    expect(blobId(encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a")
  })
})

describe("the file a patch changes", () => {
  it("is read from the encoder patch, with the whisper.cpp it was reviewed against", async () => {
    const patch = await readFile(
      fileURLToPath(new URL("../patches/reuse-language-encode.patch", import.meta.url)),
      "utf8",
    )
    expect(patchedFile(patch)).toEqual({ path: "src/whisper.cpp", after: "a375357" })
  })

  it("must be one file", () => {
    const two = `${patchOf("a.cpp", "abcdef0")}${patchOf("b.cpp", "abcdef1")}`
    expect(() => patchedFile(two)).toThrow(/one file/)
  })

  it("must be named by an index line", () => {
    expect(() => patchedFile("diff --git a/a.cpp b/a.cpp\n--- a/a.cpp\n")).toThrow(/index line/)
  })
})

describe("the reviewed file check", () => {
  let folder = ""
  afterEach(() => rm(folder, { recursive: true, force: true }))

  const prepare = async (contents: string, after: string) => {
    folder = await mkdtemp(join(tmpdir(), "whisper-reviewed-"))
    await mkdir(join(folder, "source", "src"), { recursive: true })
    await writeFile(join(folder, "source", "src", "x.cpp"), contents)
    await writeFile(join(folder, "x.patch"), patchOf("src/x.cpp", after))
    return { source: join(folder, "source"), patch: join(folder, "x.patch") }
  }

  it("passes the file the patch was cut against", async () => {
    const { source, patch } = await prepare("int x;\n", blobId(encode("int x;\n")).slice(0, 7))
    await expect(requireReviewedFile(source, patch, "Re-check it.")).resolves.toBeUndefined()
  })

  it("passes it with the CRLF line endings a Windows git may write", async () => {
    const { source, patch } = await prepare("int x;\r\n", blobId(encode("int x;\n")).slice(0, 7))
    await expect(requireReviewedFile(source, patch, "Re-check it.")).resolves.toBeUndefined()
  })

  it("passes bytes that are not UTF-8 as they are", async () => {
    folder = await mkdtemp(join(tmpdir(), "whisper-reviewed-"))
    const bytes = new Uint8Array([0xff, 0x0a])
    await mkdir(join(folder, "source"), { recursive: true })
    await writeFile(join(folder, "source", "x.bin"), bytes)
    await writeFile(join(folder, "x.patch"), patchOf("x.bin", blobId(bytes).slice(0, 7)))
    await expect(
      requireReviewedFile(join(folder, "source"), join(folder, "x.patch"), "Re-check it."),
    ).resolves.toBeUndefined()
  })

  it("fails a file that changed upstream, and says what to re-check", async () => {
    const { source, patch } = await prepare("int y;\n", blobId(encode("int x;\n")).slice(0, 7))
    await expect(requireReviewedFile(source, patch, "Re-check it.")).rejects.toThrow(
      /^src\/x\.cpp is not the file x\.patch was reviewed against \(.+\)\. Re-check it\.$/,
    )
  })
})
