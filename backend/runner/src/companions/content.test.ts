import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  closeSync,
  ftruncateSync,
  openSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { companionLimits, itemContent, partBytes, pdfLimits, videoLimits } from "@novadeck/protocol"

import { describe, expect, it as base } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import {
  captureWindow,
  formatOf,
  loadFile,
  loadPlan,
  loadPdf,
  loadPlayed,
  partsOf,
  pageAt,
  planTitle,
  pointAt,
  readPlanFile,
  readTextPlan,
  readPart,
  savePlan as savePlanIn,
} from "./content.js"

// The tests' plans are in temporary folders, where saving is allowed unless a test says otherwise.
const savePlan = (
  item: Parameters<typeof savePlanIn>[0],
  text: string,
  basedOn: string,
  folders: readonly string[] = [tmpdir()],
) => savePlanIn(item, text, basedOn, folders)

const it = base.extend<{ directory: string }>({
  directory: async ({ resources }, use) => {
    // Native, as paths are resolved: on Windows it also expands short names.
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-content-")))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    await use(directory)
  },
})

const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n"

// A 1×1 transparent PNG.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
)

const file = (
  path: string,
  fields: { lines?: { from: number; to: number }; secret?: boolean } = {},
) => ({ kind: "file", path, lines: fields.lines ?? null, secret: fields.secret ?? false }) as const

describe("what a show points at", () => {
  it("is any file, by a path from the terminal's directory, symlinks resolved", async ({
    directory,
  }) => {
    mkdirSync(join(directory, "src"))
    writeFileSync(join(directory, "src", "a.ts"), "const a = 1\n")
    symlinkSync(join(directory, "src", "a.ts"), join(directory, "link.ts"))
    writeFileSync(join(directory, "a.bin"), Buffer.from([0x41, 0x00, 0x42]))
    writeFileSync(join(directory, "dot.PNG"), png)
    writeFileSync(join(directory, ".env"), "TOKEN=x\n")
    const pointed = { ok: true, path: join(directory, "src", "a.ts"), kind: "file", secret: false }
    await expect(pointAt("a.ts", join(directory, "src"))).resolves.toMatchObject(pointed)
    await expect(pointAt("link.ts", directory)).resolves.toMatchObject(pointed)
    // A binary file too: it says so as it loads.
    await expect(pointAt("a.bin", directory)).resolves.toMatchObject({ ok: true, kind: "file" })
    await expect(pointAt("dot.PNG", directory)).resolves.toMatchObject({
      kind: "image",
      size: png.length,
    })
    await expect(pointAt(".env", directory)).resolves.toMatchObject({ ok: true, secret: true })
  })

  it("is a video by its extension, whatever its case", async ({ directory }) => {
    for (const name of ["demo.mp4", "clip.WEBM", "take.mov", "cut.m4v"]) {
      writeFileSync(join(directory, name), "video")
      // eslint-disable-next-line no-await-in-loop -- One file after another.
      await expect(pointAt(name, directory)).resolves.toMatchObject({ ok: true, kind: "video" })
    }
    // One Chromium doesn't play is read as a file, which says it isn't text.
    writeFileSync(join(directory, "old.avi"), "video")
    await expect(pointAt("old.avi", directory)).resolves.toMatchObject({ kind: "file" })
  })

  it("is a recording by its extension, whatever its case", async ({ directory }) => {
    for (const name of ["take.mp3", "voice.M4A", "tone.wav", "mix.ogg", "note.opus", "a.flac"]) {
      writeFileSync(join(directory, name), "sound")
      // eslint-disable-next-line no-await-in-loop -- One file after another.
      await expect(pointAt(name, directory)).resolves.toMatchObject({ ok: true, kind: "audio" })
    }
  })

  it("may hold secrets where the environment it is given says a tool keeps its login", async ({
    directory,
  }) => {
    const moved = join(directory, "accounts", "work")
    mkdirSync(moved, { recursive: true })
    const login = join(moved, "auth.json")
    writeFileSync(login, "{}\n")
    writeFileSync(join(moved, "hosts.yml"), "held\n")
    await expect(pointAt(login, directory, {})).resolves.toMatchObject({ secret: false })
    await expect(pointAt(login, directory, { CODEX_HOME: moved })).resolves.toMatchObject({
      secret: true,
    })
    await expect(
      loadFile(file(join(moved, "hosts.yml")), false, { GH_CONFIG_DIR: moved }),
    ).resolves.toMatchObject({ reason: "secret" })
    // With no variable to say so, what Codex keeps beside its login tells its home.
    writeFileSync(join(moved, "config.toml"), "")
    await expect(pointAt(login, directory, {})).resolves.toMatchObject({ secret: true })
    await expect(loadFile(file(login), false, {})).resolves.toMatchObject({ reason: "secret" })
  })

  it("is never a missing path, a folder, or a pipe", async ({ directory }) => {
    await expect(pointAt("gone.txt", directory)).resolves.toEqual({
      ok: false,
      reason: "That file doesn't exist.",
    })
    await expect(pointAt(".", directory)).resolves.toEqual({
      ok: false,
      reason: "That's a folder; only files can be shown.",
    })
    if (process.platform === "win32") return
    expect(spawnSync("mkfifo", [join(directory, "pipe")]).status).toBe(0)
    await expect(pointAt("pipe", directory)).resolves.toEqual({
      ok: false,
      reason: "Only files can be shown, not a pipe or a device.",
    })
  })

  it("is any http or https page, but no other scheme, credentials, or an overlong address", () => {
    expect(pageAt("http://localhost:5173/app?x=1#top")).toMatchObject({ ok: true })
    expect(pageAt("file:///etc/passwd")).toEqual({
      ok: false,
      reason: "Novadeck shows only http and https pages.",
    })
    expect(pageAt("javascript:alert(1)")).toMatchObject({ ok: false })
    expect(pageAt("https://me:secret@example.com/")).toEqual({
      ok: false,
      reason: "Novadeck won't show an address with a user name or password in it.",
    })
    expect(pageAt("not an address")).toEqual({ ok: false, reason: "That isn't a valid address." })
    // Each ł takes six characters once encoded.
    expect(pageAt(`https://example.com/?q=${"ł".repeat(1500)}`)).toEqual({
      ok: false,
      reason: "That address is too long.",
    })
  })
})

