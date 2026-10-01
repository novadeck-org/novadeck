import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import {
  capture,
  captureWindow,
  readRequest,
  maxShownBytes,
  remember,
  type Artifact,
  type Captured,
  type Place,
} from "./artifacts.js"

type Fixture = {
  /** The project folder, where the terminal is. */
  project: string
  /** A folder beside it, outside the project. */
  outside: string
  place: Place
}

const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    // Native, as capture resolves paths: on Windows it also expands short names.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-artifacts-")))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const project = join(root, "project")
    const outside = join(root, "outside")
    mkdirSync(join(project, "src"), { recursive: true })
    mkdirSync(outside)
    await use({
      project,
      outside,
      place: { cwd: project, project },
    })
  },
})

const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n"

// A 1×1 transparent PNG.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
)

describe("what an agent may show", () => {
  it("is a file, by a path from the terminal's directory or an absolute one", async ({
    fixture,
  }) => {
    writeFileSync(join(fixture.project, "src", "a.ts"), "const a = 1\n")
    const place = { ...fixture.place, cwd: join(fixture.project, "src") }
    await expect(capture({ path: "a.ts" }, place)).resolves.toMatchObject({
      ok: true,
      name: "a.ts",
      detail: `${join("src", "a.ts")} · whole file`,
      content: { kind: "file", path: join(fixture.project, "src", "a.ts") },
    })
    await expect(
      capture({ path: join(fixture.project, "src", "a.ts") }, fixture.place),
    ).resolves.toMatchObject({ ok: true })
  })

  it("is any file the person can read, outside the project too, as a viewer would", async ({
    fixture,
  }) => {
    writeFileSync(join(fixture.outside, "notes.txt"), "notes\n")
    symlinkSync(join(fixture.outside, "notes.txt"), join(fixture.project, "link.txt"))
    await expect(capture({ path: "../outside/notes.txt" }, fixture.place)).resolves.toMatchObject({
      ok: true,
      content: { kind: "file", path: join(fixture.outside, "notes.txt") },
    })
    // Through a symlink, named as given.
    await expect(capture({ path: "link.txt" }, fixture.place)).resolves.toMatchObject({
      ok: true,
      detail: "link.txt · whole file",
    })
    // With no project at all.
    await expect(
      capture({ path: "link.txt" }, { cwd: fixture.project, project: undefined }),
    ).resolves.toMatchObject({ ok: true })
  })

  it("is named as given where it is not in the project, and by its title when it has one", async ({
    fixture,
  }) => {
    writeFileSync(join(fixture.outside, "notes.md"), "# Notes\n")
    const path = join(fixture.outside, "notes.md")
    await expect(capture({ path, title: "My notes" }, fixture.place)).resolves.toMatchObject({
      ok: true,
      name: "My notes",
      detail: `${path} · whole file`,
    })
  })

  it("is never a folder, a missing file, or one too large", async ({ fixture }) => {
    writeFileSync(join(fixture.project, "big.txt"), "a".repeat(1024 * 1024 + 1))
    writeFileSync(join(fixture.project, "big.png"), Buffer.alloc(8 * 1024 * 1024 + 1))
    writeFileSync(join(fixture.project, "fine.png"), Buffer.alloc(1024 * 1024 + 1))
    await expect(capture({ path: "src" }, fixture.place)).resolves.toEqual({
      ok: false,
      reason: "That's a folder; only files can be shown.",
    })
    await expect(capture({ path: "gone.txt" }, fixture.place)).resolves.toEqual({
      ok: false,
      reason: "That file doesn't exist.",
    })
    await expect(capture({ path: "big.txt" }, fixture.place)).resolves.toEqual({
      ok: false,
      reason: "It's too large to show (limit 1 MB).",
    })
    await expect(capture({ path: "big.png" }, fixture.place)).resolves.toEqual({
      ok: false,
      reason: "It's too large to show (limit 8 MB).",
    })
    // An image may be larger than a text file.
    await expect(capture({ path: "fine.png" }, fixture.place)).resolves.toMatchObject({
      ok: true,
      detail: "1.0 MB PNG",
    })
  })

  it("is an image by its extension, as a data URL of its type", async ({ fixture }) => {
    writeFileSync(join(fixture.project, "dot.png"), png)
    writeFileSync(join(fixture.project, "icon.SVG"), "<svg/>")
    await expect(capture({ path: "dot.png" }, fixture.place)).resolves.toMatchObject({
      ok: true,
      name: "dot.png",
      detail: `${png.length} B PNG`,
      content: { kind: "image", src: `data:image/png;base64,${png.toString("base64")}` },
    })
    await expect(capture({ path: "icon.SVG" }, fixture.place)).resolves.toMatchObject({
      detail: "6 B SVG",
      content: { kind: "image", src: expect.stringMatching(/^data:image\/svg\+xml;base64,/) },
    })
  })

  it("is a text file only without a NUL byte in its start", async ({ fixture }) => {
    writeFileSync(join(fixture.project, "a.bin"), Buffer.from([0x41, 0x00, 0x42]))
    writeFileSync(join(fixture.project, "late.txt"), `${"a".repeat(9 * 1024)}\0\n`)
    await expect(capture({ path: "a.bin" }, fixture.place)).resolves.toEqual({
      ok: false,
      reason: "Only images and text files can be shown.",
    })
    await expect(capture({ path: "late.txt" }, fixture.place)).resolves.toMatchObject({ ok: true })
  })
})

