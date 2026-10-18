import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { maxUploadBytes } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import type { Resources } from "../testing/resources.js"
import { safeName, Uploads } from "./uploads.js"

const folder = async (resources: Resources) => {
  const directory = await mkdtemp(join(tmpdir(), "novadeck-uploads-test-"))
  resources.defer(() => rm(directory, { recursive: true, force: true }))
  return join(directory, "uploads")
}

const base64 = (text: string) => Buffer.from(text).toString("base64")

describe("an upload's name", () => {
  it("keeps the file's own name", () => {
    expect(safeName("Screenshot 2026-10-04 at 12.00.png")).toBe(
      "Screenshot 2026-10-04 at 12.00.png",
    )
  })

  it("keeps only the last segment of a path, of either platform", () => {
    expect(safeName("../../.bashrc")).toBe(".bashrc")
    expect(safeName("C:\\Users\\me\\shot.png")).toBe("shot.png")
  })

  it("replaces what a platform refuses in a name", () => {
    expect(safeName('a:b*c?"d|e<f>.png')).toBe("a_b_c__d_e_f_.png")
    expect(safeName("line\nbreak.png")).toBe("line_break.png")
    expect(safeName("del\u007fete\u0085.png")).toBe("del_ete_.png")
  })

  it("replaces whatever a shell of any platform would act on", () => {
    expect(safeName("x&calc&y.png")).toBe("x_calc_y.png")
    expect(safeName("$(calc).png")).toBe("__calc_.png")
    expect(safeName("`id`;'q'.png")).toBe("_id___q_.png")
    expect(safeName("%PATH%!x!^.png")).toBe("_PATH__x__.png")
  })

  it("keeps letters and digits of any script", () => {
    expect(safeName("スクリーンショット 1.png")).toBe("スクリーンショット 1.png")
    expect(safeName("cafe\u0301.png")).toBe("café.png")
    expect(safeName("हिंदी.png")).toBe("हिंदी.png")
  })

  it("replaces the modifier letters and stray diacritics a code page may turn into quotes", () => {
    expect(safeName("a\u02ba b\u02ba.png")).toBe("a_ b_.png")
    expect(safeName("a\u030eb.png")).toBe("a_b.png")
  })

  it("puts a `_` before a name Windows keeps for a device", () => {
    expect(safeName("CON")).toBe("_CON")
    expect(safeName("nul.png")).toBe("_nul.png")
    expect(safeName("com1.txt")).toBe("_com1.txt")
    expect(safeName("console.png")).toBe("console.png")
  })

  it("is cut to what a file system takes, keeping its extension", () => {
    const name = safeName(`${"画".repeat(120)}.png`)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255)
    expect(name).toBe(`${"画".repeat(83)}.png`)
  })

  it("falls back to upload where nothing usable is left", () => {
    for (const name of ["", "..", ".", "dir/", "  "]) expect(safeName(name)).toBe("upload")
  })
})

describe("uploads", () => {
  it("saves a file in a folder of its own, readable by the owner only", async ({ resources }) => {
    const root = await folder(resources)
    const uploads = new Uploads(root)
    const path = await uploads.save({ name: "shot.png", data: base64("PNG") })
    const again = await uploads.save({ name: "shot.png", data: base64("PNG") })
    expect(dirname(dirname(path))).toBe(root)
    expect(path.endsWith("shot.png")).toBe(true)
    expect(again).not.toBe(path)
    await expect(readFile(path, "utf8")).resolves.toBe("PNG")
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    }
  })

  it("adds later parts to the file the first one started", async ({ resources }) => {
    const uploads = new Uploads(await folder(resources))
    const path = await uploads.save({ name: "notes.txt", data: base64("one ") })
    await expect(uploads.save({ path, data: base64("two") })).resolves.toBe(path)
    await expect(readFile(path, "utf8")).resolves.toBe("one two")
  })

  it("refuses a part for a file it isn't receiving", async ({ resources }) => {
    const root = await folder(resources)
    const uploads = new Uploads(root)
    await expect(
      uploads.save({ path: join(root, "elsewhere", "file"), data: base64("x") }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("stops receiving a file whose next part is late", async ({ resources }) => {
    let now = 0
    const uploads = new Uploads(await folder(resources), () => now)
    const path = await uploads.save({ name: "slow.bin", data: base64("a") })
    now += 61_000
    await expect(uploads.save({ path, data: base64("b") })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("removes a file that grows past the limit", async ({ resources }) => {
    const uploads = new Uploads(await folder(resources))
    const path = await uploads.save({ name: "big.bin", data: base64("x") })
    const rest = Buffer.alloc(maxUploadBytes).toString("base64")
    await expect(uploads.save({ path, data: rest })).rejects.toMatchObject({
      code: "UPLOAD_TOO_LARGE",
    })
    await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("sweeps away uploads older than a week as the next one starts", async ({ resources }) => {
    const root = await folder(resources)
    const uploads = new Uploads(root)
    const recent = await uploads.save({ name: "recent.png", data: base64("new") })
    const old = "8ba4a381-0d5e-4c4a-9f1e-2b7c3d4e5f60"
    await mkdir(join(root, old))
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await utimes(join(root, old), weekAgo, weekAgo)
    await uploads.save({ name: "next.png", data: base64("next") })
    const kept = await readdir(root)
    expect(kept).not.toContain(old)
    expect(kept).toContain(dirname(recent).slice(root.length + 1))
  })

  it("leaves folders it did not make, however old", async ({ resources }) => {
    const root = await folder(resources)
    const uploads = new Uploads(root)
    const theirs = join(root, "website-assets")
    await mkdir(theirs, { recursive: true })
    await writeFile(join(theirs, "logo.png"), "logo")
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await utimes(theirs, monthAgo, monthAgo)
    await uploads.save({ name: "next.png", data: base64("next") })
    await expect(readFile(join(theirs, "logo.png"), "utf8")).resolves.toBe("logo")
  })

  it("saves where it keeps uploads even after that folder was removed", async ({ resources }) => {
    const root = await folder(resources)
    const uploads = new Uploads(root)
    await uploads.save({ name: "first.png", data: base64("1") })
    await rm(root, { recursive: true })
    const path = await uploads.save({ name: "second.png", data: base64("2") })
    await expect(readFile(path, "utf8")).resolves.toBe("2")
  })

  it("saves in a temporary folder of its own without one given", async () => {
    const uploads = new Uploads(undefined)
    const path = await uploads.save({ name: "shot.png", data: base64("PNG") })
    try {
      expect(path.startsWith(join(tmpdir(), "novadeck-uploads-"))).toBe(true)
    } finally {
      await rm(dirname(dirname(path)), { recursive: true, force: true })
    }
  })
})