// A numbered line, padded to 99 characters.
const padded = (line: number) => `line ${line}`.padEnd(99, ".")

describe("a long line as it loads", () => {
  // A line is kept to the protocol's limit; the file is read 64 KiB at a time.
  const limit = companionLimits.lineLength
  const chunk = 64 * 1024
  const linesOf = async (directory: string, text: string) => {
    const path = join(directory, "long.txt")
    writeFileSync(path, text)
    const loaded = await loadFile(file(path), false)
    if (loaded.state !== "ready" || loaded.content.kind !== "file") throw new Error("not loaded")
    return loaded.content.lines
  }

  it("is cut to exactly the limit when no emoji is at it", async ({ directory }) => {
    const lines = await linesOf(directory, `${"a".repeat(limit + 50)}\nnext`)
    expect(lines).toEqual(["a".repeat(limit), "next"])
  })

  it("leaves no half of an emoji at the limit, in one chunk or across two", async ({
    directory,
  }) => {
    // The emoji's pair spans the limit's last unit and the one past it, so the limit falls
    // between its halves.
    const kept = "a".repeat(limit - 1)
    const long = `${kept}😀 and more\nnext`
    expect(await linesOf(directory, long)).toEqual([kept, "next"])
    // The line opens in one chunk, and the rest of it, with the emoji, is the next chunk's.
    const filler = "x".repeat(chunk - (limit - 5) - 1)
    expect(await linesOf(directory, `${filler}\n${long}`)).toEqual([
      "x".repeat(limit),
      kept,
      "next",
    ])
  })
})

describe("a text file as it loads", () => {
  it("is all of a short file, with the lines pointed at, pulled back to its end", async ({
    directory,
  }) => {
    const path = join(directory, "a.txt")
    writeFileSync(path, numbered(3))
    await expect(loadFile(file(path), false)).resolves.toEqual({
      state: "ready",
      stamp: expect.stringMatching(/^21:/),
      content: {
        kind: "file",
        path,
        firstLine: 1,
        lines: ["line 1", "line 2", "line 3"],
        from: 1,
        to: 3,
        total: 3,
        truncated: false,
        clamped: false,
      },
    })
    await expect(loadFile(file(path, { lines: { from: 2, to: 9 } }), false)).resolves.toMatchObject(
      { content: { from: 2, to: 3, clamped: true } },
    )
    await expect(loadFile(file(path, { lines: { from: 7, to: 9 } }), false)).resolves.toMatchObject(
      { content: { from: 3, to: 3, clamped: true } },
    )
  })

  it("is the start of a long file, or around the lines pointed at", async ({ directory }) => {
    const path = join(directory, "long.txt")
    writeFileSync(path, numbered(1000))
    const start = await loadFile(file(path), false)
    expect(start).toMatchObject({ content: { firstLine: 1, from: 1, to: 400, total: 1000 } })
    const around = await loadFile(file(path, { lines: { from: 500, to: 510 } }), false)
    expect(around).toMatchObject({ content: { firstLine: 460, from: 500, to: 510 } })
    const lines = around.state === "ready" && around.content.kind === "file" ? around.content : null
    expect([lines?.lines[0], lines?.lines.at(-1)]).toEqual(["line 460", "line 550"])
  })

  it("is read up to a budget, its line count then unknown", async ({ directory }) => {
    const path = join(directory, "huge.txt")
    writeFileSync(path, `${"a".repeat(1023)}\n`.repeat(5 * 1024))
    await expect(loadFile(file(path), false)).resolves.toMatchObject({
      state: "ready",
      content: { total: null, truncated: true, lines: expect.any(Array), clamped: false },
    })
  })

  it("streams to the lines pointed at however deep, clamping only past the file's end", async ({
    directory,
  }) => {
    // 120,000 lines of 100 bytes: 12 MB, three times the budget.
    const path = join(directory, "deep.log")
    writeFileSync(
      path,
      Array.from({ length: 120_000 }, (_, index) => `${padded(index + 1)}\n`).join(""),
    )
    const deep = await loadFile(file(path, { lines: { from: 50_000, to: 50_005 } }), false)
    const shown = deep.state === "ready" && deep.content.kind === "file" ? deep.content : null
    expect(shown).toMatchObject({
      firstLine: 49_960,
      from: 50_000,
      to: 50_005,
      total: null,
      truncated: true,
      clamped: false,
    })
    expect(shown?.lines[40]).toBe(padded(50_000))
    expect(shown?.lines.at(-1)).toBe(padded(50_045))
    // Past its end, read to its end: pulled back to its true last lines, with its count.
    const past = await loadFile(file(path, { lines: { from: 200_000, to: 200_001 } }), false)
    expect(past).toMatchObject({
      content: {
        firstLine: 119_960,
        from: 120_000,
        to: 120_000,
        total: 120_000,
        truncated: false,
        clamped: true,
      },
    })
    const tail = past.state === "ready" && past.content.kind === "file" ? past.content.lines : []
    expect(tail).toEqual(Array.from({ length: 41 }, (_, index) => padded(119_960 + index)))
  })

  it("pulls a range starting past the end back to the file's last lines", async ({ directory }) => {
    const path = join(directory, "long.txt")
    writeFileSync(path, numbered(1000))
    const past = await loadFile(file(path, { lines: { from: 1020, to: 1030 } }), false)
    expect(past).toMatchObject({ content: { firstLine: 960, from: 1000, to: 1000, clamped: true } })
    const lines = past.state === "ready" && past.content.kind === "file" ? past.content.lines : []
    expect(lines).toEqual(Array.from({ length: 41 }, (_, index) => `line ${960 + index}`))
  })

  it("ends lines at any line break, old Mac ones too", async ({ directory }) => {
    const path = join(directory, "cr.txt")
    writeFileSync(path, "one\rtwo\r\nthree\n")
    await expect(loadFile(file(path), false)).resolves.toMatchObject({
      content: { lines: ["one", "two", "three"] },
    })
  })

  it.runIf(process.platform === "linux")("is read to its end, as a file in /proc", async () => {
    const status = await loadFile(file("/proc/self/status"), false)
    const lines = status.state === "ready" && status.content.kind === "file" ? status.content : null
    expect(lines?.lines.some((line) => line.startsWith("Name:"))).toBe(true)
  })

  it("says why it can't be shown: missing, binary, secret unless revealed", async ({
    directory,
  }) => {
    const path = join(directory, "a.txt")
    writeFileSync(path, "a\n")
    const before = await loadFile(file(path), false)
    unlinkSync(path)
    await expect(loadFile(file(path), false)).resolves.toEqual({
      state: "unavailable",
      reason: "missing",
      size: null,
    })
    // Back again, with another stamp.
    writeFileSync(path, "a\nb\n")
    const after = await loadFile(file(path), false)
    expect(
      after.state === "ready" && before.state === "ready" && after.stamp !== before.stamp,
    ).toBe(true)
    writeFileSync(join(directory, "a.bin"), Buffer.from([0x41, 0x00, 0x42]))
    writeFileSync(join(directory, "late.txt"), `${"a".repeat(9 * 1024)}\0\n`)
    await expect(loadFile(file(join(directory, "a.bin")), false)).resolves.toEqual({
      state: "unavailable",
      reason: "binary",
      size: 3,
    })
    await expect(loadFile(file(join(directory, "late.txt")), false)).resolves.toMatchObject({
      state: "ready",
    })
    const secret = join(directory, ".env")
    writeFileSync(secret, "TOKEN=x\n")
    await expect(loadFile(file(secret, { secret: true }), false)).resolves.toEqual({
      state: "unavailable",
      reason: "secret",
      size: 8,
    })
    await expect(loadFile(file(secret, { secret: true }), true)).resolves.toMatchObject({
      content: { lines: ["TOKEN=x"] },
    })
    // Held by where it is now, even if it wasn't when shown.
    mkdirSync(join(directory, ".ssh"))
    symlinkSync(join(directory, ".ssh"), join(directory, "keys"))
    writeFileSync(join(directory, ".ssh", "notes.txt"), "KEY\n")
    await expect(
      loadFile(file(join(directory, "keys", "notes.txt")), false),
    ).resolves.toMatchObject({ reason: "secret" })
  })
})

