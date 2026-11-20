import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  appendFileSync,
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  renameSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  itemContent,
  type AgentName,
  type CompanionChange,
  type ItemContent,
  type PageTrouble,
  modelLimits,
  pdfLimits,
  folderLimits,
} from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import { timing } from "../checkouts/git.js"
import type { Shell } from "../harnesses/shells.js"
import { describe, expect, it as base } from "../test.js"
import type { Resources } from "../testing/resources.js"
import { WorkspaceStore } from "../workspaces/store.js"
import type { PlanText } from "./content.js"
import { CompanionItems, type TerminalPlace } from "./items.js"
import { abbreviateHome } from "./path-field.js"

const gitInstalled = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

type Fixture = {
  directory: string
  store: WorkspaceStore
  sessionId: string
  /** Opens a terminal in the session, kept as the terminals keep one. */
  terminal: (handle: string, sessionId?: string) => TerminalPlace
  /** The terminal as its agent's activity now lists these shells (none: no agent is bound). */
  shell: (place: TerminalPlace, shells: readonly Shell[] | undefined) => TerminalPlace
  /** The terminal as it tells what its agent session wrote outside the folder it works in. */
  wrote: (
    place: TerminalPlace,
    agent: AgentName,
    folders: readonly { folder: string; at: number }[],
    transcript?: string,
  ) => TerminalPlace
  /** Closes a terminal as the terminals do: its items first, then its record. */
  close: (terminalId: string) => void
  items: CompanionItems
  /** What a text plan's live terminal has, as `livePlan` reads it. */
  live: Map<string, PlanText>
  /** The folders the harnesses keep for themselves, as `harnessBookkeeping` tells them. */
  bookkeeping: string[]
  /** The person's environment, as `environment` reads it: none of the machine's own. */
  environment: NodeJS.ProcessEnv
  /** How long a folder waits for a change its watch may not tell, which a test may shorten. */
  polls: { safety: number; unwatched: number }
  /** What `environment` was asked, which a read of a folder asks once each time. */
  asked: { environment: number }
  /** Run between the steps of a folder's read, which a test sets to change the folder there. */
  steps: { afterPlacing?: () => void; afterReading?: () => void }
  /** The files of changes read, by checkout, as `reads` keeps them. */
  marks: Map<string, Map<string, string>>
}

const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-items-")))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    const project = await store.createProject({ id: randomUUID(), name: "P", cwd: directory })
    const session = store.createSession({ id: randomUUID(), projectId: project.id, name: "S" })
    const places = new Map<string, TerminalPlace>()
    const live = new Map<string, PlanText>()
    const environment: NodeJS.ProcessEnv = {}
    // Polls far past any test, so what arrives within one can only be what the watch told; a test
    // that wants a poll to deliver shortens the one it means.
    const polls = { safety: 600_000, unwatched: 600_000 }
    const asked = { environment: 0 }
    const bookkeeping: string[] = []
    const steps: Fixture["steps"] = {}
    const marks = new Map<string, Map<string, string>>()
    const items = new CompanionItems({
      environment: () => ((asked.environment += 1), environment),
      reads: {
        marks: (root) => marks.get(root) ?? new Map(),
        mark: async (root, path, blob) => {
          marks.set(root, new Map([...(marks.get(root) ?? []), [path, blob]]))
        },
      },
      records: store,
      terminal: (terminalId) => places.get(terminalId),
      harnessBookkeeping: async () => bookkeeping,
      terminals: (sessionId) => [...places.values()].filter((each) => each.sessionId === sessionId),
      project: (sessionId) => (sessionId === session.id ? directory : undefined),
      livePlan: (item) => live.get(item.id),
      pollMs: 10,
      changesMs: 10,
      folderPolls: polls,
      folderSteps: {
        afterPlacing: () => steps.afterPlacing?.(),
        afterReading: () => steps.afterReading?.(),
      },
    })
    resources.defer(() => items.shutdown())
    const terminal = (handle: string, sessionId = session.id): TerminalPlace => {
      const place = {
        terminalId: randomUUID(),
        sessionId,
        handle,
        cwd: directory,
        project: directory,
      }
      store.saveTerminal({
        id: place.terminalId,
        sessionId,
        cwd: directory,
        agents: {},
        promptedAt: null,
        handle,
        naming: { person: null, opener: null, murmur: null, own: null, summary: null },
        openedBy: null,
        ledBy: null,
        command: null,
        lastProgram: null,
        work: null,
      })
      places.set(place.terminalId, place)
      return place
    }
    const close = (terminalId: string) => {
      items.terminalClosed(terminalId)
      places.delete(terminalId)
      store.removeTerminal(terminalId)
    }
    const shell = (place: TerminalPlace, shells: readonly Shell[] | undefined): TerminalPlace => {
      const moved = { ...place, shells: shells && { agent: "claude" as const, shells } }
      places.set(place.terminalId, moved)
      return moved
    }
    const wrote: Fixture["wrote"] = (place, agent, folders, transcript) => {
      const moved = { ...place, agent, wrote: folders, ...(transcript && { transcript }) }
      places.set(place.terminalId, moved)
      return moved
    }
    await use({
      directory,
      store,
      sessionId: session.id,
      terminal,
      shell,
      wrote,
      close,
      items,
      live,
      environment,
      bookkeeping,
      polls,
      asked,
      steps,
      marks,
    })
  },
})

/** Reads a stream's next value. */
const next = async <T>(stream: AsyncGenerator<T>): Promise<T | undefined> =>
  (await stream.next()).value as T | undefined

/** A file's lines, as its content gives them. */
const lines = (content: ItemContent | undefined) =>
  content?.state === "ready" && content.content.kind === "file" ? content.content.lines : []

/** Collects every change `watch` reports, read as they come. */
const watching = (items: CompanionItems) => {
  const controller = new AbortController()
  const seen: CompanionChange[] = []
  const reading = (async () => {
    for await (const change of items.watch("owner", controller.signal)) seen.push(change)
  })()
  return {
    seen,
    stop: async () => {
      controller.abort()
      await reading
    },
  }
}

describe("what an agent closes", () => {
  it("takes its own item off its bar, by the file or page it showed", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "const a = 1\n")
    const moth = fixture.terminal("moth")
    await fixture.items.show(moth, {
      file: { path: "a.ts", lines: { from: 1, to: 1 } },
    })
    await fixture.items.show(moth, {
      page: { url: "http://localhost:5173/" },
      title: "Preview",
    })
    const { seen, stop } = watching(fixture.items)
    await expect(fixture.items.closeShown(moth, { file: { path: "./a.ts" } })).resolves.toEqual({
      ok: true,
      name: "a.ts",
      kind: "file",
    })
    await expect(
      fixture.items.closeShown(moth, { page: { url: "http://localhost:5173" } }),
    ).resolves.toEqual({
      ok: true,
      name: "Preview",
      kind: "page",
    })
    expect(fixture.items.bar(moth.terminalId)).toEqual([])
    await stop()
    expect(seen.filter((change) => change.type === "itemRemoved")).toHaveLength(2)
  })

  it("closes a file that has since gone, by the path it was shown at", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "tmp.png"), "")
    const moth = fixture.terminal("moth")
    await fixture.items.show(moth, { file: { path: "tmp.png" } })
    rmSync(join(fixture.directory, "tmp.png"))
    await expect(
      fixture.items.closeShown(moth, { file: { path: "tmp.png" } }),
    ).resolves.toMatchObject({
      ok: true,
      name: "tmp.png",
    })
    expect(fixture.items.bar(moth.terminalId)).toEqual([])
  })

  it("closes a gone file shown through a symlinked folder, by that path", async ({ fixture }) => {
    mkdirSync(join(fixture.directory, "real"))
    symlinkSync(join(fixture.directory, "real"), join(fixture.directory, "link"))
    writeFileSync(join(fixture.directory, "real", "shot.png"), "")
    const moth = fixture.terminal("moth")
    await fixture.items.show(moth, { file: { path: "link/shot.png" } })
    expect(fixture.items.bar(moth.terminalId)[0]?.path).toBe(
      join(fixture.directory, "real", "shot.png"),
    )
    rmSync(join(fixture.directory, "real", "shot.png"))
    await expect(
      fixture.items.closeShown(moth, { file: { path: "link/shot.png" } }),
    ).resolves.toEqual({
      ok: true,
      name: "shot.png",
      kind: "image",
    })
    expect(fixture.items.bar(moth.terminalId)).toEqual([])
  })

  it("no longer reaches its item once the person moved it elsewhere", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "const a = 1\n")
    const moth = fixture.terminal("moth")
    const fox = fixture.terminal("fox")
    const shown = await fixture.items.show(moth, { file: { path: "a.ts" } })
    const id = shown.ok ? shown.id : ""
    fixture.items.undock(id, randomUUID())
    await expect(fixture.items.closeShown(moth, { file: { path: "a.ts" } })).resolves.toMatchObject(
      {
        ok: false,
        reason: expect.stringContaining('"a.ts" was moved by the user into a window of its own'),
      },
    )
    fixture.items.move(id, fox.terminalId)
    await expect(fixture.items.closeShown(moth, { file: { path: "a.ts" } })).resolves.toMatchObject(
      {
        ok: false,
        reason: expect.stringContaining('"a.ts" was moved by the user to @fox'),
      },
    )
    await expect(fixture.items.closeShown(fox, { file: { path: "a.ts" } })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("placed beside you from @moth"),
    })
    expect(fixture.items.bar(fox.terminalId)).toHaveLength(1)
  })

  it("leaves what it didn't show, and says whose it is", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "const a = 1\n")
    writeFileSync(join(fixture.directory, "b.ts"), "const b = 1\n")
    const moth = fixture.terminal("moth")
    const fox = fixture.terminal("fox")
    await fixture.items.attach({ terminalId: moth.terminalId, path: "a.ts" })
    const shown = await fixture.items.show(fox, { file: { path: "b.ts" } })
    fixture.items.move(shown.ok ? shown.id : "", moth.terminalId)
    await expect(fixture.items.closeShown(moth, { file: { path: "a.ts" } })).resolves.toEqual({
      ok: false,
      reason:
        '"a.ts" was attached by the user, so it isn\'t yours to close; tell the user if it ' +
        "should go.",
    })
    await expect(fixture.items.closeShown(moth, { file: { path: "b.ts" } })).resolves.toEqual({
      ok: false,
      reason:
        '"b.ts" was placed beside you from @fox, so it isn\'t yours to close; tell the user if ' +
        "it should go.",
    })
    await expect(fixture.items.closeShown(moth, { file: { path: "c.ts" } })).resolves.toEqual({
      ok: false,
      reason: 'Nothing is showing beside your terminal at "c.ts"; showing lists what is.',
    })
    await expect(
      fixture.items.closeShown(moth, { page: { url: "file:///etc/passwd" } }),
    ).resolves.toMatchObject({
      ok: false,
    })
    expect(fixture.items.bar(moth.terminalId)).toHaveLength(2)
  })
})

describe("what an agent shows", () => {
  it("updates what it showed where the person moved it, a window or another bar", async ({
    fixture,
  }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    writeFileSync(join(fixture.directory, "b.ts"), "b\n")
    writeFileSync(join(fixture.directory, "c.ts"), "c\n")
    const moth = fixture.terminal("moth")
    const fox = fixture.terminal("fox")
    const a = await fixture.items.show(moth, { file: { path: "a.ts" } })
    const b = await fixture.items.show(moth, { file: { path: "b.ts" } })
    const c = await fixture.items.attach({ terminalId: moth.terminalId, path: "c.ts" })
    const aId = a.ok ? a.id : ""
    const bId = b.ok ? b.id : ""
    const windowId = randomUUID()
    fixture.items.undock(aId, windowId)
    fixture.items.move(bId, fox.terminalId)
    fixture.items.undock(c.id, randomUUID())
    const watch = watching(fixture.items)
    await expect(
      fixture.items.show(moth, { file: { path: "a.ts" }, title: "Renamed", open: true }),
    ).resolves.toMatchObject({
      id: aId,
      again: true,
      opened: false,
      moved: "into a window of its own",
    })
    await expect(
      fixture.items.show(moth, { file: { path: "b.ts" }, open: true }),
    ).resolves.toMatchObject({ id: bId, again: true, opened: true, moved: "to @fox" })
    expect(fixture.items.bar(moth.terminalId)).toEqual([])
    expect(fixture.items.list(fixture.sessionId)).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: aId, holder: { windowId }, name: "Renamed", version: 2 }),
        expect.objectContaining({ id: bId, holder: { terminalId: fox.terminalId }, version: 2 }),
      ]),
      windows: expect.arrayContaining([
        expect.objectContaining({ id: windowId, title: "Renamed" }),
      ]),
    })
    // The window it renamed says so.
    await expect
      .poll(() => watch.seen)
      .toContainEqual({ type: "window", window: expect.objectContaining({ title: "Renamed" }) })
    await watch.stop()
    expect(fixture.items.listing(moth.terminalId)).toBe(
      [
        "Showing beside your terminal in Novadeck (2):",
        `- file "Renamed": ${join(fixture.directory, "a.ts")} (moved by the user into a window of its own, shown by you)`,
        `- file "b.ts": ${join(fixture.directory, "b.ts")} (moved by the user to @fox, shown by you)`,
      ].join("\n"),
    )
    // What the person attached, or another terminal's agent shows, is its own.
    await expect(fixture.items.show(moth, { file: { path: "c.ts" } })).resolves.toMatchObject({
      again: false,
    })
    await expect(fixture.items.show(fox, { file: { path: "a.ts" } })).resolves.toMatchObject({
      again: false,
    })
  })

  it("keeps a server on this machine one page at any route, and any page one at any anchor", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    const site = await fixture.items.show(moth, {
      page: { url: "http://localhost:4323/download" },
    })
    const siteId = site.ok ? site.id : ""
    for (const url of [
      "http://localhost:4323/download#linux",
      "http://127.0.0.1:4323/#faq",
      "http://[::1]:4323/?q=1",
      "http://0.0.0.0:4323",
      "http://[::]:4323/docs",
    ])
      // eslint-disable-next-line no-await-in-loop -- Each show updates what the one before kept.
      await expect(fixture.items.show(moth, { page: { url } })).resolves.toMatchObject({
        id: siteId,
        again: true,
      })
    const artifact = await fixture.items.show(moth, {
      page: { url: "https://claude.ai/artifact/A" },
    })
    await expect(
      fixture.items.show(moth, { page: { url: "https://claude.ai/artifact/A#opt-e" } }),
    ).resolves.toMatchObject({ id: artifact.ok ? artifact.id : "", again: true })
    // Another port or scheme of this machine, or another route elsewhere, is another page.
    for (const url of [
      "http://localhost:4330/",
      "https://localhost:4323/",
      "https://claude.ai/artifact/B",
      "https://claude.ai/artifact/A?v=2",
    ])
      // eslint-disable-next-line no-await-in-loop -- Each show adds beside the one before.
      await expect(fixture.items.show(moth, { page: { url } })).resolves.toMatchObject({
        again: false,
      })
    expect(fixture.items.bar(moth.terminalId)).toHaveLength(6)
    expect(fixture.items.bar(moth.terminalId)[0]).toMatchObject({
      id: siteId,
      url: "http://[::]:4323/docs",
      version: 6,
    })
    await expect(
      fixture.items.closeShown(moth, { page: { url: "http://127.0.0.1:4323/elsewhere" } }),
    ).resolves.toMatchObject({ ok: true, kind: "page" })
    expect(fixture.items.bar(moth.terminalId).map(({ id }) => id)).not.toContain(siteId)
  })

  it("lands on its own bar, and showing it again updates it there", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "const a = 1\n")
    const moth = fixture.terminal("moth")
    const first = await fixture.items.show(moth, {
      file: { path: "a.ts", lines: { from: 1, to: 1 } },
    })
    expect(first).toEqual({
      ok: true,
      id: expect.any(String),
      kind: "file",
      name: "a.ts",
      opened: false,
      again: false,
    })
    const again = await fixture.items.show(moth, {
      file: { path: "a.ts" },
      title: "Mine",
      open: true,
    })
    expect(again).toMatchObject({ ok: true, name: "Mine", opened: true, again: true })
    expect(fixture.items.bar(moth.terminalId)).toEqual([
      {
        id: first.ok ? first.id : "",
        sessionId: fixture.sessionId,
        holder: { terminalId: moth.terminalId },
        kind: "file",
        name: "Mine",
        detail: "a.ts",
        path: join(fixture.directory, "a.ts"),
        url: null,
        lines: null,
        secret: false,
        by: "agent",
        from: { terminalId: moth.terminalId, handle: "moth" },
        version: 2,
        openAsked: true,
        shownAt: expect.any(Number),
        plan: null,
      },
    ])
  })

  it("is any file or page that can be an item, with no cap, refusing only what can't be", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    writeFileSync(join(fixture.directory, "a.bin"), Buffer.from([0, 1, 2]))
    writeFileSync(join(fixture.directory, ".env"), "TOKEN=x\n")
    writeFileSync(join(fixture.directory, "big.png"), Buffer.alloc(8 * 1024 * 1024 + 1))
    for (let index = 0; index < 70; index += 1)
      writeFileSync(join(fixture.directory, `f${index}.txt`), `${index}\n`)
    for (let index = 0; index < 70; index += 1)
      // eslint-disable-next-line no-await-in-loop -- One show after another.
      await fixture.items.show(moth, { file: { path: `f${index}.txt` } })
    await expect(fixture.items.show(moth, { file: { path: "a.bin" } })).resolves.toMatchObject({
      ok: true,
    })
    // Asked to open, but it may hold secrets: it waits for the person.
    await expect(
      fixture.items.show(moth, { file: { path: ".env" }, open: true }),
    ).resolves.toMatchObject({
      ok: true,
      opened: false,
      secret: true,
    })
    await expect(fixture.items.show(moth, { file: { path: "big.png" } })).resolves.toMatchObject({
      ok: true,
      kind: "image",
      tooLarge: true,
    })
    await expect(
      fixture.items.show(moth, { page: { url: "http://localhost:5173/" }, title: "Preview" }),
    ).resolves.toMatchObject({ ok: true, kind: "page", name: "Preview" })
    await expect(fixture.items.show(moth, { file: { path: "gone.txt" } })).resolves.toEqual({
      ok: false,
      reason: "That file doesn't exist.",
    })
    await expect(
      fixture.items.show(moth, { page: { url: "file:///etc/passwd" } }),
    ).resolves.toMatchObject({
      ok: false,
    })
    expect(fixture.items.bar(moth.terminalId)).toHaveLength(74)
  })

  it("is listed for its agent with where each item points and who put it there", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    const fox = fixture.terminal("fox")
    expect(fixture.items.listing(moth.terminalId)).toBe(
      "Nothing is showing beside your terminal in Novadeck.",
    )
    mkdirSync(join(fixture.directory, "src"))
    writeFileSync(join(fixture.directory, "hero.png"), "png")
    writeFileSync(join(fixture.directory, "src", "store.ts"), "x\n")
    writeFileSync(join(fixture.directory, ".env"), "x\n")
    await fixture.items.show(moth, { file: { path: "hero.png" } })
    await fixture.items.attach({
      terminalId: moth.terminalId,
      path: "src/store.ts",
      lines: { from: 40, to: 80 },
    })
    await fixture.items.attach({ terminalId: moth.terminalId, path: ".env" })
    const page = await fixture.items.show(fox, {
      page: { url: "http://localhost:5173/" },
      title: "Preview",
    })
    fixture.items.move(page.ok ? page.id : "", moth.terminalId)
    expect(fixture.items.listing(moth.terminalId)).toBe(
      [
        "Showing beside your terminal in Novadeck (4):",
        `- image "hero.png": ${join(fixture.directory, "hero.png")} (shown by you)`,
        `- file "store.ts" lines 40–80: ${join(fixture.directory, "src", "store.ts")} (attached by the user)`,
        `- file ".env": ${join(fixture.directory, ".env")} (attached by the user; may hold secrets)`,
        '- page "Preview": http://localhost:5173/ (placed here from @fox, shown by its agent)',
      ].join("\n"),
    )
  })
})