describe("a text file's captured lines", () => {
  it("are all of a short file, with the lines pointed at", async ({ fixture }) => {
    writeFileSync(join(fixture.project, "a.txt"), numbered(3))
    await expect(capture({ path: "a.txt" }, fixture.place)).resolves.toMatchObject({
      detail: "a.txt · whole file",
      content: { firstLine: 1, lines: ["line 1", "line 2", "line 3"], from: 1, to: 3 },
    })
    await expect(
      capture({ path: "a.txt", lines: { from: 2, to: 9 } }, fixture.place),
    ).resolves.toMatchObject({
      detail: "a.txt · lines 2–3",
      content: { firstLine: 1, lines: ["line 1", "line 2", "line 3"], from: 2, to: 3 },
    })
    await expect(
      capture({ path: "a.txt", lines: { from: 4, to: 5 } }, fixture.place),
    ).resolves.toEqual({ ok: false, reason: "It has only 3 lines." })
  })

  it("are the start of a long file, or around the lines pointed at", async ({ fixture }) => {
    writeFileSync(join(fixture.project, "long.txt"), numbered(1000))
    const start = await capture({ path: "long.txt" }, fixture.place)
    expect(start).toMatchObject({
      detail: "long.txt · lines 1–400",
      content: { firstLine: 1, from: 1, to: 400 },
    })
    expect(start.ok && start.content.kind === "file" && start.content.lines).toHaveLength(400)
    const around = await capture({ path: "long.txt", lines: { from: 500, to: 510 } }, fixture.place)
    expect(around).toMatchObject({
      detail: "long.txt · lines 500–510",
      content: { firstLine: 460, from: 500, to: 510 },
    })
    const lines = around.ok && around.content.kind === "file" ? around.content.lines : []
    expect([lines[0], lines.at(-1)]).toEqual(["line 460", "line 550"])
  })

  it("keep to the file's ends and the protocol's bounds", () => {
    expect(captureWindow(1000, { from: 10, to: 995 })).toEqual({
      first: 1,
      last: 1000,
      from: 10,
      to: 995,
    })
    expect(captureWindow(5000, { from: 100, to: 4000 })).toEqual({
      first: 60,
      last: 2059,
      from: 100,
      to: 2059,
    })
    expect(captureWindow(1, undefined)).toEqual({ first: 1, last: 1, from: 1, to: 1 })
  })
})

describe("a present request", () => {
  it("names a path, and only lines that run forward", () => {
    expect(readRequest({ path: "a.ts", lines: { from: 2, to: 2 }, open: true })).toEqual({
      ok: true,
      request: { path: "a.ts", lines: { from: 2, to: 2 }, open: true },
    })
    expect(readRequest({ path: "a.ts", lines: { from: 3, to: 2 } })).toEqual({
      ok: false,
      reason: 'The request\'s "lines" is not valid.',
    })
    expect(readRequest({ path: "" })).toMatchObject({ ok: false })
    expect(readRequest({ path: "a.ts", title: "t".repeat(257) })).toMatchObject({ ok: false })
    expect(readRequest({ path: "a.ts", extra: 1 })).toMatchObject({ ok: false })
  })

  it("names a page by its url, or a path, never both, and lines only for a file", () => {
    expect(readRequest({ url: "http://localhost:5173/", open: true })).toEqual({
      ok: true,
      request: { url: "http://localhost:5173/", open: true },
    })
    expect(readRequest({ url: "http://localhost:5173/", path: "a.ts" })).toEqual({
      ok: false,
      reason: "Give a path or a url, not both.",
    })
    expect(readRequest({ url: "http://a/", lines: { from: 1, to: 1 } })).toMatchObject({
      ok: false,
    })
    expect(readRequest({ url: "" })).toMatchObject({ ok: false })
    expect(readRequest({})).toEqual({ ok: false, reason: "Give a path or a url." })
  })
})