describe("a data file as it loads", () => {
  const contentOf = async (path: string, lines?: { from: number; to: number }) => {
    const loaded = await loadFile(file(path, lines ? { lines } : {}), false)
    if (loaded.state !== "ready" || loaded.content.kind !== "file") throw new Error("not loaded")
    return loaded.content
  }

  it("is read whole from its start, its long lines uncut, whatever lines were pointed at", async ({
    directory,
  }) => {
    const path = join(directory, "rollout.jsonl")
    const long = JSON.stringify({ text: "x".repeat(20_000) })
    writeFileSync(path, `${long}\n${numbered(1000)}`)
    const content = await contentOf(path, { from: 500, to: 510 })
    expect(content).toMatchObject({
      firstLine: 1,
      from: 500,
      to: 510,
      total: 1001,
      truncated: false,
    })
    expect(content.lines[0]).toBe(long)
    expect(content.lines).toHaveLength(1001)
  })

  it("stops at its budget on a whole line, its line count then unknown", async ({ directory }) => {
    const path = join(directory, "big.csv")
    const row = `${"a".repeat(1023)}\r\n`
    writeFileSync(path, row.repeat(3 * 1024))
    const content = await contentOf(path)
    expect(content).toMatchObject({ firstLine: 1, total: null, truncated: true, clamped: false })
    expect(content.lines.every((line) => line === "a".repeat(1023))).toBe(true)
    // Each line counts its break.
    expect(content.lines.length * 1024).toBeLessThanOrEqual(companionLimits.data)
    expect((content.lines.length + 1) * 1024).toBeGreaterThan(companionLimits.data)
  })

  it("reads around lines pointed at past its budget, from a little before them, whole", async ({
    directory,
  }) => {
    const path = join(directory, "long.jsonl")
    const record = (at: number) => JSON.stringify({ at, text: "x".repeat(6000) })
    writeFileSync(path, Array.from({ length: 900 }, (_, at) => record(at + 1)).join("\n"))
    const content = await contentOf(path, { from: 800, to: 802 })
    expect(content).toMatchObject({ firstLine: 760, from: 800, to: 802, clamped: false })
    expect(content.lines[40]).toBe(record(800))
    expect(content.lines.at(-1)).toBe(record(900))
    expect(content).toMatchObject({ total: 900, truncated: false })
  })

  it("reads its last lines when the lines pointed at lie past its end", async ({ directory }) => {
    const path = join(directory, "long.jsonl")
    writeFileSync(path, `${'{"x":"' + "y".repeat(3000) + '"}\n'}`.repeat(1000))
    const content = await contentOf(path, { from: 5000, to: 5001 })
    expect(content).toMatchObject({ firstLine: 960, from: 1000, to: 1000, total: 1000 })
    expect(content).toMatchObject({ clamped: true, truncated: false })
  })

  it("holds every line that fits to the byte, the last whole one too", async ({ directory }) => {
    const path = join(directory, "edge.csv")
    // Each line costs its text and its break: exactly the budget.
    const count = companionLimits.data / 1024
    writeFileSync(path, `${"a".repeat(1023)}\n`.repeat(count))
    const content = await contentOf(path)
    expect(content).toMatchObject({ total: count, truncated: false })
    expect(content.lines).toHaveLength(count)
  })

  it("holds no more lines than the protocol takes, however many empty ones", async ({
    directory,
  }) => {
    const path = join(directory, "blank.jsonl")
    writeFileSync(path, "\n".repeat(companionLimits.data * 2))
    const loaded = await loadFile(file(path), false)
    expect(itemContent.safeParse(loaded).success).toBe(true)
    expect(loaded).toMatchObject({ content: { truncated: true } })
  })

  it("keeps a first line past its budget, cut short, so it shows something", async ({
    directory,
  }) => {
    const path = join(directory, "min.json")
    writeFileSync(path, `[${'"x",'.repeat(companionLimits.data / 4)}"x"]`)
    const content = await contentOf(path)
    expect(content).toMatchObject({ total: null, truncated: true })
    expect(content.lines).toHaveLength(1)
    expect(content.lines[0]).toHaveLength(companionLimits.data)
  })

  it("pulls lines pointed at past its end back to it, and reads a NUL as binary", async ({
    directory,
  }) => {
    const path = join(directory, "ci.yml")
    writeFileSync(path, "a: 1\nb: 2\n")
    await expect(contentOf(path, { from: 2, to: 9 })).resolves.toMatchObject({
      lines: ["a: 1", "b: 2"],
      from: 2,
      to: 2,
      total: 2,
      clamped: true,
    })
    const binary = join(directory, "blob.json")
    writeFileSync(binary, Buffer.from([0x7b, 0, 0x7d]))
    await expect(loadFile(file(binary), false)).resolves.toMatchObject({ reason: "binary" })
  })
})