describe("what the person attaches", () => {
  it("takes over a held file an agent showed, and keeps it when the agent shows it again", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    writeFileSync(join(fixture.directory, ".env"), "TOKEN=x\n")
    await fixture.items.show(moth, { file: { path: ".env" } })
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ by: "agent", secret: true }])
    await fixture.items.attach({ terminalId: moth.terminalId, path: ".env" })
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([
      { by: "person", openAsked: true, secret: true, version: 2 },
    ])
    await fixture.items.show(moth, { file: { path: ".env" } })
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([
      { by: "person", openAsked: false, version: 3 },
    ])
    await expect(fixture.items.closeShown(moth, { file: { path: ".env" } })).resolves.toMatchObject(
      {
        ok: false,
      },
    )
    expect(fixture.items.bar(moth.terminalId)).toHaveLength(1)
  })

  it("is a file on a terminal's bar, refused as INVALID_FILE when it is no file", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    writeFileSync(join(fixture.directory, "notes.md"), "# Notes\n")
    await expect(
      fixture.items.attach({ terminalId: moth.terminalId, path: "notes.md", title: "Notes" }),
    ).resolves.toMatchObject({ name: "Notes", by: "person", openAsked: true, version: 1 })
    await expect(
      fixture.items.attach({ terminalId: moth.terminalId, path: "gone.md" }),
    ).rejects.toMatchObject({ code: "INVALID_FILE", message: "That file doesn't exist." })
    await expect(
      fixture.items.attach({ terminalId: randomUUID(), path: "notes.md" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
  })
})

