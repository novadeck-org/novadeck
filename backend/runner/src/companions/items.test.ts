import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"

import {
  itemContent,
  type CompanionChange,
  type ItemContent,
  type PageTrouble,
} from "@novadeck/protocol"

import { describe, expect, it as base } from "../test.js"
import { WorkspaceStore } from "../workspaces/store.js"
import type { PlanText } from "./content.js"
import { CompanionItems, type TerminalPlace } from "./items.js"

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
  /** Closes a terminal as the terminals do: its items first, then its record. */
  close: (terminalId: string) => void
  items: CompanionItems
  /** What a text plan's live terminal has, as `livePlan` reads it. */
  live: Map<string, PlanText>
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
    const items = new CompanionItems({
      records: store,
      terminal: (terminalId) => places.get(terminalId),
      livePlan: (item) => live.get(item.id),
      pollMs: 10,
      changesMs: 10,
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
        naming: { person: null, agent: null, murmur: null, summary: null },
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
    await use({ directory, store, sessionId: session.id, terminal, close, items, live })
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
    await expect(fixture.items.dismiss(moth, { file: { path: "./a.ts" } })).resolves.toEqual({
      ok: true,
      name: "a.ts",
      kind: "file",
    })
    await expect(
      fixture.items.dismiss(moth, { page: { url: "http://localhost:5173" } }),
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
    await expect(fixture.items.dismiss(moth, { file: { path: "tmp.png" } })).resolves.toMatchObject(
      {
        ok: true,
        name: "tmp.png",
      },
    )
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
    await expect(fixture.items.dismiss(moth, { file: { path: "link/shot.png" } })).resolves.toEqual(
      {
        ok: true,
        name: "shot.png",
        kind: "image",
      },
    )
    expect(fixture.items.bar(moth.terminalId)).toEqual([])
  })

  it("no longer reaches its item once the person moved it elsewhere", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "const a = 1\n")
    const moth = fixture.terminal("moth")
    const fox = fixture.terminal("fox")
    const shown = await fixture.items.show(moth, { file: { path: "a.ts" } })
    const id = shown.ok ? shown.id : ""
    fixture.items.undock(id, randomUUID())
    await expect(fixture.items.dismiss(moth, { file: { path: "a.ts" } })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('"a.ts" was moved by the user into a window of its own'),
    })
    fixture.items.move(id, fox.terminalId)
    await expect(fixture.items.dismiss(moth, { file: { path: "a.ts" } })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('"a.ts" was moved by the user to @fox'),
    })
    await expect(fixture.items.dismiss(fox, { file: { path: "a.ts" } })).resolves.toMatchObject({
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
    await expect(fixture.items.dismiss(moth, { file: { path: "a.ts" } })).resolves.toEqual({
      ok: false,
      reason:
        '"a.ts" was attached by the user, so it isn\'t yours to close; tell the user if it ' +
        "should go.",
    })
    await expect(fixture.items.dismiss(moth, { file: { path: "b.ts" } })).resolves.toEqual({
      ok: false,
      reason:
        '"b.ts" was placed beside you from @fox, so it isn\'t yours to close; tell the user if ' +
        "it should go.",
    })
    await expect(fixture.items.dismiss(moth, { file: { path: "c.ts" } })).resolves.toEqual({
      ok: false,
      reason: 'Nothing is showing beside your terminal at "c.ts"; showing lists what is.',
    })
    await expect(
      fixture.items.dismiss(moth, { page: { url: "file:///etc/passwd" } }),
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
      fixture.items.dismiss(moth, { page: { url: "http://127.0.0.1:4323/elsewhere" } }),
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
        held: false,
        by: "agent",
        from: { terminalId: moth.terminalId, handle: "moth" },
        version: 2,
        asked: true,
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
      held: true,
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
  it("is a file on a terminal's bar, refused as INVALID_FILE when it is no file", async ({
    fixture,
  }) => {
    const moth = fixture.terminal("moth")
    writeFileSync(join(fixture.directory, "notes.md"), "# Notes\n")
    await expect(
      fixture.items.attach({ terminalId: moth.terminalId, path: "notes.md", title: "Notes" }),
    ).resolves.toMatchObject({ name: "Notes", by: "person", asked: false, version: 1 })
    await expect(
      fixture.items.attach({ terminalId: moth.terminalId, path: "." }),
    ).rejects.toMatchObject({
      code: "INVALID_FILE",
      message: "That's a folder; only files can be shown.",
    })
    await expect(
      fixture.items.attach({ terminalId: randomUUID(), path: "notes.md" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
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
    const stream = fixture.items.content(itemId, false)
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

  it("holds a file that may hold secrets until revealed", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, ".env"), "TOKEN=x\n")
    const moth = fixture.terminal("moth")
    const shown = await fixture.items.show(moth, { file: { path: ".env" } })
    const itemId = shown.ok ? shown.id : ""
    await expect(fixture.items.load(itemId, false)).resolves.toEqual({
      state: "unavailable",
      reason: "held",
      size: 8,
    })
    await expect(fixture.items.load(itemId, true)).resolves.toMatchObject({ state: "ready" })
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
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ version: 1, asked: false }])
    // Rewritten live: a new version, but a rewrite never asks to open again.
    await fixture.items.planObserved(moth, slot, plan, now)
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ version: 2, asked: false }])
    // A replay of that same observation changes nothing.
    await fixture.items.planObserved(moth, slot, plan, now)
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ version: 2, asked: false }])
    // A first-seen live plan asks to open as well.
    const other = join(fixture.directory, "other.md")
    writeFileSync(other, "# Other\n")
    const fox = fixture.terminal("fox")
    await fixture.items.planObserved(
      fox,
      slot,
      { source: { kind: "file", path: other }, path: other },
      Date.now(),
    )
    expect(fixture.items.bar(fox.terminalId)).toMatchObject([{ version: 1, asked: true }])
    // Its live rewrites clear the ask rather than re-opening the pane.
    await fixture.items.planObserved(
      fox,
      slot,
      { source: { kind: "file", path: other }, path: other },
      Date.now() + 1,
    )
    expect(fixture.items.bar(fox.terminalId)).toMatchObject([{ version: 2, asked: false }])
  })

  it("do not reopen a closed plan, nor open a subagent's", async ({ fixture }) => {
    const path = join(fixture.directory, "closed.md")
    writeFileSync(path, "# Closed\n")
    const moth = fixture.terminal("moth")
    const plan = { source: { kind: "file", path } as const, path }
    const sub = { ...slot, actor: "sub" } as const
    await fixture.items.planObserved(moth, sub, plan, Date.now())
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ asked: false }])
    await fixture.items.planObserved(moth, slot, plan, Date.now())
    expect(fixture.items.bar(moth.terminalId)).toMatchObject([{ asked: false }, { asked: true }])
    const [, root] = fixture.items.bar(moth.terminalId)
    fixture.items.close(root!.id)
    await fixture.items.planObserved(moth, slot, plan, Date.now() + 1)
    expect(fixture.items.bar(moth.terminalId).at(-1)).toMatchObject({
      version: 1,
      asked: false,
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
        heard.push({ itemId: item.id, version: item.version, terminalId: item.from.terminalId }),
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

describe.skipIf(!gitInstalled)("the changes of a repository", () => {
  /** A repository with one commit and a change on top of it, and a terminal working in it. */
  const repository = (fixture: Fixture) => {
    const root = join(fixture.directory, "work")
    mkdirSync(root)
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
        { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: devNull } },
      )
    git("init", "--quiet")
    writeFileSync(join(root, "a.txt"), "one\n")
    git("add", "-A")
    git("commit", "--quiet", "-m", "base")
    writeFileSync(join(root, "a.txt"), "one\ntwo\n")
    return { root, place: { ...fixture.terminal("moth"), cwd: root } }
  }

  it("is one item per repository, updated by showing again, and closed the same way", async ({
    fixture,
  }) => {
    const { root, place } = repository(fixture)
    const first = await fixture.items.show(place, { changes: {} })
    expect(first).toMatchObject({ ok: true, kind: "changes", again: false })
    const item = fixture.items.bar(place.terminalId)[0]
    expect(item).toMatchObject({
      kind: "changes",
      path: root,
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
    expect(fixture.items.listing(place.terminalId)).toContain(`changes "My work": ${root}`)
    await expect(fixture.items.dismiss(place, { changes: {} })).resolves.toMatchObject({
      ok: true,
      kind: "changes",
    })
    expect(fixture.items.bar(place.terminalId)).toEqual([])
    await expect(fixture.items.dismiss(place, { changes: {} })).resolves.toMatchObject({
      ok: false,
    })
  })

  it("yields its content when the change changes, and not otherwise", async ({ fixture }) => {
    const { root, place } = repository(fixture)
    const shown = await fixture.items.show(place, { changes: {} })
    const itemId = shown.ok ? shown.id : ""
    const stream = fixture.items.content(itemId, false)
    const first = await next(stream)
    expect(first).toMatchObject({ state: "ready", content: { kind: "changes", root } })
    expect(itemContent.parse(first)).toEqual(first)
    // Several reads pass with nothing new, and none of them yields.
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeFileSync(join(root, "b.txt"), "new\n")
    const second = await next(stream)
    expect(second).not.toMatchObject({ stamp: first && "stamp" in first ? first.stamp : "" })
    expect(second).toMatchObject({
      content: { files: [{ path: "a.txt" }, { path: "b.txt", status: "added" }] },
    })
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
    await expect(fixture.items.dismiss(moth, { changes: {} })).resolves.toMatchObject({
      ok: false,
    })
  })
})