describe("an image as it loads", () => {
  it("is a data URL of its type, up to the preview limit", async ({ directory }) => {
    const path = join(directory, "dot.png")
    writeFileSync(path, png)
    await expect(loadFile({ ...file(path), kind: "image" }, false)).resolves.toMatchObject({
      state: "ready",
      content: { kind: "image", src: `data:image/png;base64,${png.toString("base64")}` },
    })
    const big = join(directory, "big.png")
    writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(loadFile({ ...file(big), kind: "image" }, false)).resolves.toEqual({
      state: "unavailable",
      reason: "too-large",
      size: 8 * 1024 * 1024 + 1,
    })
  })

  it("is any format Chromium decodes, typed by its extension", async ({ directory }) => {
    const types = {
      "a.apng": "image/apng",
      "a.jfif": "image/jpeg",
      "a.pjpeg": "image/jpeg",
      "a.pjp": "image/jpeg",
      "a.AVIF": "image/avif",
      "photo.jxl": "image/jxl",
      "a.jpe": "image/jpeg",
      "a.bmp": "image/bmp",
      "favicon.ico": "image/x-icon",
      "a.cur": "image/x-icon",
    }
    for (const [name, type] of Object.entries(types)) {
      const path = join(directory, name)
      writeFileSync(path, png)
      // eslint-disable-next-line no-await-in-loop -- One file after another.
      await expect(pointAt(name, directory), name).resolves.toMatchObject({ kind: "image" })
      // eslint-disable-next-line no-await-in-loop -- One file after another.
      await expect(loadFile({ ...file(path), kind: "image" }, false), name).resolves.toMatchObject({
        state: "ready",
        content: { kind: "image", src: expect.stringMatching(`^data:${type};`) },
      })
    }
  })

  it("names a format as a person does, JPEG's other extensions as JPEG", () => {
    const named = {
      "a.png": "PNG",
      "a.jpg": "JPEG",
      "a.JPEG": "JPEG",
      "a.jpe": "JPEG",
      "a.jfif": "JPEG",
      "a.PJPEG": "JPEG",
      "a.pjp": "JPEG",
      "photo.jxl": "JPEG XL",
      "favicon.ico": "ICO",
      "pointer.cur": "CUR",
      "a.svg": "SVG",
      "demo.webm": "WEBM",
      "take.mp3": "MP3",
    }
    expect(Object.fromEntries(Object.keys(named).map((name) => [name, formatOf(name)]))).toEqual(
      named,
    )
  })

  it("isn't a format Chromium can't draw, which stays a file", async ({ directory }) => {
    // A gzipped SVG has no encoding a data URL can carry.
    for (const name of ["a.tiff", "a.tif", "a.heic", "a.heif", "a.svgz"]) {
      writeFileSync(join(directory, name), png)
      // eslint-disable-next-line no-await-in-loop -- One file after another.
      await expect(pointAt(name, directory), name).resolves.toMatchObject({ kind: "file" })
    }
  })
})

// A file of `size` bytes, with nothing written, which takes no room on disk.
const sparse = (path: string, size: number) => {
  const handle = openSync(path, "w")
  ftruncateSync(handle, size)
  closeSync(handle)
}

const video = (path: string, secret = false) => ({ kind: "video" as const, path, secret })
const recording = (path: string) => ({ kind: "audio" as const, path, secret: false })

const videoStamp = (content: Awaited<ReturnType<typeof loadPlayed>>): string =>
  content.state === "ready" ? content.stamp : ""