describe("what the person types in a folder's path field", () => {
  // A folder of its own outside the project's, removed when the test ends.
  const away = (resources: Resources, name: string) => {
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-outside-")))
    resources.defer(() => rmSync(outside, { recursive: true, force: true }))
    return join(outside, name)
  }

  it("opens a path with a tilde from the home folder, a folder as a folder item", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    mkdirSync(join(fixture.directory, "Downloads"))
    writeFileSync(join(fixture.directory, "notes.md"), "# Notes\n")
    vi.stubEnv("HOME", fixture.directory)
    vi.stubEnv("USERPROFILE", fixture.directory)
    try {
      await expect(
        fixture.items.attach({ terminalId: moth.terminalId, path: "~/Downloads" }),
      ).resolves.toMatchObject({ kind: "folder", path: join(fixture.directory, "Downloads") })
      await expect(
        fixture.items.attach({ terminalId: moth.terminalId, path: "~/notes.md" }),
      ).resolves.toMatchObject({ kind: "file", path: join(fixture.directory, "notes.md") })
      await expect(
        fixture.items.attach({ terminalId: moth.terminalId, path: "~/missing" }),
      ).rejects.toMatchObject({ code: "INVALID_FILE" })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("names the folders it may be, marking one a folder item already shows", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    mkdirSync(join(fixture.directory, "render"))
    mkdirSync(join(fixture.directory, "release"))
    await fixture.items.attach({ terminalId: moth.terminalId, path: "render" })
    await expect(
      fixture.items.folders({ terminalId: moth.terminalId, path: "re" }),
    ).resolves.toEqual([
      { path: "release", real: join(fixture.directory, "release"), count: 0, open: false },
      { path: "render", real: join(fixture.directory, "render"), count: 0, open: true },
    ])
    await expect(
      fixture.items.folders({ terminalId: randomUUID(), path: "re" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
  })

  it("names no folder the person's environment moves a tool's logins to", async ({ fixture }) => {
    const moth = fixture.terminal("moth")
    mkdirSync(join(fixture.directory, "keys"))
    mkdirSync(join(fixture.directory, "keep"))
    fixture.environment.DOCKER_CONFIG = join(fixture.directory, "keys")
    await expect(
      fixture.items.folders({ terminalId: moth.terminalId, path: "k" }),
    ).resolves.toEqual([
      { path: "keep", real: join(fixture.directory, "keep"), count: 0, open: false },
    ])
  })

  it("lists the folders outside the project its session's agents wrote in, whichever the harness", async ({
    fixture,
    resources,
  }) => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((name) => away(resources, name))
    for (const folder of [a!, b!, c!, d!]) mkdirSync(folder)
    mkdirSync(join(fixture.directory, "inside"))
    const moth = fixture.wrote(fixture.terminal("moth"), "claude", [
      { folder: a!, at: 10 },
      { folder: join(fixture.directory, "inside"), at: 99 },
    ])
    fixture.wrote(fixture.terminal("raven"), "codex", [{ folder: b!, at: 30 }])
    fixture.wrote(fixture.terminal("kite"), "agy", [{ folder: c!, at: 20 }])
    const other = fixture.store.createSession({
      id: randomUUID(),
      projectId: fixture.store.session(fixture.sessionId).projectId,
      name: "Other",
    })
    fixture.wrote(fixture.terminal("owl", other.id), "claude", [{ folder: d!, at: 40 }])
    // Shown with `~` for the home, which a machine's temporary folder may lie in (as on Windows).
    const shown = (real: string) => ({ path: abbreviateHome(real), real })
    await expect(fixture.items.wroteTo({ terminalId: moth.terminalId })).resolves.toEqual([
      { ...shown(b!), handle: "raven", agent: "codex", at: 30 },
      { ...shown(c!), handle: "kite", agent: "agy", at: 20 },
      { ...shown(a!), handle: "moth", agent: "claude", at: 10 },
    ])
    // What a harness keeps in its own home is not the agent's work for the person.
    fixture.bookkeeping.push(b!)
    const without = await fixture.items.wroteTo({ terminalId: moth.terminalId })
    expect(without.map(({ real }) => real)).toEqual([c, a])
    await expect(fixture.items.wroteTo({ terminalId: randomUUID() })).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
  })

  it("leaves out what a session's own home keeps, by its transcript, though no global folder names it", async ({
    fixture,
    resources,
  }) => {
    const moved = away(resources, "second-account")
    const plans = join(moved, "plans")
    const skills = join(moved, "skills")
    mkdirSync(plans, { recursive: true })
    mkdirSync(skills)
    const moth = fixture.wrote(
      fixture.terminal("moth"),
      "claude",
      [
        { folder: plans, at: 9 },
        { folder: skills, at: 8 },
      ],
      join(moved, "projects", "p", "s.jsonl"),
    )
    const found = await fixture.items.wroteTo({ terminalId: moth.terminalId })
    expect(found.map(({ path, real }) => [path, real])).toEqual([[abbreviateHome(skills), skills]])
  })
})

describe("a file pointed at another file", () => {
  const files = (directory: string) => {
    for (const [name, text] of [
      ["a.md", "alpha\n"],
      ["b.md", "bravo\n"],
      ["shot.png", "pixels"],
      ["clip.mp4", "frames"],
      [".env", "TOKEN=x\n"],
    ] as const)
      writeFileSync(join(directory, name), text)
    mkdirSync(join(directory, "inside"))
  }

  it("keeps its item, id and bar, and shows the new file as the person's own, asked open", async ({
    fixture,
  }) => {
    files(fixture.directory)
    const moth = fixture.terminal("moth")
    const first = await fixture.items.attach({ terminalId: moth.terminalId, path: "a.md" })
    const gone: string[] = []
    fixture.items.listen({ troubled: () => {}, gone: (item) => gone.push(item.path ?? "") })
    const controller = new AbortController()
    const stream = fixture.items.content(first.id, undefined, controller.signal)
    expect(lines(await next(stream))).toEqual(["alpha"])
    const before = Date.now()
    const second = await fixture.items.repoint({ itemId: first.id, path: "b.md" })
    expect(second).toMatchObject({
      id: first.id,
      holder: { terminalId: moth.terminalId },
      name: "b.md",
      path: join(fixture.directory, "b.md"),
      by: "person",
      version: 2,
      openAsked: true,
    })
    expect(second.shownAt).toBeGreaterThanOrEqual(before)
    expect(fixture.items.bar(moth.terminalId)).toEqual([second])
    expect(lines(await next(stream))).toEqual(["bravo"])
    // What the pane told of the earlier file is no longer news.
    expect(gone).toEqual([join(fixture.directory, "a.md")])
    controller.abort()
  })

  it("takes an absolute path, and points a file an agent showed at one of the person's", async ({
    fixture,
  }) => {
    files(fixture.directory)
    const moth = fixture.terminal("moth")
    await fixture.items.show(moth, { file: { path: "a.md" } })
    const [shown] = fixture.items.bar(moth.terminalId)
    expect(shown).toMatchObject({ by: "agent", openAsked: false })
    await expect(
      fixture.items.repoint({ itemId: shown!.id, path: join(fixture.directory, "b.md") }),
    ).resolves.toMatchObject({ id: shown!.id, name: "b.md", by: "person", openAsked: true })
  })

  it("is refused, saying why, for a file of another kind, a folder, no file or an item that is none", async ({
    fixture,
  }) => {
    files(fixture.directory)
    const moth = fixture.terminal("moth")
    const note = await fixture.items.attach({ terminalId: moth.terminalId, path: "a.md" })
    const folder = await fixture.items.attach({ terminalId: moth.terminalId, path: "inside" })
    await expect(
      fixture.items.repoint({ itemId: note.id, path: "shot.png" }),
    ).rejects.toMatchObject({
      code: "INVALID_FILE",
      message: 'That file\'s kind is "image", not "file".',
    })
    await expect(fixture.items.repoint({ itemId: note.id, path: "inside" })).rejects.toMatchObject({
      code: "INVALID_FILE",
      message: "A folder can't stand in for a file.",
    })
    await expect(fixture.items.repoint({ itemId: note.id, path: "gone.md" })).rejects.toMatchObject(
      { code: "INVALID_FILE", message: "That file doesn't exist." },
    )
    await expect(fixture.items.repoint({ itemId: folder.id, path: "b.md" })).rejects.toMatchObject({
      code: "INVALID_FILE",
    })
    expect(fixture.items.bar(moth.terminalId)).toEqual([
      expect.objectContaining({ id: note.id, name: "a.md", version: 1 }),
      expect.objectContaining({ id: folder.id, version: 1 }),
    ])
  })

  it("opens a file that may hold secrets onto its gate, as attaching it does", async ({
    fixture,
  }) => {
    files(fixture.directory)
    const moth = fixture.terminal("moth")
    const note = await fixture.items.attach({ terminalId: moth.terminalId, path: "a.md" })
    const held = await fixture.items.repoint({ itemId: note.id, path: ".env" })
    expect(held).toMatchObject({ name: ".env", secret: true, openAsked: true })
    await expect(fixture.items.load(note.id, false)).resolves.toMatchObject({
      state: "unavailable",
      reason: "secret",
    })
    // Pointed back at an open file, the gate goes.
    await expect(fixture.items.repoint({ itemId: note.id, path: "b.md" })).resolves.toMatchObject({
      secret: false,
    })
    expect(lines(await fixture.items.load(note.id, false))).toEqual(["bravo"])
  })

  it("replaces what the bar already holds of the new file, and is the item the bar keeps", async ({
    fixture,
  }) => {
    files(fixture.directory)
    const moth = fixture.terminal("moth")
    const first = await fixture.items.attach({ terminalId: moth.terminalId, path: "a.md" })
    const second = await fixture.items.attach({ terminalId: moth.terminalId, path: "b.md" })
    const watch = watching(fixture.items)
    const stepped = await fixture.items.repoint({ itemId: first.id, path: "b.md" })
    expect(fixture.items.bar(moth.terminalId)).toEqual([stepped])
    expect(stepped.id).toBe(first.id)
    expect(fixture.items.list(fixture.sessionId).items).toEqual([stepped])
    await vi.waitFor(() =>
      expect(watch.seen).toContainEqual({
        type: "itemRemoved",
        itemId: second.id,
        sessionId: fixture.sessionId,
      }),
    )
    await watch.stop()
  })

  it("points an undocked window's item, which keeps its window", async ({ fixture }) => {
    files(fixture.directory)
    const moth = fixture.terminal("moth")
    const note = await fixture.items.attach({ terminalId: moth.terminalId, path: "a.md" })
    const windowId = randomUUID()
    fixture.items.undock(note.id, windowId)
    await expect(fixture.items.repoint({ itemId: note.id, path: "b.md" })).resolves.toMatchObject({
      id: note.id,
      holder: { windowId },
      name: "b.md",
      version: 2,
    })
    expect(fixture.items.list(fixture.sessionId).windows).toMatchObject([
      { id: windowId, itemId: note.id, title: "b.md" },
    ])
  })

  it("leaves the project window's file to its window, and says an unknown item is none", async ({
    fixture,
  }) => {
    files(fixture.directory)
    const opened = await fixture.items.openInProject({
      sessionId: fixture.sessionId,
      path: "a.md",
      windowId: randomUUID(),
    })
    await expect(
      fixture.items.repoint({ itemId: opened.item.id, path: "b.md" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      fixture.items.repoint({ itemId: randomUUID(), path: "b.md" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(fixture.items.list(fixture.sessionId).items).toEqual([opened.item])
  })
})

describe("the project window", () => {
  it("is made by the first file opened in it, held by no terminal and shown by no agent", async ({
    fixture,
  }) => {
    mkdirSync(join(fixture.directory, "src"))
    writeFileSync(join(fixture.directory, "src", "a.ts"), "const a = 1\n")
    const windowId = randomUUID()
    const controller = new AbortController()
    const stream = fixture.items.watch("owner", controller.signal)
    await expect(next(stream)).resolves.toEqual({ type: "synced" })
    const opened = await fixture.items.openInProject({
      sessionId: fixture.sessionId,
      path: "src/a.ts",
      windowId,
    })
    expect(opened.item).toMatchObject({
      holder: { windowId },
      kind: "file",
      name: "a.ts",
      detail: join("src", "a.ts"),
      path: join(fixture.directory, "src", "a.ts"),
      secret: false,
      by: "person",
      from: null,
      version: 1,
      openAsked: true,
    })
    expect(opened.window).toEqual({
      id: windowId,
      sessionId: fixture.sessionId,
      home: "project",
      itemId: opened.item.id,
      title: "a.ts",
      titleSource: { kind: "default" },
    })
    expect(fixture.items.list(fixture.sessionId)).toEqual({
      items: [opened.item],
      windows: [opened.window],
    })
    await expect(next(stream)).resolves.toEqual({ type: "window", window: opened.window })
    await expect(next(stream)).resolves.toEqual({ type: "item", item: opened.item })
    controller.abort()
  })

  it("accepts an absolute path, and refuses what is no file or no session", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    const windowId = randomUUID()
    const sessionId = fixture.sessionId
    await expect(
      fixture.items.openInProject({ sessionId, path: ".", windowId }),
    ).rejects.toMatchObject({
      code: "INVALID_FILE",
      message: "A folder opens in a terminal's pane, not in a window.",
    })
    await expect(
      fixture.items.openInProject({ sessionId, path: "missing.ts", windowId }),
    ).rejects.toMatchObject({ code: "INVALID_FILE", message: "That file doesn't exist." })
    await expect(
      fixture.items.openInProject({ sessionId: randomUUID(), path: "a.ts", windowId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(fixture.items.list(sessionId)).toEqual({ items: [], windows: [] })
    await expect(
      fixture.items.openInProject({ sessionId, path: join(fixture.directory, "a.ts"), windowId }),
    ).resolves.toMatchObject({ item: { name: "a.ts", detail: "a.ts" } })
  })

  it("opens an absolute path outside the project's folder, as an agent's copy of a file main lacks is", async ({
    fixture,
  }) => {
    const elsewhere = mkdtempSync(join(tmpdir(), "novadeck-copy-"))
    try {
      writeFileSync(join(elsewhere, "new.ts"), "new\n")
      const opened = await fixture.items.openInProject({
        sessionId: fixture.sessionId,
        path: join(elsewhere, "new.ts"),
        windowId: randomUUID(),
      })
      expect(opened.item).toMatchObject({ kind: "file", name: "new.ts", secret: false })
      expect(opened.item.path).toContain("new.ts")
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it("points its one item at the next file, keeping its id", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "alpha\n")
    writeFileSync(join(fixture.directory, "b.ts"), "bravo\n")
    const sessionId = fixture.sessionId
    const windowId = randomUUID()
    const first = await fixture.items.openInProject({ sessionId, path: "a.ts", windowId })
    const gone: string[] = []
    fixture.items.listen({ troubled: () => {}, gone: (item) => gone.push(item.path ?? "") })
    const controller = new AbortController()
    const stream = fixture.items.content(first.item.id, undefined, controller.signal)
    expect(lines(await next(stream))).toEqual(["alpha"])

    const watch = new AbortController()
    const changes = fixture.items.watch("owner", watch.signal)
    // The window and item it holds, then that it is synced.
    await next(changes)
    await next(changes)
    await expect(next(changes)).resolves.toEqual({ type: "synced" })
    const second = await fixture.items.openInProject({
      sessionId,
      path: "b.ts",
      windowId: randomUUID(),
    })
    expect(second.item).toMatchObject({
      id: first.item.id,
      holder: { windowId },
      name: "b.ts",
      path: join(fixture.directory, "b.ts"),
      by: "person",
      from: null,
      version: 2,
      openAsked: true,
    })
    expect(second.window).toMatchObject({
      id: windowId,
      title: "b.ts",
      titleSource: { kind: "default" },
    })
    expect(lines(await next(stream))).toEqual(["bravo"])
    controller.abort()
    expect(gone).toEqual([join(fixture.directory, "a.ts")])
    await expect(next(changes)).resolves.toEqual({ type: "item", item: second.item })
    await expect(next(changes)).resolves.toEqual({ type: "window", window: second.window })
    watch.abort()
    expect(fixture.items.list(sessionId)).toEqual({
      items: [second.item],
      windows: [second.window],
    })
  })

  it("reveals a held file only while the window is pointed at the file asked for", async ({
    fixture,
  }) => {
    writeFileSync(join(fixture.directory, ".env"), "TOKEN=x\n")
    writeFileSync(join(fixture.directory, ".env.local"), "OTHER=y\n")
    const sessionId = fixture.sessionId
    const first = await fixture.items.openInProject({
      sessionId,
      path: ".env",
      windowId: randomUUID(),
    })
    const controller = new AbortController()
    const asked = join(fixture.directory, ".env")
    // The person revealed .env; that is not a reveal of the next file.
    const stream = fixture.items.content(first.item.id, asked, controller.signal)
    expect(lines(await next(stream))).toEqual(["TOKEN=x"])
    const other = await fixture.items.openInProject({
      sessionId,
      path: ".env.local",
      windowId: randomUUID(),
    })
    expect(other.item).toMatchObject({ secret: true, name: ".env.local" })
    await expect(next(stream)).resolves.toMatchObject({ state: "unavailable", reason: "secret" })
    // A stream asked for .env while the window shows .env.local starts held too: the
    // person's click may have raced the re-point.
    const late = fixture.items.content(first.item.id, asked, controller.signal)
    await expect(next(late)).resolves.toMatchObject({ state: "unavailable", reason: "secret" })
    // A reveal asked for .env.local reveals it.
    const there = join(fixture.directory, ".env.local")
    const revealing = fixture.items.content(first.item.id, there, controller.signal)
    expect(lines(await next(revealing))).toEqual(["OTHER=y"])
    // Pointed back at the file a stream was asked for, it reads revealed again.
    await fixture.items.openInProject({ sessionId, path: ".env", windowId: randomUUID() })
    expect(lines(await next(stream))).toEqual(["TOKEN=x"])
    controller.abort()
  })

  it("refuses a taken window id, and never makes a second window", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    const moth = fixture.terminal("moth")
    const sessionId = fixture.sessionId
    await expect(
      fixture.items.openInProject({ sessionId, path: "a.ts", windowId: moth.terminalId }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    const shown = await fixture.items.show(moth, { file: { path: "a.ts" } })
    const taken = randomUUID()
    fixture.items.undock(shown.ok ? shown.id : "", taken)
    await expect(
      fixture.items.openInProject({ sessionId, path: "a.ts", windowId: taken }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(fixture.items.list(sessionId).windows).toMatchObject([{ id: taken, home: "undocked" }])

    const first = await fixture.items.openInProject({
      sessionId,
      path: "a.ts",
      windowId: randomUUID(),
    })
    await fixture.items.openInProject({ sessionId, path: "a.ts", windowId: randomUUID() })
    expect(
      fixture.items.list(sessionId).windows.filter(({ home }) => home === "project"),
    ).toMatchObject([{ id: first.window.id }])
    expect(fixture.items.list(sessionId).items).toHaveLength(2)
  })

  it("is named by its file: renaming it or resetting its title is a CONFLICT", async ({
    fixture,
  }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    const windowId = randomUUID()
    const { window } = await fixture.items.openInProject({
      sessionId: fixture.sessionId,
      path: "a.ts",
      windowId,
    })
    expect(() => fixture.items.renameWindow(windowId, "Mine")).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(() => fixture.items.renameWindow(windowId, null)).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(fixture.items.list(fixture.sessionId).windows).toEqual([window])
  })

  it("keeps its item in it: no bar, no window of its own", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    const moth = fixture.terminal("moth")
    const { item } = await fixture.items.openInProject({
      sessionId: fixture.sessionId,
      path: "a.ts",
      windowId: randomUUID(),
    })
    expect(() => fixture.items.move(item.id, moth.terminalId)).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(() => fixture.items.undock(item.id, randomUUID())).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(fixture.items.list(fixture.sessionId).items).toEqual([item])
  })

  it("closes with its window, and the next file opened makes it again", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    const sessionId = fixture.sessionId
    const first = await fixture.items.openInProject({
      sessionId,
      path: "a.ts",
      windowId: randomUUID(),
    })
    fixture.items.close(first.item.id)
    expect(fixture.items.list(sessionId)).toEqual({ items: [], windows: [] })
    const windowId = randomUUID()
    const again = await fixture.items.openInProject({ sessionId, path: "a.ts", windowId })
    expect(again.item.id).not.toBe(first.item.id)
    expect(again).toMatchObject({ item: { version: 1 }, window: { id: windowId } })
  })

  it("is not an agent's: its show lands on its bar, and its terminal's closing leaves the window", async ({
    fixture,
  }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    const moth = fixture.terminal("moth")
    const opened = await fixture.items.openInProject({
      sessionId: fixture.sessionId,
      path: "a.ts",
      windowId: randomUUID(),
    })
    const shown = await fixture.items.show(moth, { file: { path: "a.ts" } })
    expect(shown).toMatchObject({ ok: true, again: false })
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ by: "agent", version: 1 }])
    expect(fixture.items.list(fixture.sessionId).items).toContainEqual(opened.item)
    // It is listed and closed as what is on the bar, never as the window's file.
    expect(fixture.items.listing(moth.terminalId)).toBe(
      [
        "Showing beside your terminal in Novadeck (1):",
        `- file "a.ts": ${join(fixture.directory, "a.ts")} (shown by you)`,
      ].join("\n"),
    )
    await expect(fixture.items.closeShown(moth, { file: { path: "a.ts" } })).resolves.toMatchObject(
      {
        ok: true,
      },
    )
    await expect(fixture.items.closeShown(moth, { file: { path: "a.ts" } })).resolves.toMatchObject(
      {
        ok: false,
      },
    )
    fixture.close(moth.terminalId)
    expect(fixture.items.list(fixture.sessionId)).toEqual({
      items: [opened.item],
      windows: [opened.window],
    })
    fixture.items.sessionsRemoved([fixture.sessionId])
    expect(fixture.items.list(fixture.sessionId)).toEqual({ items: [], windows: [] })
  })
})

describe("moving items", () => {
  it("moves between bars and windows, one holder at a time, replacing a bar's copy", async ({
    fixture,
  }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    const moth = fixture.terminal("moth")
    const fox = fixture.terminal("fox")
    const watch = watching(fixture.items)
    const shown = await fixture.items.show(moth, { file: { path: "a.ts" } })
    const copy = await fixture.items.show(fox, { file: { path: "a.ts" } })
    const itemId = shown.ok ? shown.id : ""
    const windowId = randomUUID()
    expect(fixture.items.undock(itemId, windowId)).toEqual({
      id: windowId,
      sessionId: fixture.sessionId,
      home: "undocked",
      itemId,
      title: "a.ts",
      titleSource: { kind: "default" },
    })
    expect(() => fixture.items.undock(itemId, windowId)).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    fixture.items.renameWindow(windowId, "Mine")
    expect(fixture.items.list(fixture.sessionId).windows).toMatchObject([
      { id: windowId, title: "Mine", titleSource: { kind: "person" } },
    ])
    // Docking it on fox replaces fox's own copy, and its window goes.
    expect(fixture.items.move(itemId, fox.terminalId)).toMatchObject({
      holder: { terminalId: fox.terminalId },
      from: { terminalId: moth.terminalId },
    })
    expect(fixture.items.list(fixture.sessionId)).toEqual({
      items: [expect.objectContaining({ id: itemId })],
      windows: [],
    })
    // The agent in moth shows it again: the moved one is updated where it is.
    const reshown = await fixture.items.show(moth, { file: { path: "a.ts" } })
    expect(reshown).toMatchObject({ id: itemId, again: true })
    expect(fixture.items.bar(moth.terminalId)).toEqual([])
    expect(fixture.items.bar(fox.terminalId)).toMatchObject([{ id: itemId, version: 2 }])
    // What the watch said, applied in order, is what the runner keeps.
    const reconciled = () => {
      const items = new Map<string, unknown>()
      const windows = new Map<string, unknown>()
      for (const change of watch.seen)
        if (change.type === "item") items.set(change.item.id, change.item)
        else if (change.type === "itemRemoved") items.delete(change.itemId)
        else if (change.type === "window") windows.set(change.window.id, change.window)
        else if (change.type === "windowRemoved") windows.delete(change.windowId)
      return { items: [...items.values()], windows: [...windows.values()] }
    }
    const kept = fixture.items.list(fixture.sessionId)
    await expect.poll(reconciled).toEqual({
      items: expect.arrayContaining(kept.items),
      windows: kept.windows,
    })
    expect(reconciled().items).toHaveLength(1)
    expect(kept.items.map(({ id }) => id)).not.toContain(copy.ok ? copy.id : "")
    await watch.stop()
  })

  it("refuses an unknown item or terminal, and another session's terminal", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    const moth = fixture.terminal("moth")
    const other = fixture.store.createSession({
      id: randomUUID(),
      projectId: fixture.store.session(fixture.sessionId).projectId,
      name: "Other",
    })
    const elsewhere = fixture.terminal("moth", other.id)
    const shown = await fixture.items.show(moth, { file: { path: "a.ts" } })
    const itemId = shown.ok ? shown.id : ""
    expect(() => fixture.items.move(randomUUID(), moth.terminalId)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    expect(() => fixture.items.move(itemId, randomUUID())).toThrow(
      expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
    )
    expect(() => fixture.items.move(itemId, elsewhere.terminalId)).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(() => fixture.items.renameWindow(randomUUID(), "x")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    // A terminal whose record is gone, though it is still looked up, is not found.
    const gone = fixture.terminal("fox")
    fixture.store.removeTerminal(gone.terminalId)
    expect(() => fixture.items.move(itemId, gone.terminalId)).toThrow(
      expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
    )
    await expect(
      fixture.items.attach({ terminalId: gone.terminalId, path: "a.ts" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    await expect(fixture.items.show(gone, { file: { path: "a.ts" } })).resolves.toEqual({
      ok: false,
      reason: "Novadeck couldn't show it.",
    })
  })

  it("reports a window ahead of the item it holds, renamed or not", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "n.md"), "# N\n")
    const moth = fixture.terminal("moth")
    const controller = new AbortController()
    const stream = fixture.items.watch("owner", controller.signal)
    await expect(next(stream)).resolves.toEqual({ type: "synced" })
    const shown = await fixture.items.show(moth, { file: { path: "n.md" } })
    const itemId = shown.ok ? shown.id : ""
    await expect(next(stream)).resolves.toMatchObject({ type: "item" })
    const windowId = randomUUID()
    fixture.items.undock(itemId, windowId)
    fixture.items.renameWindow(windowId, "Renamed")
    await expect(next(stream)).resolves.toMatchObject({
      type: "window",
      window: { id: windowId, title: "Renamed" },
    })
    await expect(next(stream)).resolves.toMatchObject({
      type: "item",
      item: { id: itemId, holder: { windowId } },
    })
    controller.abort()
  })

  it("closes an item with its window, and a terminal's items with it, windows staying", async ({
    fixture,
  }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    writeFileSync(join(fixture.directory, "b.ts"), "b\n")
    const moth = fixture.terminal("moth")
    const a = await fixture.items.show(moth, { file: { path: "a.ts" } })
    const b = await fixture.items.show(moth, { file: { path: "b.ts" } })
    const windowId = randomUUID()
    fixture.items.undock(b.ok ? b.id : "", windowId)
    fixture.close(moth.terminalId)
    expect(fixture.items.list(fixture.sessionId)).toMatchObject({
      items: [{ id: b.ok ? b.id : "", holder: { windowId } }],
      windows: [{ id: windowId }],
    })
    fixture.items.close(b.ok ? b.id : "")
    fixture.items.close(a.ok ? a.id : "")
    expect(fixture.items.list(fixture.sessionId)).toEqual({ items: [], windows: [] })
  })
})

describe("an item's content", () => {
  it("is read now, again as it changes, and ends once the item is deleted", async ({ fixture }) => {
    const path = join(fixture.directory, "a.ts")
    writeFileSync(path, "one\n")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "a.ts" } })
    const itemId = shown.ok ? shown.id : ""
    const stream = fixture.items.content(itemId, undefined)
    expect(lines(await next(stream))).toEqual(["one"])
    writeFileSync(path, "one\ntwo\n")
    expect(lines(await next(stream))).toEqual(["one", "two"])
    // Shown again with other lines, it yields again though the file is the same.
    await fixture.items.show(moth, { file: { path: "a.ts", lines: { from: 2, to: 2 } } })
    await expect(next(stream)).resolves.toMatchObject({ content: { from: 2, to: 2 } })
    const ending = stream.next()
    fixture.items.close(itemId)
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
    await expect(fixture.items.load(itemId, false)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("stamps a page within what the protocol takes, however long its address", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    const url = `http://localhost:5173/${"long/".repeat(60)}`
    const shown = await fixture.items.show(moth, { page: { url } })
    const content = await fixture.items.load(shown.ok ? shown.id : "", false)
    expect(content).toMatchObject({ state: "ready", content: { kind: "page", url } })
    expect(itemContent.parse(content)).toEqual(content)
  })

  it("loads a page with the show it's from, and the scroll only that show gave", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    const url = "http://localhost:5173/"
    const shown = await fixture.items.show(moth, { page: { url, scroll: "#pricing" } })
    const itemId = shown.ok ? shown.id : ""
    const first = await fixture.items.load(itemId, false)
    expect(first).toEqual({
      state: "ready",
      stamp: expect.any(String),
      content: { kind: "page", url, shown: 1, scroll: "#pricing" },
    })
    expect(itemContent.parse(first)).toEqual(first)
    await fixture.items.show(moth, { page: { url } })
    const second = await fixture.items.load(itemId, false)
    expect(second).toEqual({
      state: "ready",
      stamp: expect.any(String),
      content: { kind: "page", url, shown: 2 },
    })
    // Each show is content of its own, at the same address.
    expect(second.state === "ready" && second.stamp).not.toBe(
      first.state === "ready" && first.stamp,
    )
    await fixture.items.show(moth, { page: { url, scroll: "[data-section=faq]" } })
    fixture.items.close(itemId)
    const again = await fixture.items.show(moth, { page: { url } })
    // A new item for the same page starts over.
    await expect(fixture.items.load(again.ok ? again.id : "", false)).resolves.toEqual({
      state: "ready",
      stamp: expect.any(String),
      content: { kind: "page", url, shown: 1 },
    })
  })

  it("plays a video from the second only the show that gave it starts at", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "demo.mp4"), "frames")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "demo.mp4", at: 12.5 } })
    expect(shown).toMatchObject({ ok: true, kind: "video", name: "demo.mp4" })
    const itemId = shown.ok ? shown.id : ""
    expect(fixture.items.list(fixture.sessionId).items).toEqual([
      expect.objectContaining({ id: itemId, kind: "video", detail: "6 B MP4" }),
    ])
    const first = await fixture.items.load(itemId, false)
    expect(first).toEqual({
      state: "ready",
      stamp: expect.any(String),
      content: { kind: "video", mime: "video/mp4", size: 6, shown: 1, at: 12.5 },
    })
    expect(itemContent.parse(first)).toEqual(first)
    // Shown again without one, it plays on from where the person is.
    await fixture.items.show(moth, { file: { path: "demo.mp4" } })
    await expect(fixture.items.load(itemId, false)).resolves.toEqual({
      state: "ready",
      stamp: expect.any(String),
      content: { kind: "video", mime: "video/mp4", size: 6, shown: 2 },
    })
    const stamp = first.state === "ready" ? first.stamp : ""
    await expect(fixture.items.part({ itemId, stamp, offset: 0 })).resolves.toEqual({
      state: "part",
      data: Buffer.from("frames").toString("base64"),
    })
    writeFileSync(join(fixture.directory, "demo.mp4"), "frames, rendered again")
    await expect(fixture.items.part({ itemId, stamp, offset: 0 })).resolves.toEqual({
      state: "changed",
    })
  })

  it("names an image by its format, a JFIF file as JPEG", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "photo.jfif"), "pixels")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "photo.jfif" } })
    expect(shown).toMatchObject({ ok: true, kind: "image", name: "photo.jfif" })
    expect(fixture.items.list(fixture.sessionId).items).toEqual([
      expect.objectContaining({ kind: "image", detail: "6 B JPEG" }),
    ])
  })

  it("plays a recording as a video is played, from its parts", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "take.mp3"), "sound")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "take.mp3", at: 1 } })
    expect(shown).toMatchObject({ ok: true, kind: "audio", name: "take.mp3" })
    const itemId = shown.ok ? shown.id : ""
    expect(fixture.items.list(fixture.sessionId).items).toEqual([
      expect.objectContaining({ id: itemId, kind: "audio", detail: "5 B MP3" }),
    ])
    const loaded = await fixture.items.load(itemId, false)
    expect(loaded).toMatchObject({
      state: "ready",
      content: { kind: "audio", mime: "audio/mpeg", size: 5, shown: 1, at: 1 },
    })
    expect(itemContent.parse(loaded)).toEqual(loaded)
    const stamp = loaded.state === "ready" ? loaded.stamp : ""
    await expect(fixture.items.part({ itemId, stamp, offset: 0 })).resolves.toEqual({
      state: "part",
      data: Buffer.from("sound").toString("base64"),
    })
  })

  it("starts only a video at a second, and reads parts of nothing else", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    const moth = fixture.terminal("moth")
    await expect(fixture.items.show(moth, { file: { path: "a.ts", at: 3 } })).resolves.toEqual({
      ok: false,
      reason:
        "Only a video or a recording starts at a second; give at only for a video or audio file.",
    })
    const shown = await fixture.items.show(moth, { file: { path: "a.ts" } })
    await expect(
      fixture.items.part({ itemId: shown.ok ? shown.id : "", stamp: "", offset: 0 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      fixture.items.part({ itemId: randomUUID(), stamp: "", offset: 0 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("reads no part of a video that may hold secrets until the person shows its path", async ({
    fixture,
  }) => {
    mkdirSync(join(fixture.directory, ".ssh"))
    const path = join(fixture.directory, ".ssh", "clip.mp4")
    writeFileSync(path, "frames")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path } })
    expect(shown).toMatchObject({ ok: true, kind: "video", secret: true })
    const itemId = shown.ok ? shown.id : ""
    const held = await fixture.items.load(itemId, true)
    const stamp = held.state === "ready" ? held.stamp : ""
    await expect(fixture.items.part({ itemId, stamp, offset: 0 })).resolves.toEqual({
      state: "unavailable",
      reason: "secret",
    })
    await expect(
      fixture.items.part({ itemId, stamp, offset: 0, reveal: path }),
    ).resolves.toMatchObject({ state: "part" })
  })

  it("shows a PDF by its size, its bytes read in parts, and refuses a secret one's parts", async ({
    fixture,
  }) => {
    writeFileSync(join(fixture.directory, "report.pdf"), "%PDF-1.4")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "report.pdf" } })
    expect(shown).toMatchObject({ ok: true, kind: "pdf", name: "report.pdf" })
    expect(shown).not.toHaveProperty("tooLarge")
    const itemId = shown.ok ? shown.id : ""
    expect(fixture.items.list(fixture.sessionId).items).toEqual([
      expect.objectContaining({ id: itemId, kind: "pdf", detail: "8 B PDF" }),
    ])
    const loaded = await fixture.items.load(itemId, false)
    expect(loaded).toEqual({
      state: "ready",
      stamp: expect.any(String),
      content: { kind: "pdf", size: 8 },
    })
    expect(itemContent.parse(loaded)).toEqual(loaded)
    const stamp = loaded.state === "ready" ? loaded.stamp : ""
    await expect(fixture.items.part({ itemId, stamp, offset: 0 })).resolves.toEqual({
      state: "part",
      data: Buffer.from("%PDF-1.4").toString("base64"),
    })
    await expect(
      fixture.items.show(moth, { file: { path: "report.pdf", at: 3 } }),
    ).resolves.toEqual({
      ok: false,
      reason:
        "Only a video or a recording starts at a second; give at only for a video or audio file.",
    })
    mkdirSync(join(fixture.directory, ".ssh"))
    const path = join(fixture.directory, ".ssh", "keys.pdf")
    writeFileSync(path, "%PDF-1.4")
    const held = await fixture.items.show(moth, { file: { path } })
    expect(held).toMatchObject({ ok: true, kind: "pdf", secret: true })
    const heldId = held.ok ? held.id : ""
    await expect(fixture.items.load(heldId, false)).resolves.toMatchObject({ reason: "secret" })
    const revealed = await fixture.items.load(heldId, true)
    await expect(
      fixture.items.part({
        itemId: heldId,
        stamp: revealed.state === "ready" ? revealed.stamp : "",
        offset: 0,
      }),
    ).resolves.toEqual({ state: "unavailable", reason: "secret" })
  })

  it("shows a 3D model by its format and size, and reads the files it names by name", async ({
    fixture,
  }) => {
    const folder = fixture.directory
    writeFileSync(join(folder, "scene.bin"), "binary")
    writeFileSync(join(folder, ".env"), "TOKEN=x\n")
    writeFileSync(join(folder, "other.txt"), "not named")
    writeFileSync(
      join(folder, "scene.gltf"),
      JSON.stringify({ buffers: [{ uri: "scene.bin" }, { uri: ".env" }] }),
    )
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "scene.gltf" } })
    expect(shown).toMatchObject({ ok: true, kind: "model", name: "scene.gltf" })
    expect(shown).not.toHaveProperty("tooLarge")
    const itemId = shown.ok ? shown.id : ""
    expect(fixture.items.list(fixture.sessionId).items).toEqual([
      expect.objectContaining({ id: itemId, kind: "model", detail: "48 B glTF" }),
    ])
    const loaded = await fixture.items.load(itemId, false)
    expect(itemContent.parse(loaded)).toEqual(loaded)
    expect(loaded).toMatchObject({
      state: "ready",
      content: {
        kind: "model",
        format: "gltf",
        files: [{ name: "scene.bin", size: 6 }],
        refused: [{ name: ".env", reason: "secret" }],
      },
    })
    const content =
      loaded.state === "ready" && loaded.content.kind === "model" ? loaded.content : null
    const stamp = loaded.state === "ready" ? loaded.stamp : ""
    const bin = content!.files[0]!
    // The model's own bytes, and a file it names, as that file's stamp names it.
    await expect(fixture.items.part({ itemId, stamp, offset: 0 })).resolves.toMatchObject({
      state: "part",
    })
    await expect(
      fixture.items.part({ itemId, stamp: bin.stamp, offset: 0, file: "scene.bin" }),
    ).resolves.toEqual({ state: "part", data: Buffer.from("binary").toString("base64") })
    await expect(
      fixture.items.part({ itemId, stamp: bin.stamp, offset: 2, file: "scene.bin" }),
    ).resolves.toEqual({ state: "part", data: Buffer.from("nary").toString("base64") })
    // A file it doesn't list is not one it names, a secret one among them.
    for (const file of ["other.txt", ".env", "../x", "scene.gltf"])
      // eslint-disable-next-line no-await-in-loop -- One file after another.
      await expect(fixture.items.part({ itemId, stamp, offset: 0, file })).rejects.toMatchObject({
        code: "NOT_FOUND",
      })
    // Changed since it was listed: its stamp no longer names it.
    writeFileSync(join(folder, "scene.bin"), "binary, written again")
    await expect(
      fixture.items.part({ itemId, stamp: bin.stamp, offset: 0, file: "scene.bin" }),
    ).resolves.toEqual({ state: "changed" })
  })

  it("lists what a model names as its file is now, once it is written again", async ({
    fixture,
  }) => {
    const folder = fixture.directory
    writeFileSync(join(folder, "a.bin"), "a")
    writeFileSync(join(folder, "b.bin"), "b")
    writeFileSync(join(folder, "scene.gltf"), JSON.stringify({ buffers: [{ uri: "a.bin" }] }))
    const shown = await fixture.items.show(fixture.terminal("moth"), {
      file: { path: "scene.gltf" },
    })
    const itemId = shown.ok ? shown.id : ""
    await fixture.items.load(itemId, false)
    writeFileSync(
      join(folder, "scene.gltf"),
      JSON.stringify({ buffers: [{ uri: "a.bin" }, { uri: "b.bin" }] }),
    )
    const b = await fixture.items.load(itemId, false)
    const listed = b.state === "ready" && b.content.kind === "model" ? b.content.files : []
    expect(listed.map((file) => file.name)).toEqual(["a.bin", "b.bin"])
    await expect(
      fixture.items.part({ itemId, stamp: listed[1]!.stamp, offset: 0, file: "b.bin" }),
    ).resolves.toEqual({ state: "part", data: Buffer.from("b").toString("base64") })
  })

  it("reads a model again when only a file beside it is written again", async ({ fixture }) => {
    const folder = fixture.directory
    writeFileSync(join(folder, "scene.bin"), "first")
    writeFileSync(join(folder, "scene.gltf"), JSON.stringify({ buffers: [{ uri: "scene.bin" }] }))
    const shown = await fixture.items.show(fixture.terminal("moth"), {
      file: { path: "scene.gltf" },
    })
    const itemId = shown.ok ? shown.id : ""
    const stream = fixture.items.content(itemId, undefined)
    const stampOfBin = (content: ItemContent | undefined) =>
      content?.state === "ready" && content.content.kind === "model"
        ? content.content.files[0]?.stamp
        : undefined
    const first = stampOfBin(await next(stream))
    // An exporter's buffer, written again with its glTF left as it was.
    writeFileSync(join(folder, "scene.bin"), "second, longer")
    const second = await next(stream)
    expect(stampOfBin(second)).not.toBe(first)
    await expect(
      fixture.items.part({ itemId, stamp: stampOfBin(second)!, offset: 0, file: "scene.bin" }),
    ).resolves.toEqual({ state: "part", data: Buffer.from("second, longer").toString("base64") })
    const ending = stream.next()
    fixture.items.close(itemId)
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
  })

  it("keeps a model's content within what the protocol takes, however long a name in it", async ({
    fixture,
  }) => {
    writeFileSync(
      join(fixture.directory, "scene.gltf"),
      JSON.stringify({ buffers: [{ uri: "a".repeat(5000) }] }),
    )
    const shown = await fixture.items.show(fixture.terminal("moth"), {
      file: { path: "scene.gltf" },
    })
    const loaded = await fixture.items.load(shown.ok ? shown.id : "", false)
    expect(itemContent.parse(loaded)).toEqual(loaded)
    expect(loaded).toMatchObject({ content: { refused: [{ reason: "unreadable" }] } })
  })

  it("refuses a part by file of an item that is no model", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "report.pdf"), "%PDF-1.4")
    writeFileSync(join(fixture.directory, "note.txt"), "hi")
    const moth = fixture.terminal("moth")
    for (const path of ["report.pdf", "note.txt"]) {
      // eslint-disable-next-line no-await-in-loop -- One file after another.
      const shown = await fixture.items.show(moth, { file: { path } })
      const itemId = shown.ok ? shown.id : ""
      // eslint-disable-next-line no-await-in-loop -- As above.
      await expect(
        fixture.items.part({ itemId, stamp: "x", offset: 0, file: path }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
    }
  })

  it("lists a model past what the pane takes by its name, and says so", async ({ fixture }) => {
    const path = join(fixture.directory, "huge.stl")
    const handle = openSync(path, "w")
    ftruncateSync(handle, modelLimits.bytes + 1)
    closeSync(handle)
    const shown = await fixture.items.show(fixture.terminal("moth"), { file: { path: "huge.stl" } })
    expect(shown).toMatchObject({ ok: true, kind: "model", tooLarge: true })
    await expect(fixture.items.load(shown.ok ? shown.id : "", false)).resolves.toEqual({
      state: "unavailable",
      reason: "too-large",
      size: modelLimits.bytes + 1,
    })
  })

  it("lists a PDF past what the pane takes by its name, and says so", async ({ fixture }) => {
    const path = join(fixture.directory, "scan.pdf")
    const handle = openSync(path, "w")
    ftruncateSync(handle, pdfLimits.bytes + 1)
    closeSync(handle)
    const shown = await fixture.items.show(fixture.terminal("moth"), { file: { path: "scan.pdf" } })
    expect(shown).toMatchObject({ ok: true, kind: "pdf", tooLarge: true })
    await expect(fixture.items.load(shown.ok ? shown.id : "", false)).resolves.toEqual({
      state: "unavailable",
      reason: "too-large",
      size: pdfLimits.bytes + 1,
    })
  })

  it("holds a file that may hold secrets until revealed", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, ".env"), "TOKEN=x\n")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: ".env" } })
    const itemId = shown.ok ? shown.id : ""
    await expect(fixture.items.load(itemId, false)).resolves.toEqual({
      state: "unavailable",
      reason: "secret",
      size: 8,
    })
    await expect(fixture.items.load(itemId, true)).resolves.toMatchObject({ state: "ready" })
  })

  it("holds a login where the person's environment says a tool keeps it", async ({ fixture }) => {
    const moved = join(fixture.directory, "work")
    mkdirSync(moved)
    writeFileSync(join(moved, "hosts.yml"), "held\n")
    const moth = fixture.terminal("moth")
    const path = join("work", "hosts.yml")
    // A plain name, opened as asked, until a variable says the tool's logins are there.
    await expect(fixture.items.show(moth, { file: { path }, open: true })).resolves.toMatchObject({
      ok: true,
      opened: true,
    })
    fixture.environment.GH_CONFIG_DIR = moved
    const shown = await fixture.items.show(moth, { file: { path }, open: true })
    expect(shown).toMatchObject({ ok: true, opened: false, secret: true })
    await expect(fixture.items.load(shown.ok ? shown.id : "", false)).resolves.toMatchObject({
      state: "unavailable",
      reason: "secret",
    })
  })
})