describe("a page an agent shows", () => {
  const place: Place = { cwd: "/p", project: "/p" }

  it("is any http or https address, named by its host or its title", async () => {
    const page = await capture({ url: "http://localhost:5173/app?x=1#top" }, place)
    expect(page).toMatchObject({
      ok: true,
      name: "localhost:5173",
      detail: "http://localhost:5173/app?x=1#top",
      content: { kind: "page", url: "http://localhost:5173/app?x=1#top" },
    })
    await expect(
      capture({ url: "https://example.com", title: "Example" }, place),
    ).resolves.toMatchObject({
      ok: true,
      name: "Example",
      content: { kind: "page", url: "https://example.com/" },
    })
  })

  it("is shown again under the same id by the same address", async () => {
    const first = await capture({ url: "https://example.com/" }, place)
    const again = await capture({ url: "https://example.com" }, place)
    expect(first.ok && again.ok && first.id === again.id).toBe(true)
  })

  it("is never another scheme, an address with credentials, or not an address", async () => {
    await expect(capture({ url: "file:///etc/passwd" }, place)).resolves.toEqual({
      ok: false,
      reason: "NovaDeck shows only http and https pages.",
    })
    await expect(capture({ url: "javascript:alert(1)" }, place)).resolves.toMatchObject({
      ok: false,
    })
    await expect(capture({ url: "https://me:secret@example.com/" }, place)).resolves.toEqual({
      ok: false,
      reason: "NovaDeck won't show an address with a user name or password in it.",
    })
    await expect(capture({ url: "localhost:5173" }, place)).resolves.toMatchObject({
      ok: false,
    })
    await expect(capture({ url: "not an address" }, place)).resolves.toEqual({
      ok: false,
      reason: "That isn't a valid address.",
    })
  })

  it("is never longer, once encoded, than the protocol carries", async () => {
    // Each ł takes six characters once encoded.
    const long = `https://example.com/?q=${"ł".repeat(1500)}`
    expect(long.length).toBeLessThan(8192)
    await expect(capture({ url: long }, place)).resolves.toEqual({
      ok: false,
      reason: "That address is too long.",
    })
  })
})

const captured = (id: string, line = "a"): Captured => ({
  ok: true,
  id,
  name: `${id}.txt`,
  detail: `${id}.txt · whole file`,
  content: { kind: "file", path: `/p/${id}.txt`, firstLine: 1, lines: [line], from: 1, to: 1 },
})

// An image of this many bytes of content.
const image = (id: string, bytes: number): Captured => ({
  ok: true,
  id,
  name: `${id}.png`,
  detail: "",
  content: { kind: "image", src: "x".repeat(bytes) },
})

describe("what a terminal shows", () => {
  it("replaces what is shown again with a later version, as the newest", () => {
    let shown: ReadonlyMap<string, Artifact> = new Map()
    shown = remember(shown, captured("a"), false)
    shown = remember(shown, captured("b"), false)
    shown = remember(shown, captured("a", "changed"), true)
    expect([...shown.values()].map((artifact) => artifact.shown)).toEqual([
      {
        id: "b",
        kind: "file",
        name: "b.txt",
        detail: "b.txt · whole file",
        version: 1,
        asked: false,
      },
      {
        id: "a",
        kind: "file",
        name: "a.txt",
        detail: "a.txt · whole file",
        version: 2,
        asked: true,
      },
    ])
    expect(shown.get("a")?.content).toMatchObject({ lines: ["changed"] })
  })

  it("lists a held one as held", () => {
    const shown = remember(new Map(), { ...captured("env"), held: true }, false)
    expect(shown.get("env")?.shown).toMatchObject({ held: true, asked: false })
    expect(remember(new Map(), captured("a"), false).get("a")?.shown).not.toHaveProperty("held")
  })

  it("keeps the latest 64", () => {
    let shown: ReadonlyMap<string, Artifact> = new Map()
    for (let index = 0; index < 65; index += 1)
      shown = remember(shown, captured(`f${index}`), false)
    expect(shown.size).toBe(64)
    expect([...shown.keys()][0]).toBe("f1")
  })

  it("keeps no more of what was shown than its budget, the newest always", () => {
    let shown: ReadonlyMap<string, Artifact> = new Map()
    const third = Math.floor(maxShownBytes / 3)
    for (const id of ["a", "b", "c", "d"]) shown = remember(shown, image(id, third), false)
    expect([...shown.keys()]).toEqual(["b", "c", "d"])
    shown = remember(shown, image("huge", maxShownBytes + 1), false)
    expect([...shown.keys()]).toEqual(["huge"])
  })
})