describe("a video as it loads", () => {
  it("is its format, size and the file's stamp, never its bytes", async ({ directory }) => {
    const path = join(directory, "demo.webm")
    writeFileSync(path, "frames")
    const loaded = await loadPlayed(video(path), false, { shown: 2, at: 12.5 })
    expect(loaded).toEqual({
      state: "ready",
      stamp: expect.any(String),
      content: { kind: "video", mime: "video/webm", size: 6, shown: 2, at: 12.5 },
    })
    // A show that gives no second starts it where the person is.
    await expect(loadPlayed(video(path), false, { shown: 3, at: undefined })).resolves.toEqual({
      ...loaded,
      content: { kind: "video", mime: "video/webm", size: 6, shown: 3 },
    })
    writeFileSync(path, "frames, rendered again")
    const again = await loadPlayed(video(path), false, { shown: 3, at: undefined })
    expect(videoStamp(again)).not.toBe(videoStamp(loaded))
  })

  it("says why it can't play: missing, a folder, secret unless revealed, too large", async ({
    directory,
  }) => {
    const shown = { shown: 1, at: undefined }
    await expect(loadPlayed(video(join(directory, "gone.mp4")), false, shown)).resolves.toEqual({
      state: "unavailable",
      reason: "missing",
      size: null,
    })
    mkdirSync(join(directory, "folder.mp4"))
    await expect(
      loadPlayed(video(join(directory, "folder.mp4")), false, shown),
    ).resolves.toMatchObject({ reason: "not-a-file" })
    const held = join(directory, "held.mp4")
    writeFileSync(held, "frames")
    await expect(loadPlayed(video(held, true), false, shown)).resolves.toEqual({
      state: "unavailable",
      reason: "secret",
      size: 6,
    })
    await expect(loadPlayed(video(held, true), true, shown)).resolves.toMatchObject({
      state: "ready",
    })
    const big = join(directory, "big.mp4")
    sparse(big, videoLimits.bytes + 1)
    await expect(loadPlayed(video(big), false, shown)).resolves.toEqual({
      state: "unavailable",
      reason: "too-large",
      size: videoLimits.bytes + 1,
    })
  })
})

describe("a recording as it loads", () => {
  it("is its format, size and the file's stamp, as a video's are", async ({ directory }) => {
    for (const [name, mime] of [
      ["take.mp3", "audio/mpeg"],
      ["voice.m4a", "audio/mp4"],
      ["note.opus", "audio/ogg"],
      ["a.flac", "audio/flac"],
    ] as const) {
      const path = join(directory, name)
      writeFileSync(path, "sound")
      // eslint-disable-next-line no-await-in-loop -- One file after another.
      await expect(loadPlayed(recording(path), false, { shown: 1, at: 3 })).resolves.toEqual({
        state: "ready",
        stamp: expect.any(String),
        content: { kind: "audio", mime, size: 5, shown: 1, at: 3 },
      })
    }
  })
})

describe("a part of a video", () => {
  it("is its bytes from the offset, a part at a time, and none past its end", async ({
    directory,
  }) => {
    const path = join(directory, "demo.mp4")
    const bytes = Buffer.from(Array.from({ length: partBytes + 10 }, (_, index) => index % 251))
    writeFileSync(path, bytes)
    const loaded = await loadPlayed(video(path), false, { shown: 1, at: undefined })
    const stamp = videoStamp(loaded)
    const first = await readPart(video(path), { stamp, offset: 0 }, false, videoLimits.bytes)
    const second = await readPart(
      video(path),
      { stamp, offset: partBytes },
      false,
      videoLimits.bytes,
    )
    const past = await readPart(
      video(path),
      { stamp, offset: bytes.length },
      false,
      videoLimits.bytes,
    )
    const read = [first, second].map((part) =>
      part.state === "part" ? Buffer.from(part.data, "base64") : Buffer.alloc(0),
    )
    expect(read.map((part) => part.length)).toEqual([partBytes, 10])
    expect(Buffer.concat(read).equals(bytes)).toBe(true)
    expect(past).toEqual({ state: "part", data: "" })
  })

  it("is changed once the file isn't as its stamp names it", async ({ directory }) => {
    const path = join(directory, "demo.mp4")
    writeFileSync(path, "frames")
    const loaded = await loadPlayed(video(path), false, { shown: 1, at: undefined })
    const stamp = videoStamp(loaded)
    writeFileSync(path, "frames, rendered again")
    await expect(
      readPart(video(path), { stamp, offset: 0 }, false, videoLimits.bytes),
    ).resolves.toEqual({
      state: "changed",
    })
  })

  it("is never read from a file that may hold secrets, unless revealed, or that is gone", async ({
    directory,
  }) => {
    const path = join(directory, "held.mp4")
    writeFileSync(path, "frames")
    const loaded = await loadPlayed(video(path, true), true, { shown: 1, at: undefined })
    const stamp = videoStamp(loaded)
    await expect(
      readPart(video(path, true), { stamp, offset: 0 }, false, videoLimits.bytes),
    ).resolves.toEqual({
      state: "unavailable",
      reason: "secret",
    })
    await expect(
      readPart(video(path, true), { stamp, offset: 0 }, true, videoLimits.bytes),
    ).resolves.toEqual({
      state: "part",
      data: Buffer.from("frames").toString("base64"),
    })
    unlinkSync(path)
    await expect(
      readPart(video(path), { stamp, offset: 0 }, false, videoLimits.bytes),
    ).resolves.toEqual({
      state: "unavailable",
      reason: "missing",
    })
  })
})

// A PDF item's pointer, as a video's is.
const pdfAt = video
const pdfStamp = videoStamp