describe("plans beside their terminal", () => {
  const slot = { agent: "claude", agentSession: "s1", actor: null } as const

  it("mirror each slot's latest plan, new only when observed later than before", async ({
    fixture,
  }) => {
    const path = join(fixture.directory, "brave-fox.md")
    writeFileSync(path, "# Fix the login redirect\n")
    const moth = fixture.terminal("moth")
    const plan = { source: { kind: "file", path } as const, path }
    await fixture.items.planObserved(moth, slot, plan, 100)
    const [item] = fixture.items.bar(moth.terminalId)
    expect(item).toMatchObject({
      kind: "plan",
      name: "Fix the login redirect",
      detail: path,
      path,
      version: 1,
      plan: { agent: "claude", role: "root", source: "file" },
    })
    // A replay, as after a restart, marks nothing new.
    await fixture.items.planObserved(moth, slot, plan, 100)
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ id: item!.id, version: 1 }])
    writeFileSync(path, "# Fix the redirect, take two\n")
    await fixture.items.planObserved(moth, slot, plan, 200)
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([
      { id: item!.id, version: 2, name: "Fix the redirect, take two" },
    ])
    await expect(fixture.items.load(item!.id, false)).resolves.toMatchObject({
      content: { kind: "plan", text: "# Fix the redirect, take two\n" },
    })
    // An older observation of another file, as a late replay, changes nothing.
    const older = join(fixture.directory, "older.md")
    writeFileSync(older, "# Older\n")
    await fixture.items.planObserved(
      moth,
      slot,
      { source: { kind: "file", path: older }, path: older },
      150,
    )
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([
      { id: item!.id, version: 2, name: "Fix the redirect, take two", path },
    ])
    expect(fixture.items.listing(moth.terminalId)).toBe(
      [
        "Showing beside your terminal in Novadeck (1):",
        `- plan "Fix the redirect, take two": ${path} (your plan)`,
      ].join("\n"),
    )
  })

  it("open only plans observed live, never replays of older ones", async ({ fixture }) => {
    const path = join(fixture.directory, "live.md")
    writeFileSync(path, "# Live\n")
    const moth = fixture.terminal("moth")
    const plan = { source: { kind: "file", path } as const, path }
    const now = Date.now()
    // Read back long after it was written, as on a restart: kept, not asked.
    await fixture.items.planObserved(moth, slot, plan, now - 3_600_000)
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ version: 1, openAsked: false }])
    // Rewritten live: a new version, but a rewrite never asks to open again.
    await fixture.items.planObserved(moth, slot, plan, now)
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ version: 2, openAsked: false }])
    // A replay of that same observation changes nothing.
    await fixture.items.planObserved(moth, slot, plan, now)
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ version: 2, openAsked: false }])
    // A first-seen live plan asks to open as well. It shares moth's slot, so it is seen after
    // moth's: one no later is a replay of it, as the same millisecond on a fast runner was.
    const other = join(fixture.directory, "other.md")
    writeFileSync(other, "# Other\n")
    const fox = fixture.terminal("fox")
    await fixture.items.planObserved(
      fox,
      slot,
      { source: { kind: "file", path: other }, path: other },
      now + 1,
    )
    expect(fixture.items.bar(fox.terminalId)).toMatchObject([{ version: 1, openAsked: true }])
    // Its live rewrites clear the ask rather than re-opening the pane.
    await fixture.items.planObserved(
      fox,
      slot,
      { source: { kind: "file", path: other }, path: other },
      now + 2,
    )
    expect(fixture.items.bar(fox.terminalId)).toMatchObject([{ version: 2, openAsked: false }])
  })

  it("do not reopen a closed plan, nor open a subagent's", async ({ fixture }) => {
    const path = join(fixture.directory, "closed.md")
    writeFileSync(path, "# Closed\n")
    const moth = fixture.terminal("moth")
    const plan = { source: { kind: "file", path } as const, path }
    const sub = { ...slot, actor: "sub" } as const
    await fixture.items.planObserved(moth, sub, plan, Date.now())
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ openAsked: false }])
    await fixture.items.planObserved(moth, slot, plan, Date.now())
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([
      { openAsked: false },
      { openAsked: true },
    ])
    const [, root] = fixture.items.bar(moth.terminalId)
    fixture.items.close(root!.id)
    await fixture.items.planObserved(moth, slot, plan, Date.now() + 1)
    expect(fixture.items.bar(moth.terminalId).at(-1)).toMatchObject({
      version: 1,
      openAsked: false,
    })
  })

  it("update a plan where the person moved it", async ({ fixture }) => {
    const path = join(fixture.directory, "p.md")
    writeFileSync(path, "# P\n")
    const moth = fixture.terminal("moth")
    const plan = { source: { kind: "file", path } as const, path }
    await fixture.items.planObserved(moth, slot, plan, 1)
    const [item] = fixture.items.bar(moth.terminalId)
    const windowId = randomUUID()
    fixture.items.undock(item!.id, windowId)
    writeFileSync(path, "# Take two\n")
    await fixture.items.planObserved(moth, slot, plan, 2)
    expect(fixture.items.bar(moth.terminalId)).toEqual([])
    expect(fixture.items.list(fixture.sessionId)).toMatchObject({
      items: [{ id: item!.id, holder: { windowId }, name: "Take two", version: 2 }],
      windows: [{ id: windowId, title: "Take two" }],
    })
  })

  it("go from their own bar once another session binds there, moved ones staying", async ({
    fixture,
  }) => {
    const path = join(fixture.directory, "p.md")
    writeFileSync(path, "# P\n")
    const moth = fixture.terminal("moth")
    const fox = fixture.terminal("fox")
    const plan = { source: { kind: "file", path } as const, path }
    await fixture.items.planObserved(moth, slot, plan, 1)
    await fixture.items.planObserved(moth, { ...slot, actor: "sub" }, plan, 1)
    const [root, sub] = fixture.items.bar(moth.terminalId)
    expect(sub).toMatchObject({ plan: { role: "subagent" } })
    fixture.items.move(sub!.id, fox.terminalId)
    // Moved away, the replay of what it holds adds nothing to the origin bar.
    await fixture.items.planObserved(moth, { ...slot, actor: "sub" }, plan, 1)
    expect(fixture.items.bar(moth.terminalId)).toEqual([root])
    fixture.items.sessionBound(moth.terminalId, "s1")
    expect(fixture.items.bar(moth.terminalId)).toEqual([root])
    fixture.items.sessionBound(moth.terminalId, "s2")
    expect(fixture.items.bar(moth.terminalId)).toEqual([])
    expect(fixture.items.bar(fox.terminalId)).toMatchObject([{ id: sub!.id }])
    // A plan of the earlier session, observed as the new one bound, is not mirrored.
    await fixture.items.planObserved(moth, slot, plan, 2)
    expect(fixture.items.bar(moth.terminalId)).toEqual([])
  })

  it("presented as text point at the agent's own record, read back once the terminal is gone", async ({
    fixture,
  }) => {
    const transcript = join(fixture.directory, "session.jsonl")
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-30T08:00:00Z",
        message: {
          content: [
            { type: "tool_use", name: "ExitPlanMode", input: { plan: "# From the transcript" } },
          ],
        },
      })}\n`,
    )
    const moth = fixture.terminal("moth")
    const fox = fixture.terminal("fox")
    const source = {
      kind: "text",
      text: "# Live plan",
      truncated: false,
    } as const
    await fixture.items.planObserved(moth, slot, { source, path: transcript }, 1)
    const [item] = fixture.items.bar(moth.terminalId)
    expect(item).toMatchObject({
      name: "Live plan",
      path: transcript,
      plan: { source: "text" },
      detail: "In Claude Code's conversation",
    })
    expect(fixture.items.listing(moth.terminalId)).toContain(
      '- plan "Live plan" (in your conversation)',
    )
    // While its terminal runs the session, what it has live comes first.
    fixture.live.set(item!.id, { text: "# Live plan", truncated: false, changedAt: 1 })
    await expect(fixture.items.load(item!.id, false)).resolves.toMatchObject({
      content: { text: "# Live plan" },
    })
    // Moved away and its terminal closed, the transcript still has it.
    fixture.items.move(item!.id, fox.terminalId)
    fixture.live.clear()
    fixture.close(moth.terminalId)
    await expect(fixture.items.load(item!.id, false)).resolves.toMatchObject({
      state: "ready",
      content: { kind: "plan", text: "# From the transcript" },
    })
    expect(fixture.items.listing(fox.terminalId)).toContain(
      `- plan "Live plan": ${transcript} (placed here from @moth, its agent's plan)`,
    )
  })
})

