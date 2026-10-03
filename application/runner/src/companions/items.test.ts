import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { itemContent, type CompanionChange, type ItemContent } from "@novadeck/protocol"

import { describe, expect, it as base } from "../test.js"
import { WorkspaceStore } from "../workspaces/store.js"
import type { PlanText } from "./content.js"
import { CompanionItems, type TerminalPlace } from "./items.js"

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
        naming: { person: null, agent: null, summary: null },
        openedBy: null,
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

describe("what an agent shows", () => {
  it("lands on its own bar, and showing it again updates it there", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "const a = 1\n")
    const t1 = fixture.terminal("t1")
    const first = await fixture.items.show(t1, { path: "a.ts", lines: { from: 1, to: 1 } })
    expect(first).toEqual({
      ok: true,
      id: expect.any(String),
      kind: "file",
      name: "a.ts",
      opened: false,
      again: false,
    })
    const again = await fixture.items.show(t1, { path: "a.ts", title: "Mine", open: true })
    expect(again).toMatchObject({ ok: true, name: "Mine", opened: true, again: true })
    expect(fixture.items.bar(t1.terminalId)).toEqual([
      {
        id: first.ok ? first.id : "",
        sessionId: fixture.sessionId,
        holder: { terminalId: t1.terminalId },
        kind: "file",
        name: "Mine",
        detail: "a.ts",
        path: join(fixture.directory, "a.ts"),
        url: null,
        lines: null,
        held: false,
        by: "agent",
        from: { terminalId: t1.terminalId, handle: "t1" },
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
    const t1 = fixture.terminal("t1")
    writeFileSync(join(fixture.directory, "a.bin"), Buffer.from([0, 1, 2]))
    writeFileSync(join(fixture.directory, ".env"), "TOKEN=x\n")
    writeFileSync(join(fixture.directory, "big.png"), Buffer.alloc(8 * 1024 * 1024 + 1))
    for (let index = 0; index < 70; index += 1)
      writeFileSync(join(fixture.directory, `f${index}.txt`), `${index}\n`)
    for (let index = 0; index < 70; index += 1)
      // eslint-disable-next-line no-await-in-loop -- One show after another.
      await fixture.items.show(t1, { path: `f${index}.txt` })
    await expect(fixture.items.show(t1, { path: "a.bin" })).resolves.toMatchObject({ ok: true })
    // Asked to open, but it may hold secrets: it waits for the person.
    await expect(fixture.items.show(t1, { path: ".env", open: true })).resolves.toMatchObject({
      ok: true,
      opened: false,
      held: true,
    })
    await expect(fixture.items.show(t1, { path: "big.png" })).resolves.toMatchObject({
      ok: true,
      kind: "image",
      tooLarge: true,
    })
    await expect(
      fixture.items.show(t1, { url: "http://localhost:5173/", title: "Preview" }),
    ).resolves.toMatchObject({ ok: true, kind: "page", name: "Preview" })
    await expect(fixture.items.show(t1, { path: "gone.txt" })).resolves.toEqual({
      ok: false,
      reason: "That file doesn't exist.",
    })
    await expect(fixture.items.show(t1, { url: "file:///etc/passwd" })).resolves.toMatchObject({
      ok: false,
    })
    expect(fixture.items.bar(t1.terminalId)).toHaveLength(74)
  })

  it("is listed for its agent with where each item points and who put it there", async ({
    fixture,
  }) => {
    const t1 = fixture.terminal("t1")
    const t2 = fixture.terminal("t2")
    expect(fixture.items.listing(t1.terminalId)).toBe(
      "Nothing is showing beside your terminal in NovaDeck.",
    )
    mkdirSync(join(fixture.directory, "src"))
    writeFileSync(join(fixture.directory, "hero.png"), "png")
    writeFileSync(join(fixture.directory, "src", "store.ts"), "x\n")
    writeFileSync(join(fixture.directory, ".env"), "x\n")
    await fixture.items.show(t1, { path: "hero.png" })
    await fixture.items.attach({
      terminalId: t1.terminalId,
      path: "src/store.ts",
      lines: { from: 40, to: 80 },
    })
    await fixture.items.attach({ terminalId: t1.terminalId, path: ".env" })
    const page = await fixture.items.show(t2, { url: "http://localhost:5173/", title: "Preview" })
    fixture.items.move(page.ok ? page.id : "", t1.terminalId)
    expect(fixture.items.listing(t1.terminalId)).toBe(
      [
        "Showing beside your terminal in NovaDeck (4):",
        `- image "hero.png": ${join(fixture.directory, "hero.png")} (shown by you)`,
        `- file "store.ts" lines 40–80: ${join(fixture.directory, "src", "store.ts")} (attached by the user)`,
        `- file ".env": ${join(fixture.directory, ".env")} (attached by the user; may hold secrets)`,
        '- page "Preview": http://localhost:5173/ (placed here from t2, shown by its agent)',
      ].join("\n"),
    )
  })
})

describe("what the person attaches", () => {
  it("is a file on a terminal's bar, refused as INVALID_FILE when it is no file", async ({
    fixture,
  }) => {
    const t1 = fixture.terminal("t1")
    writeFileSync(join(fixture.directory, "notes.md"), "# Notes\n")
    await expect(
      fixture.items.attach({ terminalId: t1.terminalId, path: "notes.md", title: "Notes" }),
    ).resolves.toMatchObject({ name: "Notes", by: "person", asked: false, version: 1 })
    await expect(
      fixture.items.attach({ terminalId: t1.terminalId, path: "." }),
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
    const t1 = fixture.terminal("t1")
    const t2 = fixture.terminal("t2")
    const watch = watching(fixture.items)
    const shown = await fixture.items.show(t1, { path: "a.ts" })
    const copy = await fixture.items.show(t2, { path: "a.ts" })
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
    // Docking it on t2 replaces t2's own copy, and its window goes.
    expect(fixture.items.move(itemId, t2.terminalId)).toMatchObject({
      holder: { terminalId: t2.terminalId },
      from: { terminalId: t1.terminalId },
    })
    expect(fixture.items.list(fixture.sessionId)).toEqual({
      items: [expect.objectContaining({ id: itemId })],
      windows: [],
    })
    // The agent in t1 shows it again: a new item on its own bar; the moved one stays.
    const reshown = await fixture.items.show(t1, { path: "a.ts" })
    expect(reshown).toMatchObject({ again: false })
    expect(fixture.items.bar(t2.terminalId)).toMatchObject([{ id: itemId, version: 1 }])
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
    expect(reconciled().items).toHaveLength(2)
    expect(kept.items.map(({ id }) => id)).not.toContain(copy.ok ? copy.id : "")
    await watch.stop()
  })

  it("refuses an unknown item or terminal, and another session's terminal", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "a.ts"), "a\n")
    const t1 = fixture.terminal("t1")
    const other = fixture.store.createSession({
      id: randomUUID(),
      projectId: fixture.store.session(fixture.sessionId).projectId,
      name: "Other",
    })
    const elsewhere = fixture.terminal("t1", other.id)
    const shown = await fixture.items.show(t1, { path: "a.ts" })
    const itemId = shown.ok ? shown.id : ""
    expect(() => fixture.items.move(randomUUID(), t1.terminalId)).toThrow(
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
    const gone = fixture.terminal("t2")
    fixture.store.removeTerminal(gone.terminalId)
    expect(() => fixture.items.move(itemId, gone.terminalId)).toThrow(
      expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
    )
    await expect(
      fixture.items.attach({ terminalId: gone.terminalId, path: "a.ts" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    await expect(fixture.items.show(gone, { path: "a.ts" })).resolves.toEqual({
      ok: false,
      reason: "NovaDeck couldn't show it.",
    })
  })

  it("reports a window ahead of the item it holds, renamed or not", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, "n.md"), "# N\n")
    const t1 = fixture.terminal("t1")
    const controller = new AbortController()
    const stream = fixture.items.watch("owner", controller.signal)
    await expect(next(stream)).resolves.toEqual({ type: "synced" })
    const shown = await fixture.items.show(t1, { path: "n.md" })
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
    const t1 = fixture.terminal("t1")
    const a = await fixture.items.show(t1, { path: "a.ts" })
    const b = await fixture.items.show(t1, { path: "b.ts" })
    const windowId = randomUUID()
    fixture.items.undock(b.ok ? b.id : "", windowId)
    fixture.close(t1.terminalId)
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
    const t1 = fixture.terminal("t1")
    const shown = await fixture.items.show(t1, { path: "a.ts" })
    const itemId = shown.ok ? shown.id : ""
    const stream = fixture.items.content(itemId, false)
    expect(lines(await next(stream))).toEqual(["one"])
    writeFileSync(path, "one\ntwo\n")
    expect(lines(await next(stream))).toEqual(["one", "two"])
    // Shown again with other lines, it yields again though the file is the same.
    await fixture.items.show(t1, { path: "a.ts", lines: { from: 2, to: 2 } })
    await expect(next(stream)).resolves.toMatchObject({ content: { from: 2, to: 2 } })
    const ending = stream.next()
    fixture.items.close(itemId)
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
    await expect(fixture.items.load(itemId, false)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("stamps a page within what the protocol takes, however long its address", async ({
    fixture,
  }) => {
    const t1 = fixture.terminal("t1")
    const url = `http://localhost:5173/${"long/".repeat(60)}`
    const shown = await fixture.items.show(t1, { url })
    const content = await fixture.items.load(shown.ok ? shown.id : "", false)
    expect(content).toMatchObject({ state: "ready", content: { kind: "page", url } })
    expect(itemContent.parse(content)).toEqual(content)
  })

  it("holds a file that may hold secrets until revealed", async ({ fixture }) => {
    writeFileSync(join(fixture.directory, ".env"), "TOKEN=x\n")
    const t1 = fixture.terminal("t1")
    const shown = await fixture.items.show(t1, { path: ".env" })
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
    const t1 = fixture.terminal("t1")
    const plan = { source: { kind: "file", path } as const, path }
    await fixture.items.planObserved(t1, slot, plan, 100)
    const [item] = fixture.items.bar(t1.terminalId)
    expect(item).toMatchObject({
      kind: "plan",
      name: "Fix the login redirect",
      detail: path,
      path,
      version: 1,
      plan: { agent: "claude", role: "root", source: "file" },
    })
    // A replay, as after a restart, marks nothing new.
    await fixture.items.planObserved(t1, slot, plan, 100)
    expect(fixture.items.bar(t1.terminalId)).toMatchObject([{ id: item!.id, version: 1 }])
    writeFileSync(path, "# Fix the redirect, take two\n")
    await fixture.items.planObserved(t1, slot, plan, 200)
    expect(fixture.items.bar(t1.terminalId)).toMatchObject([
      { id: item!.id, version: 2, name: "Fix the redirect, take two" },
    ])
    await expect(fixture.items.load(item!.id, false)).resolves.toMatchObject({
      content: { kind: "plan", text: "# Fix the redirect, take two\n" },
    })
    // An older observation of another file, as a late replay, changes nothing.
    const older = join(fixture.directory, "older.md")
    writeFileSync(older, "# Older\n")
    await fixture.items.planObserved(
      t1,
      slot,
      { source: { kind: "file", path: older }, path: older },
      150,
    )
    expect(fixture.items.bar(t1.terminalId)).toMatchObject([
      { id: item!.id, version: 2, name: "Fix the redirect, take two", path },
    ])
    expect(fixture.items.listing(t1.terminalId)).toBe(
      [
        "Showing beside your terminal in NovaDeck (1):",
        `- plan "Fix the redirect, take two": ${path} (your plan)`,
      ].join("\n"),
    )
  })

  it("go from their own bar once another session binds there, moved ones staying", async ({
    fixture,
  }) => {
    const path = join(fixture.directory, "p.md")
    writeFileSync(path, "# P\n")
    const t1 = fixture.terminal("t1")
    const t2 = fixture.terminal("t2")
    const plan = { source: { kind: "file", path } as const, path }
    await fixture.items.planObserved(t1, slot, plan, 1)
    await fixture.items.planObserved(t1, { ...slot, actor: "sub" }, plan, 1)
    const [root, sub] = fixture.items.bar(t1.terminalId)
    expect(sub).toMatchObject({ plan: { role: "subagent" } })
    fixture.items.move(sub!.id, t2.terminalId)
    // Moved away, the replay of what it holds adds nothing to the origin bar.
    await fixture.items.planObserved(t1, { ...slot, actor: "sub" }, plan, 1)
    expect(fixture.items.bar(t1.terminalId)).toEqual([root])
    fixture.items.sessionBound(t1.terminalId, "s1")
    expect(fixture.items.bar(t1.terminalId)).toEqual([root])
    fixture.items.sessionBound(t1.terminalId, "s2")
    expect(fixture.items.bar(t1.terminalId)).toEqual([])
    expect(fixture.items.bar(t2.terminalId)).toMatchObject([{ id: sub!.id }])
    // A plan of the earlier session, observed as the new one bound, is not mirrored.
    await fixture.items.planObserved(t1, slot, plan, 2)
    expect(fixture.items.bar(t1.terminalId)).toEqual([])
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
    const t1 = fixture.terminal("t1")
    const t2 = fixture.terminal("t2")
    const source = { kind: "text", text: "# Live plan", truncated: false } as const
    await fixture.items.planObserved(t1, slot, { source, path: transcript }, 1)
    const [item] = fixture.items.bar(t1.terminalId)
    expect(item).toMatchObject({
      name: "Live plan",
      path: transcript,
      plan: { source: "text" },
      detail: "In Claude Code's conversation",
    })
    expect(fixture.items.listing(t1.terminalId)).toContain(
      '- plan "Live plan" (in your conversation)',
    )
    // While its terminal runs the session, what it has live comes first.
    fixture.live.set(item!.id, { text: "# Live plan", truncated: false, changedAt: 1 })
    await expect(fixture.items.load(item!.id, false)).resolves.toMatchObject({
      content: { text: "# Live plan" },
    })
    // Moved away and its terminal closed, the transcript still has it.
    fixture.items.move(item!.id, t2.terminalId)
    fixture.live.clear()
    fixture.close(t1.terminalId)
    await expect(fixture.items.load(item!.id, false)).resolves.toMatchObject({
      state: "ready",
      content: { kind: "plan", text: "# From the transcript" },
    })
    expect(fixture.items.listing(t2.terminalId)).toContain(
      `- plan "Live plan": ${transcript} (placed here from t1, its agent's plan)`,
    )
  })
})