describe("a PDF as it loads", () => {
  it("is shown as a PDF, by its extension", async ({ directory }) => {
    writeFileSync(join(directory, "report.PDF"), "%PDF-1.4")
    await expect(pointAt("report.PDF", directory)).resolves.toMatchObject({
      kind: "pdf",
      size: 8,
    })
  })

  it("is its size and the file's stamp, never its bytes", async ({ directory }) => {
    const path = join(directory, "report.pdf")
    writeFileSync(path, "%PDF-1.4")
    const loaded = await loadPdf(pdfAt(path), false)
    expect(loaded).toEqual({
      state: "ready",
      stamp: expect.any(String),
      content: { kind: "pdf", size: 8 },
    })
    writeFileSync(path, "%PDF-1.4, written again")
    expect(pdfStamp(await loadPdf(pdfAt(path), false))).not.toBe(pdfStamp(loaded))
  })

  it("says why it can't show: missing, a folder, secret unless revealed, too large", async ({
    directory,
  }) => {
    await expect(loadPdf(pdfAt(join(directory, "gone.pdf")), false)).resolves.toEqual({
      state: "unavailable",
      reason: "missing",
      size: null,
    })
    mkdirSync(join(directory, "folder.pdf"))
    await expect(loadPdf(pdfAt(join(directory, "folder.pdf")), false)).resolves.toMatchObject({
      reason: "not-a-file",
    })
    const held = join(directory, "held.pdf")
    writeFileSync(held, "%PDF-1.4")
    await expect(loadPdf(pdfAt(held, true), false)).resolves.toEqual({
      state: "unavailable",
      reason: "secret",
      size: 8,
    })
    await expect(loadPdf(pdfAt(held, true), true)).resolves.toMatchObject({ state: "ready" })
    const big = join(directory, "big.pdf")
    sparse(big, pdfLimits.bytes + 1)
    await expect(loadPdf(pdfAt(big), false)).resolves.toEqual({
      state: "unavailable",
      reason: "too-large",
      size: pdfLimits.bytes + 1,
    })
  })

  it("is read in parts up to its own limit, past which a part is too large", async ({
    directory,
  }) => {
    expect(partsOf.pdf).toBe(pdfLimits.bytes)
    const path = join(directory, "report.pdf")
    writeFileSync(path, "%PDF-1.4")
    const stamp = pdfStamp(await loadPdf(pdfAt(path), false))
    await expect(readPart(pdfAt(path), { stamp, offset: 0 }, false, partsOf.pdf!)).resolves.toEqual(
      { state: "part", data: Buffer.from("%PDF-1.4").toString("base64") },
    )
    await expect(readPart(pdfAt(path), { stamp, offset: 0 }, false, 4)).resolves.toEqual({
      state: "unavailable",
      reason: "too-large",
    })
  })
})

describe("captured lines", () => {
  it("keep to the file's ends and the protocol's bounds", () => {
    expect(captureWindow(1000, { from: 10, to: 995 })).toEqual({
      first: 1,
      last: 1000,
      from: 10,
      to: 995,
      clamped: false,
    })
    expect(captureWindow(5000, { from: 100, to: 4000 })).toEqual({
      first: 60,
      last: 2059,
      from: 100,
      to: 2059,
      clamped: false,
    })
    expect(captureWindow(1, undefined)).toEqual({
      first: 1,
      last: 1,
      from: 1,
      to: 1,
      clamped: false,
    })
  })
})

describe("a plan's file", () => {
  it("is its text, when it changed, cut short past 256 KiB, never mid-character", async ({
    directory,
  }) => {
    const path = join(directory, "p.md")
    writeFileSync(path, "# Plan\n")
    await expect(readPlanFile(path)).resolves.toEqual({
      text: "# Plan\n",
      truncated: false,
      changedAt: expect.any(Number),
      stamp: expect.stringMatching(/^7:/),
    })
    writeFileSync(path, `${"a".repeat(256 * 1024 - 1)}ż and more`)
    await expect(readPlanFile(path)).resolves.toMatchObject({
      truncated: true,
      text: "a".repeat(256 * 1024 - 1),
    })
    await expect(readPlanFile(join(directory, "none.md"))).resolves.toBeUndefined()
  })

  it.skipIf(process.platform === "win32")(
    "is nothing but a plain file, so a pipe in its place never blocks",
    async ({ directory }) => {
      const path = join(directory, "p.md")
      expect(spawnSync("mkfifo", [path]).status).toBe(0)
      await expect(readPlanFile(path)).resolves.toBeUndefined()
    },
  )

  it("is titled by its first heading, or its file's name", async ({ directory }) => {
    const path = join(directory, "brave-fox.md")
    writeFileSync(path, "Intro\n## Fix the login redirect ##\n")
    await expect(planTitle({ kind: "file", path })).resolves.toBe("Fix the login redirect")
    writeFileSync(path, "no heading\n")
    await expect(planTitle({ kind: "file", path })).resolves.toBe("brave-fox.md")
    await expect(planTitle({ kind: "text", text: "plain", truncated: false })).resolves.toBe(
      undefined,
    )
  })
})

// A Claude Code transcript line presenting a plan for review.
const presented = (plan: string, timestamp: string) =>
  `${JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      content: [{ type: "tool_use", id: "call", name: "ExitPlanMode", input: { plan } }],
    },
  })}\n`