describe("what the pane tells of a page", () => {
  const trouble: PageTrouble[] = [{ kind: "load", text: "ERR_CONNECTION_REFUSED" }]

  /** Shows a page, and collects the troubles the terminals would hear of and the items they lose. */
  const hearing = async (fixture: Fixture, url = "http://localhost:5173/") => {
    const heard: { itemId: string; version: number; terminalId: string }[] = []
    const gone: string[] = []
    fixture.items.listen({
      troubled: (item) =>
        heard.push({ itemId: item.id, version: item.version, terminalId: item.from!.terminalId }),
      gone: (item) => gone.push(item.id),
    })
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { page: { url } })
    return { heard, gone, moth, id: shown.ok ? shown.id : "" }
  }

  it("goes to the terminal the page was shown from, once it is the latest show", async ({
    fixture,
  }) => {
    const { heard, moth, id } = await hearing(fixture)
    fixture.items.pageTrouble({ itemId: id, shown: 1, troubles: trouble })
    expect(heard).toEqual([{ itemId: id, version: 1, terminalId: moth.terminalId }])
    // Moved elsewhere, it is still told to the terminal it came from.
    const other = fixture.terminal("fox")
    fixture.items.move(id, other.terminalId)
    fixture.items.pageTrouble({ itemId: id, shown: 1, troubles: trouble })
    expect(heard.at(-1)).toMatchObject({ terminalId: moth.terminalId })
  })

  it("is let be for an unknown item, a stale show, a page elsewhere or a file", async ({
    fixture,
  }) => {
    const { heard, moth, id } = await hearing(fixture)
    await fixture.items.show(moth, { page: { url: "http://localhost:5173/" } })
    fixture.items.pageTrouble({ itemId: id, shown: 1, troubles: trouble })
    fixture.items.pageTrouble({ itemId: randomUUID(), shown: 1, troubles: trouble })
    const remote = await fixture.items.show(moth, { page: { url: "https://example.com/" } })
    fixture.items.pageTrouble({ itemId: remote.ok ? remote.id : "", shown: 1, troubles: trouble })
    writeFileSync(join(fixture.directory, "a.ts"), "const a = 1\n")
    const file = await fixture.items.show(moth, { file: { path: "a.ts" } })
    fixture.items.pageTrouble({ itemId: file.ok ? file.id : "", shown: 1, troubles: trouble })
    expect(heard).toEqual([])
    fixture.items.pageTrouble({ itemId: id, shown: 2, troubles: trouble })
    expect(heard).toHaveLength(1)
  })

  it("is let be for a page that is not the agent's", async ({ fixture }) => {
    const { heard, id } = await hearing(fixture)
    fixture.store.saveItem({ ...fixture.store.item(id)!, by: "person" })
    fixture.items.pageTrouble({ itemId: id, shown: 1, troubles: trouble })
    expect(heard).toEqual([])
  })

  it("is heard for a page served from this machine under any of its names", async ({ fixture }) => {
    const { heard, moth } = await hearing(fixture)
    for (const url of [
      "http://127.0.0.1:1/",
      "http://[::1]:2/",
      "http://0.0.0.0:3/",
      "http://[::]:4/",
    ]) {
      // eslint-disable-next-line no-await-in-loop -- Each page is shown before it is told of.
      const shown = await fixture.items.show(moth, { page: { url } })
      fixture.items.pageTrouble({ itemId: shown.ok ? shown.id : "", shown: 1, troubles: trouble })
    }
    expect(heard).toHaveLength(4)
  })

  it("lets its terminal know when an item is closed or shown again", async ({ fixture }) => {
    const { gone, moth, id } = await hearing(fixture)
    await fixture.items.show(moth, { page: { url: "http://localhost:5173/" } })
    expect(gone).toEqual([id])
    fixture.items.close(id)
    expect(gone).toEqual([id, id])
  })
})

// Windows names a folder in any case, and git may spell it otherwise than the system does.
const folder = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path)

