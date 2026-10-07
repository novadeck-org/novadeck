import { spawnSync } from "node:child_process"
import {
  appendFileSync,
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

import { describe, expect, it as base } from "../test.js"
import { loadProbe } from "../testing/probes.js"
import {
  captureWindow,
  loadFile,
  loadPlan,
  pageAt,
  planTitle,
  pointAt,
  readPlanFile,
  readTextPlan,
} from "./content.js"

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
  fields: { lines?: { from: number; to: number }; held?: boolean } = {},
) => ({ kind: "file", path, lines: fields.lines ?? null, held: fields.held ?? false }) as const

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
    const pointed = { ok: true, path: join(directory, "src", "a.ts"), kind: "file", held: false }
    await expect(pointAt("a.ts", join(directory, "src"))).resolves.toMatchObject(pointed)
    await expect(pointAt("link.ts", directory)).resolves.toMatchObject(pointed)
    // A binary file too: it says so as it loads.
    await expect(pointAt("a.bin", directory)).resolves.toMatchObject({ ok: true, kind: "file" })
    await expect(pointAt("dot.PNG", directory)).resolves.toMatchObject({
      kind: "image",
      size: png.length,
    })
    await expect(pointAt(".env", directory)).resolves.toMatchObject({ ok: true, held: true })
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

  it("says why it can't be shown: missing, binary, held unless revealed", async ({ directory }) => {
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
    await expect(loadFile(file(secret, { held: true }), false)).resolves.toEqual({
      state: "unavailable",
      reason: "held",
      size: 8,
    })
    await expect(loadFile(file(secret, { held: true }), true)).resolves.toMatchObject({
      content: { lines: ["TOKEN=x"] },
    })
    // Held by where it is now, even if it wasn't when shown.
    mkdirSync(join(directory, ".ssh"))
    symlinkSync(join(directory, ".ssh"), join(directory, "keys"))
    writeFileSync(join(directory, ".ssh", "notes.txt"), "KEY\n")
    await expect(
      loadFile(file(join(directory, "keys", "notes.txt")), false),
    ).resolves.toMatchObject({ reason: "held" })
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
    const fixture = loadProbe(
      join(import.meta.dirname, "..", "harnesses", "codex"),
      "plan.probe.json",
    ) as { records: object[] }
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