describe("a plan presented as text", () => {
  it("is read back from a Codex rollout with Codex's own decoder", async ({ directory }) => {
    const fixture = loadProbe(adapterFolder("codex"), "plan.probe.json") as { records: object[] }
    const rollout = join(directory, "rollout.jsonl")
    writeFileSync(rollout, fixture.records.map((record) => `${JSON.stringify(record)}\n`).join(""))
    const plan = await readTextPlan("codex", rollout)
    expect(plan?.text).toMatch(/^# /)
    const item = {
      path: rollout,
      plan: { agent: "codex", session: "s", actor: null, format: "text" },
    } as const
    await expect(loadPlan(item, undefined)).resolves.toMatchObject({
      state: "ready",
      content: { kind: "plan", text: plan?.text, truncated: false },
    })
    // What the live terminal has comes first, and the file stays the source after.
    await expect(
      loadPlan(item, { text: "# Live", truncated: false, changedAt: 1 }),
    ).resolves.toMatchObject({ content: { text: "# Live", changedAt: 1 } })
    unlinkSync(rollout)
    await expect(loadPlan(item, undefined)).resolves.toEqual({
      state: "unavailable",
      reason: "gone",
      size: null,
    })
  })

  it("is the latest a Claude Code transcript presents for review", async ({ directory }) => {
    const transcript = join(directory, "session.jsonl")
    writeFileSync(transcript, presented("# First", "2026-09-30T08:00:00Z"))
    await expect(readTextPlan("claude", transcript)).resolves.toEqual({
      text: "# First",
      truncated: false,
      changedAt: Date.parse("2026-09-30T08:00:00Z"),
    })
    appendFileSync(transcript, `{"type":"user","message":{"content":"ok"}}\n`)
    appendFileSync(transcript, presented("# Second", "2026-09-30T09:00:00Z"))
    await expect(readTextPlan("claude", transcript)).resolves.toMatchObject({ text: "# Second" })
    // A line still being written counts once it ends; reads at once share one decode.
    const third = presented("# Third", "2026-09-30T10:00:00Z")
    appendFileSync(transcript, third.slice(0, 40))
    await expect(readTextPlan("claude", transcript)).resolves.toMatchObject({ text: "# Second" })
    appendFileSync(transcript, third.slice(40))
    const [one, two] = await Promise.all([
      readTextPlan("claude", transcript),
      readTextPlan("claude", transcript),
    ])
    expect([one?.text, two?.text]).toEqual(["# Third", "# Third"])
    // Rewritten in place, longer, it is read again from its start.
    writeFileSync(
      transcript,
      presented("# Rewritten", "2026-09-30T10:30:00Z").repeat(4) + "\n".repeat(64),
    )
    await expect(readTextPlan("claude", transcript)).resolves.toMatchObject({
      text: "# Rewritten",
    })
    // Rewritten shorter, it is read again from its start.
    writeFileSync(transcript, presented("# Anew", "2026-09-30T11:00:00Z"))
    await expect(readTextPlan("claude", transcript)).resolves.toMatchObject({ text: "# Anew" })
    // A last line whose newline is still to come counts, and again once it has one.
    writeFileSync(transcript, presented("# Unended", "2026-09-30T12:00:00Z").trimEnd())
    await expect(readTextPlan("claude", transcript)).resolves.toMatchObject({ text: "# Unended" })
    appendFileSync(transcript, "\n")
    await expect(readTextPlan("claude", transcript)).resolves.toMatchObject({ text: "# Unended" })
    appendFileSync(transcript, presented("# After", "2026-09-30T13:00:00Z"))
    await expect(readTextPlan("claude", transcript)).resolves.toMatchObject({ text: "# After" })
    // Antigravity keeps its plans in files only.
    await expect(readTextPlan("agy", transcript)).resolves.toBeUndefined()
  })
})

describe("saving a plan", () => {
  const filePlan = (path: string) =>
    ({
      path,
      plan: { agent: "claude", session: "s", actor: null, format: "file" },
    }) as const

  it("writes a plan's file whole when it is as the edit was made on, and answers its new stamp", async ({
    directory,
  }) => {
    const path = join(directory, "p.md")
    writeFileSync(path, "# Plan\n")
    const loaded = await loadPlan(filePlan(path), undefined)
    expect(loaded).toMatchObject({ state: "ready", content: { writable: true, skill: false } })
    const stamp = loaded.state === "ready" ? loaded.stamp : ""
    const saved = await savePlan(filePlan(path), "# Plan\n<!-- novadeck: note -->\n", stamp)
    expect(saved).toEqual({ saved: true, stamp: (await readPlanFile(path))?.stamp })
    expect(readFileSync(path, "utf8")).toBe("# Plan\n<!-- novadeck: note -->\n")
    // No temporary file is left beside it.
    expect(readdirSync(directory)).toEqual(["p.md"])
  })

  it("writes nothing and hands back the plan as it stands when the file changed since", async ({
    directory,
  }) => {
    const path = join(directory, "p.md")
    writeFileSync(path, "# Plan\n")
    const stamp = (await readPlanFile(path))?.stamp ?? ""
    writeFileSync(path, "# Plan, rewritten by the agent\n")
    const result = await savePlan(filePlan(path), "# Mine\n", stamp)
    expect(result).toEqual({
      saved: false,
      current: {
        stamp: (await readPlanFile(path))?.stamp,
        text: "# Plan, rewritten by the agent\n",
        truncated: false,
      },
    })
    expect(readFileSync(path, "utf8")).toBe("# Plan, rewritten by the agent\n")
  })

  it.skipIf(process.platform === "win32")("keeps the file's permissions", async ({ directory }) => {
    const path = join(directory, "p.md")
    writeFileSync(path, "# Plan\n")
    chmodSync(path, 0o664)
    // Whatever the umask, as a clipped mode would show.
    const umask = process.umask(0o022)
    try {
      await savePlan(filePlan(path), "# Edited\n", (await readPlanFile(path))?.stamp ?? "")
    } finally {
      process.umask(umask)
    }
    expect(statSync(path).mode & 0o777).toBe(0o664)
  })

  it.skipIf(process.platform === "win32")(
    "writes the file a link points at and leaves the link",
    async ({ directory }) => {
      const target = join(directory, "real.md")
      const link = join(directory, "link.md")
      writeFileSync(target, "# Plan\n")
      symlinkSync(target, link)
      await savePlan(filePlan(link), "# Edited\n", (await readPlanFile(link))?.stamp ?? "")
      expect(readFileSync(target, "utf8")).toBe("# Edited\n")
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
    },
  )

  it("answers the stamp the file has after, and loads a plan cut short as read-only", async ({
    directory,
  }) => {
    const path = join(directory, "p.md")
    writeFileSync(path, "# Plan\n")
    const saved = await savePlan(
      filePlan(path),
      "# Edited\n",
      (await readPlanFile(path))?.stamp ?? "",
    )
    expect(saved).toEqual({ saved: true, stamp: (await readPlanFile(path))?.stamp })
    writeFileSync(path, "a".repeat(256 * 1024 + 10))
    await expect(loadPlan(filePlan(path), undefined)).resolves.toMatchObject({
      content: { truncated: true, writable: false },
    })
  })

  it("saves only under the folders it is given, as the real paths they are", async ({
    directory,
  }) => {
    const project = join(directory, "project")
    const plans = join(directory, "plans")
    const elsewhere = join(directory, "elsewhere")
    for (const folder of [project, plans, elsewhere]) mkdirSync(folder)
    const outside = join(elsewhere, "p.md")
    writeFileSync(outside, "# Plan\n")
    writeFileSync(join(project, "p.md"), "# Plan\n")
    writeFileSync(join(plans, "p.md"), "# Plan\n")
    const stampOf = async (path: string) => (await readPlanFile(path))?.stamp ?? ""
    const folders = [project, plans, join(directory, "missing")]
    await expect(
      savePlan(filePlan(outside), "x", await stampOf(outside), folders),
    ).rejects.toMatchObject({ code: "PLAN_UNWRITABLE", data: { reason: "outside" } })
    expect(readFileSync(outside, "utf8")).toBe("# Plan\n")
    for (const inside of [join(project, "p.md"), join(plans, "p.md")]) {
      // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
      const stamp = await stampOf(inside)
      // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
      await expect(savePlan(filePlan(inside), "# New\n", stamp, folders)).resolves.toMatchObject({
        saved: true,
      })
    }
    // No folders, no saving; a folder is not its sibling of the same prefix.
    await expect(savePlan(filePlan(outside), "x", "", [])).rejects.toMatchObject({
      data: { reason: "outside" },
    })
    mkdirSync(join(directory, "plans-more"))
    writeFileSync(join(directory, "plans-more", "p.md"), "# Plan\n")
    await expect(
      savePlan(filePlan(join(directory, "plans-more", "p.md")), "x", "", folders),
    ).rejects.toMatchObject({ data: { reason: "outside" } })
  })

  it.skipIf(process.platform === "win32")(
    "refuses a link in a folder that leads out of it",
    async ({ directory }) => {
      const plans = join(directory, "plans")
      mkdirSync(plans)
      const target = join(directory, "secret.md")
      writeFileSync(target, "# Not a plan\n")
      symlinkSync(target, join(plans, "p.md"))
      await expect(
        savePlan(filePlan(join(plans, "p.md")), "x", (await readPlanFile(target))?.stamp ?? "", [
          plans,
        ]),
      ).rejects.toMatchObject({ data: { reason: "outside" } })
      expect(readFileSync(target, "utf8")).toBe("# Not a plan\n")
    },
  )

  it("refuses what can never be saved as PLAN_UNWRITABLE, saying why", async ({ directory }) => {
    const path = join(directory, "p.md")
    writeFileSync(path, "# Plan\n")
    const stamp = (await readPlanFile(path))?.stamp ?? ""
    const reason = (why: string) => ({ code: "PLAN_UNWRITABLE", data: { reason: why } })
    await expect(
      savePlan(
        { path, plan: { agent: "claude", session: "s", actor: null, format: "text" } },
        "x",
        "",
      ),
    ).rejects.toMatchObject(reason("transcript"))
    await expect(savePlan({ path, plan: null }, "x", stamp)).rejects.toMatchObject(
      reason("not-a-plan"),
    )
    await expect(savePlan(filePlan(join(directory, "none.md")), "x", stamp)).rejects.toMatchObject(
      reason("gone"),
    )
    // No longer a plain file.
    mkdirSync(join(directory, "dir.md"))
    await expect(savePlan(filePlan(join(directory, "dir.md")), "x", stamp)).rejects.toMatchObject(
      reason("gone"),
    )
    await expect(savePlan(filePlan(path), "a".repeat(256 * 1024 + 1), stamp)).rejects.toMatchObject(
      reason("too-large"),
    )
    // A multibyte text under the character limit can still pass the byte limit.
    await expect(savePlan(filePlan(path), "ż".repeat(200 * 1024), stamp)).rejects.toMatchObject(
      reason("too-large"),
    )
    writeFileSync(path, "a".repeat(256 * 1024 + 10))
    await expect(
      savePlan(filePlan(path), "short", (await readPlanFile(path))?.stamp ?? ""),
    ).rejects.toMatchObject(reason("too-large"))
    expect(readFileSync(path, "utf8")).toHaveLength(256 * 1024 + 10)
    expect(readdirSync(directory).toSorted()).toEqual(["dir.md", "p.md"])
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a plan in a folder it may not write to as PLAN_UNWRITABLE folder",
    async ({ directory }) => {
      const folder = join(directory, "ro")
      mkdirSync(folder)
      const path = join(folder, "p.md")
      writeFileSync(path, "# Plan\n")
      const stamp = (await readPlanFile(path))?.stamp ?? ""
      chmodSync(folder, 0o555)
      try {
        await expect(savePlan(filePlan(path), "# Edited\n", stamp)).rejects.toMatchObject({
          code: "PLAN_UNWRITABLE",
          data: { reason: "folder" },
        })
        expect(readdirSync(folder)).toEqual(["p.md"])
        expect(readFileSync(path, "utf8")).toBe("# Plan\n")
      } finally {
        chmodSync(folder, 0o755)
      }
    },
  )
})