describe.skipIf(!gitInstalled)("the changes of a repository", () => {
  // A read slower than a second waits four times as long before the next, up to 15 s, and a
  // loaded machine makes a read that slow: under load here a change's first read took 1.6 to 2 s
  // and so waited 6.2 to 8 s, and Test (macOS) ran a test past its 20 s. Every test that reads a
  // change again waits at most 1.5 s here, which still shows a slow read waiting longer.
  beforeEach(() => {
    timing.maxWaitMs = 1_500
  })
  afterEach(() => {
    timing.maxWaitMs = 15_000
  })

  /** A repository with one commit and a change on top of it, and a terminal working in it. */
  const repository = (fixture: Fixture) => {
    const root = join(fixture.directory, "work")
    mkdirSync(root)
    // A global configuration of its own, beside the repository: git opens no null device on Windows.
    const config = join(fixture.directory, "gitconfig")
    writeFileSync(config, "[core]\n\tautocrlf = false\n")
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=T",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" } },
      )
    git("init", "--quiet")
    // The reader runs with the person's configuration, which may convert line endings.
    git("config", "core.autocrlf", "false")
    writeFileSync(join(root, "a.txt"), "one\n")
    git("add", "-A")
    git("commit", "--quiet", "-m", "base")
    writeFileSync(join(root, "a.txt"), "one\ntwo\n")
    return { root, git, place: { ...fixture.terminal("moth"), cwd: root } }
  }

  it("is one item per repository, updated by showing again, and closed the same way", async ({
    fixture,
  }) => {
    const { root, place } = repository(fixture)
    const first = await fixture.items.show(place, { changes: {} })
    expect(first).toMatchObject({ ok: true, kind: "changes", again: false })
    const item = fixture.items.bar(place.terminalId)[0]
    expect(folder(item?.path ?? "")).toBe(folder(root))
    expect(item).toMatchObject({
      kind: "changes",
      url: null,
      lines: null,
      name: "Changes · work",
      detail: "1 file · +1 −0",
      version: 1,
    })
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n")
    const again = await fixture.items.show(place, { changes: {}, title: "My work" })
    expect(again).toMatchObject({ ok: true, again: true, name: "My work" })
    expect(fixture.items.bar(place.terminalId)).toMatchObject([
      { version: 2, detail: "1 file · +2 −0" },
    ])
    expect(folder(fixture.items.listing(place.terminalId))).toContain(
      folder(`changes "My work": ${root}`),
    )
    await expect(fixture.items.closeShown(place, { changes: {} })).resolves.toMatchObject({
      ok: true,
      kind: "changes",
    })
    expect(fixture.items.bar(place.terminalId)).toEqual([])
    await expect(fixture.items.closeShown(place, { changes: {} })).resolves.toMatchObject({
      ok: false,
    })
  })

  it("is one item per linked worktree, each named by its branch, waiting unopened", async ({
    fixture,
  }) => {
    const { git, place } = repository(fixture)
    const trees = ["one", "two"].map((name) => {
      // The same folder name for both, as Novadeck's worktrees of one repository have.
      const tree = join(fixture.directory, name, "work")
      git("worktree", "add", "--quiet", "-b", `task/${name}`, tree)
      return tree
    })
    for (const tree of trees)
      // eslint-disable-next-line no-await-in-loop -- One after the other, as an agent opens them.
      await expect(fixture.items.show(place, { changes: { path: tree } })).resolves.toMatchObject({
        ok: true,
        opened: false,
      })
    expect(fixture.items.bar(place.terminalId)).toMatchObject([
      { kind: "changes", name: "Changes · work · task/one", openAsked: false },
      { kind: "changes", name: "Changes · work · task/two", openAsked: false },
    ])
    // A detached worktree has no branch to go by.
    git("-C", trees[1]!, "checkout", "--quiet", "--detach")
    await fixture.items.show(place, { changes: { path: trees[1]! } })
    expect(fixture.items.bar(place.terminalId)[1]).toMatchObject({ name: "Changes · work" })
  })

  it("is shown for Novadeck unless its agent showed it, and closed where its worktree went", async ({
    fixture,
  }) => {
    const { git, place } = repository(fixture)
    const tree = join(fixture.directory, "one", "work")
    git("worktree", "add", "--quiet", "-b", "v1", tree)
    // A tag of the branch's name doesn't make the name `heads/v1`.
    git("tag", "v1")
    // The agent asked to open it first: Novadeck's own show leaves that be.
    await fixture.items.show(place, { changes: { path: tree }, open: true })
    await expect(fixture.items.showChangesUnlessShown(place, tree)).resolves.toBeUndefined()
    expect(fixture.items.bar(place.terminalId)).toMatchObject([
      { name: "Changes · work · v1", openAsked: true, version: 1 },
    ])

    // Another bar has one of its own, as shown there; and one the person attached stays.
    const fox = { ...fixture.terminal("fox"), cwd: place.cwd }
    await expect(fixture.items.showChangesUnlessShown(fox, tree)).resolves.toMatchObject({
      ok: true,
      opened: false,
    })
    const owl = { ...fixture.terminal("owl"), cwd: place.cwd }
    await fixture.items.show(owl, { changes: { path: tree } })
    const owls = fixture.items.bar(owl.terminalId)[0]!
    fixture.store.saveItem({ ...fixture.store.item(owls.id)!, by: "person" })
    fixture.items.closeChangesOn(fox.terminalId, tree)
    fixture.items.closeChangesOn(owl.terminalId, tree)
    expect(fixture.items.bar(fox.terminalId)).toEqual([])
    expect(fixture.items.bar(owl.terminalId)).toHaveLength(1)

    // Its worktree gone, every item of it goes, and no other.
    await fixture.items.show(place, { changes: {} })
    fixture.items.closeChangesAt(tree)
    expect(fixture.items.bar(owl.terminalId)).toEqual([])
    expect(fixture.items.bar(place.terminalId)).toMatchObject([{ name: "Changes · work" }])
  })

  it("is one item per compare beside the working tree's, read from its refs, and closed by them", async ({
    fixture,
  }) => {
    const { root, git, place } = repository(fixture)
    const main = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root })
      .toString()
      .trim()
    git("stash", "--quiet")
    git("checkout", "--quiet", "-b", "feature")
    writeFileSync(join(root, "b.txt"), "b\n")
    git("add", "-A")
    git("commit", "--quiet", "-m", "Add b")
    const added = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim()
    git("checkout", "--quiet", main)
    git("stash", "pop", "--quiet")

    await fixture.items.show(place, { changes: {} })
    const shown = await fixture.items.show(place, { changes: { head: "feature" }, open: true })
    expect(shown).toMatchObject({ ok: true, kind: "changes", again: false, opened: true })
    expect(fixture.items.bar(place.terminalId)).toMatchObject([
      { name: "Changes · work", detail: "1 file · +1 −0" },
      { name: "Compare · work · feature", detail: "1 file · +1 −0" },
    ])
    // Its base is the repository's main branch, as it is named.
    expect(fixture.store.item(shown.ok ? shown.id : "")?.compare).toEqual({
      base: main,
      head: "feature",
    })
    const watch = new AbortController()
    const content = await next(
      fixture.items.content(shown.ok ? shown.id : "", undefined, watch.signal),
    )
    watch.abort()
    expect(content).toMatchObject({
      state: "ready",
      content: { kind: "changes", base: main, head: "feature", files: [{ path: "b.txt" }] },
    })
    expect(itemContent.parse(content)).toEqual(content)
    expect(
      content?.state === "ready" && content.content.kind === "changes"
        ? content.content.layers.map(({ id }) => id)
        : [],
    ).toEqual([added])
    const diff = await fixture.items.changeFile({
      itemId: shown.ok ? shown.id : "",
      path: "b.txt",
      layers: [added],
    })
    expect(diff.run).toMatchObject({ layers: [added], before: null, after: "b\n" })
    expect(fixture.items.listing(place.terminalId)).toContain(`compare: feature against ${main}`)

    // The same refs again update it; a ref that isn't there shows nothing.
    await expect(
      fixture.items.show(place, { changes: { base: main, head: "feature" } }),
    ).resolves.toMatchObject({ ok: true, again: true })
    await expect(fixture.items.show(place, { changes: { head: "nope" } })).resolves.toMatchObject({
      ok: false,
      reason: 'Git can\'t find "nope" in this repository.',
    })
    expect(fixture.items.bar(place.terminalId)).toHaveLength(2)

    // A file read in it reads as read there, and is no mark of the checkout's own.
    const reading = new AbortController()
    const stream = fixture.items.content(shown.ok ? shown.id : "", undefined, reading.signal)
    await next(stream)
    await fixture.items.changeRead({ itemId: shown.ok ? shown.id : "", path: "b.txt" })
    const marked = await next(stream)
    reading.abort()
    expect(
      marked?.state === "ready" && marked.content.kind === "changes" ? marked.content.read : [],
    ).toEqual(["b.txt"])
    expect([...fixture.marks.values()].flatMap((each) => [...each.keys()])).toEqual([])

    // Closed by its refs, leaving the working tree's.
    await expect(
      fixture.items.closeShown(place, { changes: { head: "feature" } }),
    ).resolves.toMatchObject({ ok: true, kind: "changes" })
    expect(fixture.items.bar(place.terminalId)).toMatchObject([{ name: "Changes · work" }])

    // The repository's worktree gone, its compares go with its own change.
    await fixture.items.show(place, { changes: { head: "feature" } })
    fixture.items.closeChangesAt(root)
    expect(fixture.items.bar(place.terminalId)).toEqual([])
  })

  it("gives one file's diff for a selection of layers, and refuses an item that is no change", async ({
    fixture,
  }) => {
    const { place } = repository(fixture)
    const shown = await fixture.items.show(place, { changes: {} })
    const itemId = shown.ok ? shown.id : ""
    const diff = await fixture.items.changeFile({
      itemId,
      path: "a.txt",
      layers: ["uncommitted"],
    })
    expect(diff.run).toMatchObject({
      layers: ["uncommitted"],
      before: "one\n",
      after: "one\ntwo\n",
      file: { added: 1 },
    })
    await expect(
      fixture.items.changeFile({ itemId: "nope", path: "a.txt", layers: ["uncommitted"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      fixture.items.changeRange({ itemId, layers: ["uncommitted"] }),
    ).resolves.toMatchObject({ files: [{ path: "a.txt", added: 1 }], truncated: false })
    await expect(
      fixture.items.changeRange({ itemId: "nope", layers: ["uncommitted"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    fixture.items.close(itemId)
  })

  it("marks a file read, which its content names until it changes", async ({ fixture }) => {
    const { root, place } = repository(fixture)
    const shown = await fixture.items.show(place, { changes: {} })
    const itemId = shown.ok ? shown.id : ""
    const stream = fixture.items.content(itemId, undefined)
    const read = (content: ItemContent | undefined) =>
      content?.state === "ready" && content.content.kind === "changes" ? content.content.read : []
    expect(read(await next(stream))).toEqual([])
    await fixture.items.changeRead({ itemId, path: "a.txt" })
    // A file the change does not list is not marked.
    await fixture.items.changeRead({ itemId, path: "nope.txt" })
    expect([...fixture.marks.values()].flatMap((each) => [...each.keys()])).toEqual(["a.txt"])
    expect(read(await next(stream))).toEqual(["a.txt"])
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n")
    expect(read(await next(stream))).toEqual([])
    await expect(fixture.items.changeRead({ itemId: "nope", path: "a.txt" })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    )
    fixture.items.close(itemId)
  })

  it("yields its content when the change changes, and not otherwise", async ({ fixture }) => {
    const { root, place } = repository(fixture)
    const shown = await fixture.items.show(place, { changes: {} })
    const itemId = shown.ok ? shown.id : ""
    const stream = fixture.items.content(itemId, undefined)
    const first = await next(stream)
    expect(first).toMatchObject({ state: "ready", content: { kind: "changes" } })
    expect(
      folder(
        first?.state === "ready" && first.content.kind === "changes" ? first.content.root : "",
      ),
    ).toBe(folder(root))
    expect(itemContent.parse(first)).toEqual(first)
    // Several reads pass with nothing new, and none of them yields.
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeFileSync(join(root, "b.txt"), "new\n")
    const second = await next(stream)
    expect(second).not.toMatchObject({ stamp: first && "stamp" in first ? first.stamp : "" })
    expect(second).toMatchObject({
      content: {
        layers: [
          { id: "uncommitted", files: [{ path: "a.txt" }, { path: "b.txt", status: "added" }] },
        ],
      },
    })
    // The item's detail follows what the reads find.
    expect(fixture.items.bar(place.terminalId)[0]?.detail).toBe("2 files · +2 −0")
    // A repository that goes is unavailable.
    rmSync(root, { recursive: true, force: true })
    await expect(next(stream)).resolves.toMatchObject({ state: "unavailable", reason: "missing" })
    fixture.items.close(itemId)
  })

  it("is refused, saying why, for a folder outside any repository", async ({ fixture }) => {
    const moth = fixture.terminal("moth")
    const refused = await fixture.items.show(moth, { changes: {} })
    expect(refused).toMatchObject({ ok: false })
    expect(refused.ok ? "" : refused.reason).toMatch(/git/)
    expect(fixture.items.bar(moth.terminalId)).toEqual([])
    await expect(fixture.items.closeShown(moth, { changes: {} })).resolves.toMatchObject({
      ok: false,
    })
  })

  it("shows the repository of a folder given as path, such as a worktree elsewhere", async ({
    fixture,
  }) => {
    const { git, place } = repository(fixture)
    const tree = join(fixture.directory, "wt")
    git("worktree", "add", "--quiet", "-b", "other", tree)
    writeFileSync(join(tree, "b.txt"), "in the worktree\n")
    // The terminal is in a folder that is no repository.
    const outside = { ...place, cwd: fixture.directory }
    expect(await fixture.items.show(outside, { changes: {} })).toMatchObject({ ok: false })
    expect(await fixture.items.show(outside, { changes: { path: "wt" } })).toMatchObject({
      ok: true,
      kind: "changes",
      name: "Changes · wt · other",
    })
    const item = fixture.items.bar(place.terminalId)[0]
    expect(folder(item?.path ?? "")).toBe(folder(tree))
    const content = await fixture.items.load(item?.id ?? "", false)
    expect(content).toMatchObject({
      state: "ready",
      content: {
        kind: "changes",
        layers: [{ id: "uncommitted", files: [{ path: "b.txt", status: "added" }] }],
      },
    })
    // The same path closes it; a path in no repository names nothing.
    await expect(fixture.items.closeShown(outside, { changes: {} })).resolves.toMatchObject({
      ok: false,
    })
    await expect(
      fixture.items.closeShown(outside, { changes: { path: join(tree, "..", "wt") } }),
    ).resolves.toMatchObject({ ok: true, kind: "changes" })
  })

  it("closes a change by the folder it was shown from after that folder is gone", async ({
    fixture,
  }) => {
    const { git, place } = repository(fixture)
    const tree = join(fixture.directory, "wt")
    git("worktree", "add", "--quiet", "-b", "other", tree)
    const outside = { ...place, cwd: fixture.directory }
    expect(await fixture.items.show(outside, { changes: { path: "wt" } })).toMatchObject({
      ok: true,
    })
    git("worktree", "remove", "--force", tree)
    await expect(
      fixture.items.closeShown(outside, { changes: { path: "wt" } }),
    ).resolves.toMatchObject({ ok: true, kind: "changes" })
    expect(fixture.items.bar(place.terminalId)).toEqual([])
  })

  // Reads of a change that fail, a number in a row, then succeed with something new: the
  // repository's HEAD is garbage until the read after the `failures`th starts.
  const afterFailures = async (fixture: Fixture, failures: number, again = false) => {
    const { root, place } = repository(fixture)
    const shown = await fixture.items.show(place, { changes: {} })
    const itemId = shown.ok ? shown.id : ""
    const stream = fixture.items.content(itemId, undefined)
    expect(await next(stream)).toMatchObject({ state: "ready" })
    const head = join(root, ".git", "HEAD")
    const good = readFileSync(head)
    writeFileSync(head, "garbage\n")
    let reads = 0
    timing.saw = (args) => {
      if (!args.includes("--show-toplevel")) return
      reads += 1
      if (reads === failures + 1) {
        writeFileSync(head, good)
        writeFileSync(join(root, "a.txt"), "one\ntwo\nrecovered\n")
      }
    }
    try {
      const first = await next(stream)
      return { first, second: again ? await next(stream) : undefined }
    } finally {
      timing.saw = undefined
      fixture.items.close(itemId)
    }
  }

  it("keeps the last good change through one failed read", async ({ fixture }) => {
    expect((await afterFailures(fixture, 1)).first).toMatchObject({ state: "ready" })
  })

  it("keeps the last good change through two failed reads in a row", async ({ fixture }) => {
    expect((await afterFailures(fixture, 2)).first).toMatchObject({ state: "ready" })
  })

  it("says a change is unreadable at the third failed read in a row", async ({ fixture }) => {
    const third = await afterFailures(fixture, 3, true)
    expect(third.first).toMatchObject({ state: "unavailable", reason: "unreadable" })
    expect(third.second).toMatchObject({ state: "ready" })
  })

  it("waits longer to read a change again after a slow read", async ({ fixture }) => {
    if (process.platform === "win32") return
    const { root, place, git } = repository(fixture)
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=slow\n")
    git("add", "-A")
    git("commit", "--quiet", "-m", "attributes")
    git("config", "filter.slow.clean", "sleep 0.3; cat")
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n")
    const shown = await fixture.items.show(place, { changes: {} })
    const stream = fixture.items.content(shown.ok ? shown.id : "", undefined)
    const starts: number[] = []
    timing.slowMs = 100
    timing.saw = (args) => {
      if (args.includes("--show-toplevel")) starts.push(Date.now())
    }
    try {
      await next(stream)
      writeFileSync(join(root, "b.txt"), "later\n")
      await next(stream)
    } finally {
      timing.slowMs = 1_000
      timing.saw = undefined
      fixture.items.close(shown.ok ? shown.id : "")
    }
    // The usual wait is 10 ms here; a read of 0.3 s waits four times as long, within the cap.
    expect(starts.length).toBeGreaterThanOrEqual(2)
    expect((starts.at(-1) ?? 0) - (starts.at(-2) ?? 0)).toBeGreaterThan(900)
  })
})

describe("background shells beside their terminal", () => {
  const running = (id: string, output?: string): Shell => ({
    id,
    command: `sleep ${id}`,
    since: 1,
    exit: null,
    ...(output !== undefined && { output }),
  })
  const ended = (shell: Shell, code: number | null): Shell => ({
    ...shell,
    exit: { at: 2, code },
  })
  const shellsOn = (fixture: Fixture, terminalId: string) =>
    fixture.items.bar(terminalId).filter(({ kind }) => kind === "shells")

  it("make one item on the bar as the first shell starts, which does not ask to open", ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    fixture.items.shellsObserved(fixture.shell(moth, []))
    expect(shellsOn(fixture, moth.terminalId)).toEqual([])
    fixture.items.shellsObserved(fixture.shell(moth, [running("1")]))
    expect(shellsOn(fixture, moth.terminalId)).toMatchObject([
      {
        kind: "shells",
        name: "Shells",
        detail: "1 running",
        by: "agent",
        from: { terminalId: moth.terminalId, handle: "moth" },
        path: null,
        url: null,
        version: 1,
        openAsked: false,
      },
    ])
  })

  it("follow how many run and fail, without a new version for an end", ({ fixture }) => {
    const moth = fixture.terminal("moth")
    const [one, two, three] = [running("1"), running("2"), running("3")] as const
    fixture.items.shellsObserved(fixture.shell(moth, [one, two, three]))
    expect(shellsOn(fixture, moth.terminalId)).toMatchObject([{ detail: "3 running", version: 1 }])
    fixture.items.shellsObserved(fixture.shell(moth, [ended(one, 1), two, three]))
    expect(shellsOn(fixture, moth.terminalId)).toMatchObject([
      { detail: "2 running · 1 failed", version: 1 },
    ])
    // An exit with no code is not a failure.
    fixture.items.shellsObserved(fixture.shell(moth, [ended(one, 0), ended(two, null), three]))
    expect(shellsOn(fixture, moth.terminalId)).toMatchObject([{ detail: "1 running" }])
    fixture.items.shellsObserved(
      fixture.shell(moth, [ended(one, 0), ended(two, null), ended(three, 0)]),
    )
    expect(shellsOn(fixture, moth.terminalId)).toMatchObject([{ detail: "ended", version: 1 }])
  })

  it("are tried again by the next fact when the item could not be saved", ({ fixture }) => {
    const moth = fixture.terminal("moth")
    const save = fixture.store.saveItem.bind(fixture.store)
    fixture.store.saveItem = () => {
      throw new Error("disk full")
    }
    try {
      fixture.items.shellsObserved(fixture.shell(moth, [running("1")]))
    } finally {
      fixture.store.saveItem = save
    }
    expect(shellsOn(fixture, moth.terminalId)).toEqual([])
    // The same shells again: the first save never counted them.
    fixture.items.shellsObserved(fixture.shell(moth, [running("1")]))
    expect(shellsOn(fixture, moth.terminalId)).toMatchObject([{ detail: "1 running" }])
  })

  it("are the agent's own to it, and another terminal's agent's by its handle", ({ fixture }) => {
    const moth = fixture.terminal("moth")
    const fox = fixture.terminal("fox")
    fixture.items.shellsObserved(fixture.shell(moth, [running("1")]))
    const [item] = shellsOn(fixture, moth.terminalId)
    expect(fixture.items.listing(moth.terminalId)).toContain("(your background shells,")
    fixture.items.move(item!.id, fox.terminalId)
    const listing = fixture.items.listing(fox.terminalId)
    expect(listing).toContain("@moth's background shells")
    expect(listing).not.toContain("your background shells")
  })

  it("show again as a later version when a new shell starts, not when one ends", ({ fixture }) => {
    const moth = fixture.terminal("moth")
    fixture.items.shellsObserved(fixture.shell(moth, [running("1")]))
    fixture.items.shellsObserved(fixture.shell(moth, [running("1"), running("2")]))
    expect(shellsOn(fixture, moth.terminalId)).toMatchObject([
      { detail: "2 running", version: 2, openAsked: false },
    ])
    // The same shells again change nothing.
    fixture.items.shellsObserved(fixture.shell(moth, [running("1"), running("2")]))
    expect(shellsOn(fixture, moth.terminalId)).toMatchObject([{ version: 2 }])
  })

  it("come back after the runner closed the item only with a new shell", ({ fixture }) => {
    const moth = fixture.terminal("moth")
    fixture.items.shellsObserved(fixture.shell(moth, [running("1")]))
    const [item] = shellsOn(fixture, moth.terminalId)
    fixture.items.close(item!.id)
    // A shell ending is no reason to bring it back.
    fixture.items.shellsObserved(fixture.shell(moth, [ended(running("1"), 0)]))
    expect(shellsOn(fixture, moth.terminalId)).toEqual([])
    fixture.items.shellsObserved(fixture.shell(moth, [ended(running("1"), 0), running("2")]))
    expect(shellsOn(fixture, moth.terminalId)).toMatchObject([{ detail: "1 running" }])
  })

  it("go when the agent lists none, another session binds, or the terminal closes", ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    const fox = fixture.terminal("fox")
    const owl = fixture.terminal("owl")
    for (const place of [moth, fox, owl])
      fixture.items.shellsObserved(fixture.shell(place, [running("1")]))
    // The agent went.
    fixture.items.shellsObserved(fixture.shell(moth, undefined))
    expect(shellsOn(fixture, moth.terminalId)).toEqual([])
    // A session bound.
    fixture.items.sessionBound(fox.terminalId, "s2")
    expect(shellsOn(fixture, fox.terminalId)).toEqual([])
    // The terminal closed.
    fixture.close(owl.terminalId)
    expect(fixture.items.list(fixture.sessionId).items).toEqual([])
    // Shells started again after a session bound are new.
    fixture.items.shellsObserved(fixture.shell(fox, [running("1")]))
    expect(shellsOn(fixture, fox.terminalId)).toMatchObject([{ version: 1 }])
  })

  it("go with the terminal even where the person moved the item to another bar", ({ fixture }) => {
    const moth = fixture.terminal("moth")
    const fox = fixture.terminal("fox")
    fixture.items.shellsObserved(fixture.shell(moth, [running("1")]))
    const [item] = shellsOn(fixture, moth.terminalId)
    fixture.items.move(item!.id, fox.terminalId)
    fixture.items.shellsObserved(fixture.shell(moth, [running("1"), running("2")]))
    expect(shellsOn(fixture, fox.terminalId)).toMatchObject([{ id: item!.id, version: 2 }])
    fixture.close(moth.terminalId)
    expect(fixture.items.list(fixture.sessionId).items).toEqual([])
  })

  it("are gone from a database an earlier run left them in", ({ fixture }) => {
    const moth = fixture.terminal("moth")
    fixture.items.shellsObserved(fixture.shell(moth, [running("1")]))
    const again = new CompanionItems({
      records: fixture.store,
      terminal: () => moth,
      project: () => fixture.directory,
    })
    try {
      expect(fixture.store.items().filter(({ kind }) => kind === "shells")).toEqual([])
    } finally {
      void again.shutdown()
    }
  })

  it("read as the shells of the agent bound there now, each with the end of its output", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    const log = join(fixture.directory, "one.log")
    writeFileSync(log, "a\nb\nc\n")
    fixture.items.shellsObserved(fixture.shell(moth, [running("1", log), running("2")]))
    const [item] = shellsOn(fixture, moth.terminalId)
    const content = await fixture.items.load(item!.id, false)
    expect(itemContent.safeParse(content).success).toBe(true)
    expect(content).toMatchObject({
      state: "ready",
      content: {
        kind: "shells",
        agent: "claude",
        shells: [
          {
            id: "1",
            command: "sleep 1",
            exit: null,
            output: { state: "ready", firstLine: 1, lines: ["a", "b", "c"], total: 3 },
          },
          { id: "2", output: { state: "none" } },
        ],
      },
    })
    fixture.shell(moth, undefined)
    expect(await fixture.items.load(item!.id, false)).toMatchObject({
      state: "unavailable",
      reason: "missing",
    })
  })

  it("stream their content as an output file grows, and not for a version bump alone", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    const log = join(fixture.directory, "one.log")
    writeFileSync(log, "a\n")
    fixture.items.shellsObserved(fixture.shell(moth, [running("1", log)]))
    const [item] = shellsOn(fixture, moth.terminalId)
    const stream = fixture.items.content(item!.id, undefined)
    const total = (content: ItemContent | undefined) => {
      const output =
        content?.state === "ready" && content.content.kind === "shells"
          ? content.content.shells[0]?.output
          : undefined
      return output?.state === "ready" ? output.total : undefined
    }
    try {
      expect(total(await next(stream))).toBe(1)
      writeFileSync(log, "a\nb\n")
      expect(total(await next(stream))).toBe(2)
    } finally {
      await stream.return(undefined)
    }
  })
})

describe("a folder beside its terminal", () => {
  /** The listing a ready place content holds. */
  const listed = (content: ItemContent | undefined) => {
    expect(content?.state).toBe("ready")
    if (content?.state !== "ready" || content.content.kind !== "folder")
      throw new Error("not a place listing")
    return content.content
  }
  const render = (directory: string) => {
    const place = join(directory, "render")
    mkdirSync(join(place, "old-runs"), { recursive: true })
    writeFileSync(join(place, "shot.png"), "pixels")
    writeFileSync(join(place, "notes.md"), "# Notes\n")
    writeFileSync(join(place, "clip.mp4"), "frames")
    writeFileSync(join(place, "old-runs", "one.png"), "1")
    return place
  }

  it("shows a folder by its path, with or without a closing slash, as one item named by it", async ({
    fixture,
  }) => {
    const place = render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render/" }, open: true })
    expect(shown).toMatchObject({ ok: true, kind: "folder", name: "render", opened: true })
    const again = await fixture.items.show(moth, { file: { path: place } })
    expect(again).toMatchObject({ ok: true, again: true })
    expect(fixture.items.bar(moth.terminalId)).toHaveLength(1)
    expect(fixture.items.bar(moth.terminalId)[0]).toMatchObject({
      kind: "folder",
      path: place,
      detail: place,
      secret: false,
    })
    expect(fixture.items.listing(moth.terminalId)).toContain(`folder "render": ${place}`)
  })

  it("lists what a folder holds: names, kinds, sizes, times and what its folders hold", async ({
    fixture,
  }) => {
    render(fixture.directory)
    writeFileSync(join(fixture.directory, "render", ".env"), "TOKEN=x\n")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const content = await fixture.items.load(shown.ok ? shown.id : "", false)
    expect(itemContent.parse(content)).toEqual(content)
    const place = listed(content)
    expect(place).toMatchObject({ within: "", total: 5, truncated: false })
    expect(place.entries.map(({ name, kind, secret }) => [name, kind, secret])).toEqual([
      [".env", "other", true],
      ["clip.mp4", "video", false],
      ["notes.md", "text", false],
      ["old-runs", "folder", false],
      ["shot.png", "image", false],
    ])
    const shot = place.entries.find(({ name }) => name === "shot.png")!
    expect(shot).toMatchObject({ size: 6, children: null, link: false })
    expect(shot.modifiedAt).toBeGreaterThan(0)
    expect(shot.stamp).not.toBe("")
    expect(place.entries.find(({ name }) => name === "old-runs")).toMatchObject({ children: 1 })
    // A secret file is named, flagged and given no stamp to be read by.
    expect(place.entries.find(({ name }) => name === ".env")).toMatchObject({ stamp: "" })
  })

  it("lists the folder inside it that is asked for, and never one outside the top", async ({
    fixture,
  }) => {
    render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const id = shown.ok ? shown.id : ""
    const controller = new AbortController()
    try {
      const inner = fixture.items.content(id, undefined, controller.signal, "old-runs")
      const place = listed(await next(inner))
      expect(place).toMatchObject({ within: "old-runs", total: 1 })
      expect(place.path).toBe(join(fixture.directory, "render", "old-runs"))
      await inner.return(undefined)
      for (const outside of ["..", "../..", "old-runs/../../x", "missing"]) {
        const stream = fixture.items.content(id, undefined, controller.signal, outside)
        // eslint-disable-next-line no-await-in-loop -- Each stream is read and ended before the next.
        await expect(next(stream)).resolves.toMatchObject({
          state: "unavailable",
          reason: "missing",
        })
        // eslint-disable-next-line no-await-in-loop -- As above.
        await stream.return(undefined)
      }
    } finally {
      controller.abort()
    }
  })

  it("refuses a folder that may hold secrets with a sentence, shown or attached, and lists none of it", async ({
    fixture,
  }) => {
    mkdirSync(join(fixture.directory, ".ssh"))
    writeFileSync(join(fixture.directory, ".ssh", "config"), "Host x\n")
    const moth = fixture.terminal("moth")
    await expect(fixture.items.show(moth, { file: { path: ".ssh" } })).resolves.toEqual({
      ok: false,
      reason: "That folder may hold secrets, so Novadeck won't list what is in it.",
    })
    await expect(
      fixture.items.attach({ terminalId: moth.terminalId, path: ".ssh/" }),
    ).rejects.toMatchObject({ code: "INVALID_FILE" })
    expect(fixture.items.bar(moth.terminalId)).toEqual([])
  })

  it("names a secret folder inside one, never counting or entering it", async ({ fixture }) => {
    const place = render(fixture.directory)
    mkdirSync(join(place, ".aws"))
    writeFileSync(join(place, ".aws", "profile.png"), "key\n")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const id = shown.ok ? shown.id : ""
    const aws = listed(await fixture.items.load(id, false)).entries.find(
      ({ name }) => name === ".aws",
    )
    expect(aws).toMatchObject({ kind: "folder", secret: true, children: null })
    const controller = new AbortController()
    const stream = fixture.items.content(id, undefined, controller.signal, ".aws")
    await expect(next(stream)).resolves.toMatchObject({ state: "unavailable", reason: "secret" })
    await stream.return(undefined)
    controller.abort()
    await expect(
      fixture.items.part({ itemId: id, stamp: "", offset: 0, path: ".aws/profile.png" }),
    ).resolves.toEqual({ state: "unavailable", reason: "secret" })
  })

  it("lists a link that leaves the top as a link, and neither enters nor reads it", async ({
    fixture,
  }) => {
    if (process.platform === "win32") return
    const place = render(fixture.directory)
    const outside = join(fixture.directory, "outside")
    mkdirSync(outside)
    writeFileSync(join(outside, "private.png"), "not for the pane")
    symlinkSync(outside, join(place, "out"))
    symlinkSync(join(outside, "private.png"), join(place, "peek.png"))
    symlinkSync(join(place, "shot.png"), join(place, "same.png"))
    symlinkSync(join(place, "nowhere"), join(place, "broken"))
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const id = shown.ok ? shown.id : ""
    const entries = listed(await fixture.items.load(id, false)).entries
    for (const name of ["out", "peek.png", "broken"])
      expect(
        entries.find((entry) => entry.name === name),
        name,
      ).toMatchObject({
        kind: "other",
        link: true,
        children: null,
        stamp: "",
      })
    // One that stays inside is its target.
    expect(entries.find(({ name }) => name === "same.png")).toMatchObject({
      kind: "image",
      link: false,
      size: 6,
    })
    const controller = new AbortController()
    try {
      const stream = fixture.items.content(id, undefined, controller.signal, "out")
      await expect(next(stream)).resolves.toMatchObject({ state: "unavailable", reason: "missing" })
      await stream.return(undefined)
    } finally {
      controller.abort()
    }
    for (const path of ["out/private.png", "peek.png"])
      // eslint-disable-next-line no-await-in-loop -- One path after another.
      await expect(
        fixture.items.part({ itemId: id, stamp: "x", offset: 0, path }),
      ).resolves.toEqual({ state: "unavailable", reason: "missing" })
    await expect(
      fixture.items.part({
        itemId: id,
        stamp: entries.find(({ name }) => name === "same.png")!.stamp,
        offset: 0,
        path: "same.png",
      }),
    ).resolves.toEqual({ state: "part", data: Buffer.from("pixels").toString("base64") })
  })

  it("lists a 3D model in a folder as one, and reads it whole for its still", async ({
    fixture,
  }) => {
    writeFileSync(join(render(fixture.directory), "bracket.stl"), "solid bracket\nendsolid\n")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const itemId = shown.ok ? shown.id : ""
    const model = listed(await fixture.items.load(itemId, false)).entries.find(
      ({ name }) => name === "bracket.stl",
    )!
    expect(model.kind).toBe("model")
    await expect(
      fixture.items.part({ itemId, stamp: model.stamp, offset: 0, path: "bracket.stl" }),
    ).resolves.toEqual({
      state: "part",
      data: Buffer.from("solid bracket\nendsolid\n").toString("base64"),
    })
  })

  it("lists a compiled object file named .obj as a plain file, and reads none of it for a still", async ({
    fixture,
  }) => {
    const place = render(fixture.directory)
    // An x64 COFF object, as MSVC writes, and a Wavefront model beside it.
    writeFileSync(join(place, "main.obj"), Buffer.from([0x64, 0x86, 0x03, 0x00, 0x5f, 0x00]))
    writeFileSync(join(place, "cube.obj"), "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const itemId = shown.ok ? shown.id : ""
    const entry = async (name: string) =>
      listed(await fixture.items.load(itemId, false)).entries.find((found) => found.name === name)!
    const object = await entry("main.obj")
    expect(object.kind).toBe("other")
    expect((await entry("cube.obj")).kind).toBe("model")
    await expect(
      fixture.items.part({ itemId, stamp: object.stamp, offset: 0, path: "main.obj" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    // Rewritten as the other, each is listed as what it holds now.
    writeFileSync(join(place, "main.obj"), "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n# model\n")
    writeFileSync(join(place, "cube.obj"), Buffer.from([0x4c, 0x01, 0x01, 0x00]))
    expect((await entry("main.obj")).kind).toBe("model")
    expect((await entry("cube.obj")).kind).toBe("other")
  })

  it("tells a compiled .obj it couldn't read once it can, though its stamp is the same", async ({
    fixture,
  }) => {
    // No file is locked to the superuser, and Windows has no such modes.
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const path = join(render(fixture.directory), "locked.obj")
    writeFileSync(path, Buffer.from([0x64, 0x86, 0x03, 0x00, 0x5f, 0x00]))
    chmodSync(path, 0o000)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const itemId = shown.ok ? shown.id : ""
    const kind = async () =>
      listed(await fixture.items.load(itemId, false)).entries.find(
        ({ name }) => name === "locked.obj",
      )!.kind
    try {
      // Unread, it is what its name tells.
      expect(await kind()).toBe("model")
    } finally {
      chmodSync(path, 0o644)
    }
    expect(await kind()).toBe("other")
  })

  it("reads a file of the folder by its path and stamp, as its kind is read anywhere", async ({
    fixture,
  }) => {
    render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const itemId = shown.ok ? shown.id : ""
    const place = listed(await fixture.items.load(itemId, false))
    const stamp = place.entries.find(({ name }) => name === "shot.png")!.stamp
    await expect(
      fixture.items.part({ itemId, stamp, offset: 0, path: "shot.png" }),
    ).resolves.toEqual({ state: "part", data: Buffer.from("pixels").toString("base64") })
    await expect(
      fixture.items.part({ itemId, stamp, offset: 2, path: "shot.png" }),
    ).resolves.toEqual({ state: "part", data: Buffer.from("xels").toString("base64") })
    // Rewritten since its listing, it is read from its new stamp.
    writeFileSync(join(fixture.directory, "render", "shot.png"), "pixels, again")
    await expect(
      fixture.items.part({ itemId, stamp, offset: 0, path: "shot.png" }),
    ).resolves.toEqual({ state: "changed" })
    await expect(
      fixture.items.part({ itemId, stamp, offset: 0, path: "gone.png" }),
    ).resolves.toEqual({ state: "unavailable", reason: "missing" })
    // Text isn't read in parts, and a folder's file is read only through a place.
    await expect(
      fixture.items.part({ itemId, stamp, offset: 0, path: "notes.md" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    writeFileSync(join(fixture.directory, "a.ts"), "x")
    const file = await fixture.items.show(moth, { file: { path: "a.ts" } })
    await expect(
      fixture.items.part({ itemId: file.ok ? file.id : "", stamp, offset: 0, path: "x.png" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("reads an image only up to what a thumbnail takes", async ({ fixture }) => {
    const place = render(fixture.directory)
    writeFileSync(join(place, "big.png"), Buffer.alloc(2 * 1024 * 1024 + 1))
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const itemId = shown.ok ? shown.id : ""
    const stamp = listed(await fixture.items.load(itemId, false)).entries.find(
      ({ name }) => name === "big.png",
    )!.stamp
    await expect(
      fixture.items.part({ itemId, stamp, offset: 0, path: "big.png" }),
    ).resolves.toEqual({ state: "unavailable", reason: "too-large" })
  })

  it("lists again as the folder changes, and tells the taskbar of files that came", async ({
    fixture,
  }) => {
    const place = render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const id = shown.ok ? shown.id : ""
    const before = fixture.items.bar(moth.terminalId)[0]!
    const controller = new AbortController()
    const stream = fixture.items.content(id, undefined, controller.signal)
    try {
      expect(listed(await next(stream)).total).toBe(4)
      // A file written, then written to: each is a listing of its own, and only the first is news.
      // Each comes from the file system's watch: the polls here are minutes long.
      writeFileSync(join(place, "new.png"), "a")
      expect(listed(await next(stream)).entries.map(({ name }) => name)).toContain("new.png")
      const arrived = fixture.items.bar(moth.terminalId)[0]!
      expect(arrived.version).toBeGreaterThan(before.version)
      expect(arrived.openAsked).toBe(false)
      appendFileSync(join(place, "new.png"), "bcde")
      let grown = listed(await next(stream))
      while (grown.entries.find(({ name }) => name === "new.png")?.size !== 5)
        // eslint-disable-next-line no-await-in-loop -- Each listing is read before the next.
        grown = listed(await next(stream))
      // Written to, not new: the item is no newer for it.
      expect(fixture.items.bar(moth.terminalId)[0]!.version).toBe(arrived.version)
    } finally {
      controller.abort()
      await stream.return(undefined)
    }
  })

  it("tells a file that came once, however many follow the folder's top and finish reading out of order", async ({
    fixture,
  }) => {
    const place = render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const id = shown.ok ? shown.id : ""
    const controllers = [new AbortController(), new AbortController(), new AbortController()]
    const streams = controllers.map(({ signal }) => fixture.items.content(id, undefined, signal))
    try {
      const lists = async () =>
        (await Promise.all(streams.map((stream) => next(stream)))).map(listed)
      for (const each of await lists()) expect(each.total).toBe(4)
      const before = fixture.items.bar(moth.terminalId)[0]!.version
      writeFileSync(join(place, "new.png"), "a")
      for (const each of await lists())
        expect(each.entries.map(({ name }) => name)).toContain("new.png")
      // Each follower read the top again, and the file is news once: the item is one version newer.
      expect(fixture.items.bar(moth.terminalId)[0]!.version).toBe(before + 1)
      writeFileSync(join(place, "newer.png"), "b")
      for (const each of await lists())
        expect(each.entries.map(({ name }) => name)).toContain("newer.png")
      expect(fixture.items.bar(moth.terminalId)[0]!.version).toBe(before + 2)
    } finally {
      for (const controller of controllers) controller.abort()
      await Promise.all(streams.map((stream) => stream.return(undefined)))
    }
  })

  it("lists a link inside the folder as its target's, flagged, and a pipe as no regular file", async ({
    fixture,
  }) => {
    const place = render(fixture.directory)
    writeFileSync(join(place, "run-5.png"), "5")
    symlinkSync("run-5.png", join(place, "latest.png"))
    const fifo = process.platform !== "win32"
    if (fifo) execFileSync("mkfifo", [join(place, "pipe.log")])
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const content = await fixture.items.load(shown.ok ? shown.id : "", false)
    const entries = listed(content).entries
    expect(entries.find(({ name }) => name === "latest.png")).toMatchObject({
      kind: "image",
      link: false,
      linked: true,
    })
    expect(entries.find(({ name }) => name === "run-5.png")).not.toHaveProperty("linked")
    expect(entries.find(({ name }) => name === "shot.png")).not.toHaveProperty("linked")
    if (fifo)
      expect(entries.find(({ name }) => name === "pipe.log")).toMatchObject({ plain: false })
  })

  it("says a folder is gone once it is moved or deleted, and lists it again when it is back", async ({
    fixture,
  }) => {
    // Once gone, a folder can't be watched, and is polled for: a short poll, which only then counts.
    fixture.polls.unwatched = 300
    const place = render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const controller = new AbortController()
    const stream = fixture.items.content(shown.ok ? shown.id : "", undefined, controller.signal)
    try {
      expect(listed(await next(stream)).total).toBe(4)
      renameSync(place, `${place}-moved`)
      await expect(next(stream)).resolves.toMatchObject({ state: "unavailable", reason: "gone" })
      // Told by the watch: the polls here are minutes long.
      // A folder that is gone can't be watched: it is polled for, which a short poll shows.
      renameSync(`${place}-moved`, place)
      expect(listed(await next(stream)).total).toBe(4)
    } finally {
      controller.abort()
      await stream.return(undefined)
    }
  })

  it("lists the first of what a big folder holds and says it holds more", async ({ fixture }) => {
    const place = join(fixture.directory, "big")
    mkdirSync(place)
    for (let index = 0; index < folderLimits.entries + 5; index += 1)
      writeFileSync(join(place, `f${String(index).padStart(5, "0")}`), "")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "big" } })
    const content = await fixture.items.load(shown.ok ? shown.id : "", false)
    expect(itemContent.parse(content)).toEqual(content)
    expect(listed(content)).toMatchObject({
      total: folderLimits.entries + 5,
      truncated: true,
    })
    expect(listed(content).entries).toHaveLength(folderLimits.entries)
    // A file past those listed changes what it holds, so the listing's stamp too.
    writeFileSync(join(place, "zz-last"), "")
    const again = await fixture.items.load(shown.ok ? shown.id : "", false)
    expect(listed(again).total).toBe(folderLimits.entries + 6)
    expect(again?.state === "ready" && again.stamp).not.toBe(
      content?.state === "ready" && content.stamp,
    )
  })

  it("follows a folder deleted and made again, by the watch and not the poll", async ({
    fixture,
  }) => {
    const place = render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const controller = new AbortController()
    const stream = fixture.items.content(shown.ok ? shown.id : "", undefined, controller.signal)
    try {
      expect(listed(await next(stream)).total).toBe(4)
      // As a build tool does it: the folder is another one by the time it is read.
      rmSync(place, { recursive: true })
      mkdirSync(place)
      writeFileSync(join(place, "one.png"), "1")
      expect(listed(await next(stream)).entries.map(({ name }) => name)).toEqual(["one.png"])
      // The watch moved onto the new folder: what lands in it is told.
      writeFileSync(join(place, "two.png"), "2")
      expect(listed(await next(stream)).total).toBe(2)
    } finally {
      controller.abort()
      await stream.return(undefined)
    }
  })

  it("counts a folder inside again once it changed, and again where its time is too coarse to tell", async ({
    fixture,
  }) => {
    const place = render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const id = shown.ok ? shown.id : ""
    const children = async () =>
      listed(await fixture.items.load(id, false)).entries.find(({ name }) => name === "old-runs")
        ?.children
    const inner = join(place, "old-runs")
    expect(await children()).toBe(1)
    // A change moves the folder's time, which a count is kept by.
    writeFileSync(join(inner, "two.png"), "2")
    expect(await children()).toBe(2)
    // A file system with a coarse clock gives a change the time it had: within a moment of now
    // that is not trusted, so the count is read again.
    const stamped = new Date(Date.now() - 1000)
    utimesSync(inner, stamped, stamped)
    expect(await children()).toBe(2)
    writeFileSync(join(inner, "three.png"), "3")
    utimesSync(inner, stamped, stamped)
    expect(await children()).toBe(3)
    // A count taken well after the time it was kept by is trusted, which saves reading what
    // hasn't changed; one taken within the same tick as the change is not, though the clock moved on.
    const old = new Date(Date.now() - 60_000)
    utimesSync(inner, old, old)
    expect(await children()).toBe(3)
    writeFileSync(join(inner, "four.png"), "4")
    utimesSync(inner, old, old)
    expect(await children()).toBe(3)
  })

  it("recounts a folder counted in the same tick as a change, once the clock has moved past it", async ({
    fixture,
  }) => {
    const place = render(fixture.directory)
    const inner = join(place, "old-runs")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const id = shown.ok ? shown.id : ""
    const children = async () =>
      listed(await fixture.items.load(id, false)).entries.find(({ name }) => name === "old-runs")
        ?.children
    // Counted at 1, its time (as a coarse file system keeps it) a moment before now.
    const tick = new Date(Date.now() - 100)
    utimesSync(inner, tick, tick)
    expect(await children()).toBe(1)
    // Written in the same tick: the time has not moved. Seen well after, it is counted again.
    writeFileSync(join(inner, "same-tick.png"), "x")
    utimesSync(inner, tick, tick)
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 5000 })
    try {
      expect(await children()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("lists a link by its target's kind, so the listing and a read of the file agree", async ({
    fixture,
  }) => {
    if (process.platform === "win32") return
    const place = render(fixture.directory)
    writeFileSync(join(place, "blob"), "not a picture")
    symlinkSync(join(place, "blob"), join(place, "photo.png"))
    symlinkSync(join(place, "shot.png"), join(place, "picture.dat"))
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const itemId = shown.ok ? shown.id : ""
    const entries = listed(await fixture.items.load(itemId, false)).entries
    const entry = (name: string) => entries.find((each) => each.name === name)!
    // A picture's name on what is no picture is no picture: it is not read as one.
    expect(entry("photo.png")).toMatchObject({ kind: "other", link: false })
    await expect(
      fixture.items.part({ itemId, stamp: entry("photo.png").stamp, offset: 0, path: "photo.png" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    // And what is a picture under another name is one.
    expect(entry("picture.dat")).toMatchObject({ kind: "image", link: false })
    await expect(
      fixture.items.part({
        itemId,
        stamp: entry("picture.dat").stamp,
        offset: 0,
        path: "picture.dat",
      }),
    ).resolves.toEqual({ state: "part", data: Buffer.from("pixels").toString("base64") })
  })

  it("finds what the watch can't tell inside a folder, by a poll", async ({ fixture }) => {
    if (process.platform === "win32") return
    fixture.polls.safety = 300
    const place = render(fixture.directory)
    mkdirSync(join(place, "runs", "1"), { recursive: true })
    mkdirSync(join(place, "runs", "2"), { recursive: true })
    writeFileSync(join(place, "runs", "1", "one.png"), "1")
    writeFileSync(join(place, "runs", "2", "two.png"), "2")
    symlinkSync(join(place, "runs", "1"), join(place, "latest"))
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const id = shown.ok ? shown.id : ""
    const controller = new AbortController()
    // In the folder the link leads to: the watch is on runs/1, which the retarget doesn't touch.
    const stream = fixture.items.content(id, undefined, controller.signal, "latest")
    try {
      expect(listed(await next(stream)).entries.map(({ name }) => name)).toEqual(["one.png"])
      rmSync(join(place, "latest"))
      symlinkSync(join(place, "runs", "2"), join(place, "latest"))
      expect(listed(await next(stream)).entries.map(({ name }) => name)).toEqual(["two.png"])
    } finally {
      controller.abort()
      await stream.return(undefined)
    }
  })

  it("finds what the watch can't tell at the top too, by a poll", async ({ fixture }) => {
    fixture.polls.safety = 300
    const place = render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const controller = new AbortController()
    const stream = fixture.items.content(shown.ok ? shown.id : "", undefined, controller.signal)
    try {
      const count = (content: ItemContent | undefined) =>
        listed(content).entries.find(({ name }) => name === "old-runs")?.children
      expect(count(await next(stream))).toBe(1)
      // A file in a folder inside is no event of the folder watched: only the poll counts it.
      writeFileSync(join(place, "old-runs", "late.png"), "x")
      expect(count(await next(stream))).toBe(2)
    } finally {
      controller.abort()
      await stream.return(undefined)
    }
  })

  it("arms the watch before it reads, so what lands just after the read is told", async ({
    fixture,
  }) => {
    const place = render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const controller = new AbortController()
    const stream = fixture.items.content(shown.ok ? shown.id : "", undefined, controller.signal)
    let wrote = false
    // Right after the first read, as a write does between a read and a watch armed after it.
    fixture.steps.afterReading = () => {
      if (wrote) return
      wrote = true
      writeFileSync(join(place, "just-after.png"), "x")
    }
    try {
      expect(listed(await next(stream)).entries.map(({ name }) => name)).not.toContain(
        "just-after.png",
      )
      expect(listed(await next(stream)).entries.map(({ name }) => name)).toContain("just-after.png")
    } finally {
      controller.abort()
      await stream.return(undefined)
    }
  })

  it("arms and reads again a folder replaced between placing the watch and reading", async ({
    fixture,
  }) => {
    const place = render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const controller = new AbortController()
    const stream = fixture.items.content(shown.ok ? shown.id : "", undefined, controller.signal)
    let swapped = false
    try {
      expect(listed(await next(stream)).total).toBe(4)
      // The next pass: the folder is made again after the watch was armed on the one before it.
      fixture.steps.afterPlacing = () => {
        if (swapped) return
        swapped = true
        rmSync(place, { recursive: true })
        mkdirSync(place)
        writeFileSync(join(place, "fresh.png"), "x")
      }
      writeFileSync(join(place, "nudge.png"), "x")
      // Read again at once, not left to a poll, and watched anew: what lands in it is told.
      let content = listed(await next(stream))
      while (!content.entries.some(({ name }) => name === "fresh.png"))
        // eslint-disable-next-line no-await-in-loop -- Each listing is read before the next.
        content = listed(await next(stream))
      writeFileSync(join(place, "later.png"), "x")
      content = listed(await next(stream))
      expect(content.entries.map(({ name }) => name)).toContain("later.png")
    } finally {
      controller.abort()
      await stream.return(undefined)
    }
  })

  it("waits for a folder it can't read, and doesn't read it again and again", async ({
    fixture,
  }) => {
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const place = render(fixture.directory)
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    chmodSync(place, 0o000)
    const controller = new AbortController()
    try {
      const stream = fixture.items.content(shown.ok ? shown.id : "", undefined, controller.signal)
      const before = fixture.asked.environment
      await expect(next(stream)).resolves.toMatchObject({
        state: "unavailable",
        reason: "unreadable",
      })
      const later = next(stream)
      await new Promise((resolve) => setTimeout(resolve, 2000))
      // A pass asks twice (placing and reading): a few at most in two seconds, not one in four every second.
      expect(fixture.asked.environment - before).toBeLessThanOrEqual(4)
      chmodSync(place, 0o755)
      controller.abort()
      await later
      await stream.return(undefined)
    } finally {
      chmodSync(place, 0o755)
      controller.abort()
    }
  })

  it("lists a folder that is only a folder by what is under it as secret", async ({ fixture }) => {
    // gcloud's folder is matched by the files in it, and the others by where the environment puts them.
    const gcloud = join(fixture.directory, ".config", "gcloud")
    mkdirSync(join(gcloud, "legacy_credentials", "me@example.com"), { recursive: true })
    const moth = fixture.terminal("moth")
    const refusal = {
      ok: false,
      reason: "That folder may hold secrets, so Novadeck won't list what is in it.",
    }
    await expect(fixture.items.show(moth, { file: { path: gcloud } })).resolves.toEqual(refusal)
    await expect(fixture.items.show(moth, { file: { path: `${gcloud}/` } })).resolves.toEqual(
      refusal,
    )
    for (const variable of ["GNUPGHOME", "DOCKER_CONFIG", "AZURE_CONFIG_DIR", "CLOUDSDK_CONFIG"]) {
      const moved = join(fixture.directory, `${variable.toLowerCase()}-store`)
      mkdirSync(moved)
      fixture.environment[variable] = moved
      // eslint-disable-next-line no-await-in-loop -- One variable after another, in one environment.
      await expect(fixture.items.show(moth, { file: { path: moved } }), variable).resolves.toEqual(
        refusal,
      )
    }
    // Entered or listed from a folder above, it is named and flagged, never listed or counted.
    const above = join(fixture.directory, ".config")
    const shown = await fixture.items.show(moth, { file: { path: above } })
    const id = shown.ok ? shown.id : ""
    expect(listed(await fixture.items.load(id, false)).entries).toMatchObject([
      { name: "gcloud", kind: "folder", secret: true, children: null },
    ])
    const controller = new AbortController()
    const stream = fixture.items.content(id, undefined, controller.signal, "gcloud")
    await expect(next(stream)).resolves.toMatchObject({ state: "unavailable", reason: "secret" })
    await stream.return(undefined)
    controller.abort()
    // The folder a link points to is judged by where it leads.
    await expect(
      fixture.items.part({
        itemId: id,
        stamp: "x",
        offset: 0,
        path: "gcloud/legacy_credentials/me@example.com/x.png",
      }),
    ).resolves.toEqual({ state: "unavailable", reason: "secret" })
  })

  it("restarts a stream whose item became another kind", async ({ fixture }) => {
    const target = join(fixture.directory, "thing")
    writeFileSync(target, "a file\n")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "thing" } })
    const id = shown.ok ? shown.id : ""
    const controller = new AbortController()
    const stream = fixture.items.content(id, undefined, controller.signal)
    try {
      expect(lines(await next(stream))).toEqual(["a file"])
      rmSync(target)
      mkdirSync(target)
      writeFileSync(join(target, "in.png"), "x")
      await fixture.items.show(moth, { file: { path: "thing" } })
      expect(fixture.items.bar(moth.terminalId)[0]).toMatchObject({ kind: "folder" })
      expect(listed(await next(stream)).entries.map(({ name }) => name)).toEqual(["in.png"])
      rmSync(target, { recursive: true })
      writeFileSync(target, "a file again\n")
      await fixture.items.show(moth, { file: { path: "thing" } })
      expect(lines(await next(stream))).toEqual(["a file again"])
    } finally {
      controller.abort()
      await stream.return(undefined)
    }
  })

  it("takes no lines for a folder", async ({ fixture }) => {
    render(fixture.directory)
    const moth = fixture.terminal("moth")
    await expect(
      fixture.items.show(moth, { file: { path: "render", lines: { from: 1, to: 2 } } }),
    ).resolves.toEqual({
      ok: false,
      reason: "A folder has no lines to point at; give lines only for a text file.",
    })
  })

  it("reads a file by what it is, not by the name a link inside the folder gives it", async ({
    fixture,
  }) => {
    if (process.platform === "win32") return
    const place = render(fixture.directory)
    writeFileSync(join(place, "big.mp4"), Buffer.alloc(2 * 1024 * 1024 + 8))
    symlinkSync(join(place, "big.mp4"), join(place, "fake.png"))
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: "render" } })
    const itemId = shown.ok ? shown.id : ""
    const stamp = listed(await fixture.items.load(itemId, false)).entries.find(
      ({ name }) => name === "fake.png",
    )!.stamp
    // A video is read up to a video's limit, whatever the link says it is.
    expect((await fixture.items.part({ itemId, stamp, offset: 0, path: "fake.png" })).state).toBe(
      "part",
    )
  })

  it("is attached to a terminal as the person's own, and opens a file of it as that file's kind", async ({
    fixture,
  }) => {
    const place = render(fixture.directory)
    const moth = fixture.terminal("moth")
    const attached = await fixture.items.attach({ terminalId: moth.terminalId, path: place })
    expect(attached).toMatchObject({ kind: "folder", by: "person", openAsked: true })
    const image = await fixture.items.attach({
      terminalId: moth.terminalId,
      path: join(place, "shot.png"),
    })
    expect(image).toMatchObject({ kind: "image", name: "shot.png", by: "person", openAsked: true })
    expect(fixture.items.bar(moth.terminalId).map(({ kind }) => kind)).toEqual(["folder", "image"])
  })

  it("is not opened in the project window, which holds one file", async ({ fixture }) => {
    render(fixture.directory)
    await expect(
      fixture.items.openInProject({
        sessionId: fixture.sessionId,
        path: "render",
        windowId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_FILE" })
  })
})