describe("a file that may hold secrets", () => {
  it("is shown, but held: it never opens by itself", async ({ fixture }) => {
    mkdirSync(join(fixture.project, ".ssh"))
    const secrets = [
      ".env",
      ".env.local",
      join(".ssh", "config"),
      "server.pem",
      "id_ed25519",
      ".npmrc",
    ]
    for (const path of secrets) writeFileSync(join(fixture.project, path), "secret\n")
    for (const path of secrets)
      // eslint-disable-next-line no-await-in-loop -- One file after another.
      await expect(capture({ path }, fixture.place)).resolves.toMatchObject({
        ok: true,
        held: true,
      })
  })

  it("is held as well under a name, or behind a link, that hides it", async ({ fixture }) => {
    mkdirSync(join(fixture.outside, ".ssh"))
    writeFileSync(join(fixture.outside, ".ssh", "id_rsa"), "KEY\n")
    writeFileSync(join(fixture.outside, ".ssh", "photo.png"), png)
    symlinkSync(join(fixture.outside, ".ssh", "id_rsa"), join(fixture.project, "innocent.txt"))
    // Held, and by its own name, not the link's or the agent's title.
    await expect(
      capture({ path: "innocent.txt", title: "Screenshot" }, fixture.place),
    ).resolves.toMatchObject({ ok: true, held: true, name: "id_rsa" })
    // An image in a folder of keys too.
    await expect(
      capture({ path: join(fixture.outside, ".ssh", "photo.png") }, fixture.place),
    ).resolves.toMatchObject({ ok: true, held: true, content: { kind: "image" } })
  })

  it("is held for agents' and tools' logins, environments and shell history", async ({
    fixture,
  }) => {
    const logins = [
      join(".claude", ".credentials.json"),
      join(".codex", "auth.json"),
      join(".config", "gh", "hosts.yml"),
      join(".config", "gcloud", "application_default_credentials.json"),
      join(".cargo", "credentials.toml"),
      join(".gemini", "oauth_creds.json"),
      ".envrc",
      "prod.env",
      ".bash_history",
      ".zsh_history",
      ".vault-token",
      join(".terraform.d", "credentials.tfrc.json"),
      join(".local", "share", "fish", "fish_history"),
      ".yarnrc.yml",
      join(".config", "rclone", "rclone.conf"),
      ".s3cfg",
      join("AppData", "Roaming", "GitHub CLI", "hosts.yml"),
    ]
    for (const path of logins) {
      mkdirSync(join(fixture.outside, path, ".."), { recursive: true })
      writeFileSync(join(fixture.outside, path), "x\n")
    }
    for (const path of logins)
      // eslint-disable-next-line no-await-in-loop -- One file after another.
      await expect(
        capture({ path: join(fixture.outside, path) }, fixture.place),
      ).resolves.toMatchObject({ ok: true, held: true })
  })

  it("is not a file a tool's login is merely named like, elsewhere", async ({ fixture }) => {
    const plain = [join("src", "i18n", "en", "auth.json"), join("deploy", "gcloud", "README.md")]
    for (const path of plain) {
      mkdirSync(join(fixture.project, path, ".."), { recursive: true })
      writeFileSync(join(fixture.project, path), "{}\n")
    }
    for (const path of plain) {
      // eslint-disable-next-line no-await-in-loop -- One file after another.
      const plainFile = await capture({ path }, fixture.place)
      expect(plainFile).toMatchObject({ ok: true })
      expect(plainFile).not.toHaveProperty("held")
    }
  })

  it("is not code that merely mentions secrets, which isn't held", async ({ fixture }) => {
    writeFileSync(join(fixture.project, "secrets.ts"), "export {}\n")
    const code = await capture({ path: "secrets.ts" }, fixture.place)
    expect(code).toMatchObject({ ok: true })
    expect(code).not.toHaveProperty("held")
  })
})

describe("what an agent may not show", () => {
  it("is a folder, the terminal's own one too", async ({ fixture }) => {
    await expect(capture({ path: "." }, fixture.place)).resolves.toEqual({
      ok: false,
      reason: "That's a folder; only files can be shown.",
    })
    await expect(capture({ path: fixture.outside }, fixture.place)).resolves.toEqual({
      ok: false,
      reason: "That's a folder; only files can be shown.",
    })
  })
})

describe("a file that reports no size", () => {
  it.runIf(process.platform === "linux")("is read to its end, as a file in /proc", async () => {
    const status = await capture({ path: "/proc/self/status" }, { cwd: "/", project: undefined })
    expect(status).toMatchObject({ ok: true, content: { kind: "file" } })
    const lines = status.ok && status.content.kind === "file" ? status.content.lines : []
    expect(lines.some((line) => line.startsWith("Name:"))).toBe(true)
  })
})

describe("a text file's lines", () => {
  it("end at any line break, old Mac ones too", async ({ fixture }) => {
    writeFileSync(join(fixture.project, "cr.txt"), "one\rtwo\r\nthree\n")
    await expect(capture({ path: "cr.txt" }, fixture.place)).resolves.toMatchObject({
      content: { lines: ["one", "two", "three"] },
    })
  })
})
