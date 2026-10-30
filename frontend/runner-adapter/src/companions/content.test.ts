import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  itemIdOf,
  pageTroublesPerCall,
  PlanUnwritableError,
  type ItemContent,
} from "@novadeck/core/items"
import {
  maxPageTroubles,
  pageTrouble,
  type ItemContent as RunnerContent,
  type PlanSaveResult,
} from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"
import { vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { startTestRunner } from "../testing/runner"
import { channel } from "../testing/scripted"
import { createRunnerCompanions, itemOf, windowOf } from "./content"

const target = { projectId: "p", workspaceSessionId: "s" }
const hero = itemIdOf("hero")

// Items over a runner whose content streams the test feeds.
const following = ({ livePages = false } = {}) => {
  const streams = new Map<string, ReturnType<typeof channel<RunnerContent>>>()
  const asked: { readonly itemId: string; readonly reveal: string | undefined }[] = []
  const opened: unknown[] = []
  const projectOpened = {
    item: {
      id: "pi",
      sessionId: "s",
      holder: { windowId: "pw" },
      kind: "file" as const,
      name: "a.ts",
      detail: "src/a.ts",
      path: "/p/src/a.ts",
      url: null,
      lines: null,
      secret: false,
      by: "person" as const,
      from: null,
      version: 2,
      openAsked: true,
      shownAt: 3,
      plan: null,
    },
    window: {
      id: "pw",
      sessionId: "s",
      home: "project" as const,
      itemId: "pi",
      title: "a.ts",
      titleSource: { kind: "default" as const },
    },
  }
  const saves: { itemId: string; text: string; basedOn: string }[] = []
  let saving: PlanSaveResult = { saved: true, stamp: "b2" }
  let failure: unknown
  const companions = createRunnerCompanions(
    {
      content: (itemId, options) => {
        asked.push({ itemId, reveal: options?.reveal })
        const stream = channel<RunnerContent>()
        streams.set(itemId, stream)
        return stream.iterator
      },
      save: async (input) => {
        saves.push(input)
        if (failure) throw failure
        return saving
      },
      openInProject: async (input) => {
        opened.push(input)
        return projectOpened
      },
      pageTrouble: async () => {},
    },
    { livePages },
  )
  const seen: ItemContent[] = []
  const follow = (reveal?: string) =>
    companions.follow(target, hero, { reveal }, (content) => seen.push(content))
  return {
    companions,
    asked,
    opened,
    projectOpened,
    saves,
    saveFails: (error: unknown) => {
      failure = error
    },
    saveReturns: (result: PlanSaveResult) => {
      saving = result
    },
    seen,
    follow,
    push: (content: RunnerContent) => streams.get(hero)?.push(content),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("a picture of a live page", () => {
  // Never asked here: only the picture is.
  const runner = {} as Parameters<typeof createRunnerCompanions>[0]
  const picture = async (page: number, width?: number) => `data:image/jpeg;base64,${page}-${width}`

  it("is the app's to take, where pages load live", async () => {
    const companions = createRunnerCompanions(runner, { livePages: true, picture })
    expect(await companions.picture?.(7, 640)).toBe("data:image/jpeg;base64,7-640")
  })

  it("is none where pages don't load live, or the app takes none", () => {
    expect(createRunnerCompanions(runner, { picture }).picture).toBeUndefined()
    expect(createRunnerCompanions(runner, { livePages: true }).picture).toBeUndefined()
  })
})

describe("a live page made a phone's", () => {
  const runner = {} as Parameters<typeof createRunnerCompanions>[0]
  const phone = async (page: number, asPhone: boolean) => page === 7 && asPhone

  it("is the app's to make, where pages load live, and nothing otherwise", async () => {
    expect(await createRunnerCompanions(runner, { livePages: true, phone }).phone?.(7, true)).toBe(
      true,
    )
    expect(createRunnerCompanions(runner, { phone }).phone).toBeUndefined()
    expect(createRunnerCompanions(runner, { livePages: true }).phone).toBeUndefined()
  })
})

describe("the runner's companion content", () => {
  it("follows what an item holds, revealed only for the file asked", async () => {
    const app = following()
    app.follow("/p/hero.png")
    app.push({
      state: "ready",
      stamp: "1",
      content: { kind: "image", src: "data:image/png;base64," },
    })
    await settle()
    expect(app.asked).toEqual([{ itemId: "hero", reveal: "/p/hero.png" }])
    expect(app.seen).toEqual([
      { state: "ready", stamp: "1", content: { kind: "image", src: "data:image/png;base64," } },
    ])
  })

  it("loads a page live where the app can", async () => {
    const app = following({ livePages: true })
    app.follow()
    app.push({
      state: "ready",
      stamp: "1",
      content: { kind: "page", url: "http://localhost/", shown: 1 },
    })
    await settle()
    expect(app.seen[0]).toMatchObject({ content: { kind: "page", live: true } })
  })

  it("gives a change as the runner reads it, file by file", async () => {
    const app = following({ livePages: true })
    app.follow()
    const content = {
      kind: "changes" as const,
      root: "/repo",
      base: "HEAD",
      truncated: false,
      files: [
        {
          path: "a.ts",
          oldPath: "b.ts",
          status: "renamed" as const,
          added: 1,
          removed: 1,
          binary: false,
          secret: false,
          listed: false,
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 1,
              lines: [
                { kind: "remove" as const, text: "x" },
                { kind: "add" as const, text: "y" },
              ],
            },
          ],
        },
      ],
    }
    app.push({ state: "ready", stamp: "1", content })
    await settle()
    expect(app.seen).toEqual([{ state: "ready", stamp: "1", content }])
  })

  it("gives a plan as the runner says it can be written, without saying when it changed", async () => {
    const app = following()
    app.follow()
    app.push({
      state: "ready",
      stamp: "a1",
      content: {
        kind: "plan",
        text: "# Plan\n",
        truncated: false,
        changedAt: 5,
        writable: true,
        skill: true,
      },
    })
    app.push({
      state: "ready",
      stamp: "a2",
      content: {
        kind: "plan",
        text: "# Plan\n",
        truncated: false,
        changedAt: 5,
        writable: false,
        skill: false,
      },
    })
    await settle()
    expect(app.seen).toEqual([
      {
        state: "ready",
        stamp: "a1",
        content: { kind: "plan", text: "# Plan\n", truncated: false, writable: true, skill: true },
      },
      {
        state: "ready",
        stamp: "a2",
        content: {
          kind: "plan",
          text: "# Plan\n",
          truncated: false,
          writable: false,
          skill: false,
        },
      },
    ])
  })

  it("saves an edit through the runner, or hands back the plan as it now stands", async () => {
    const app = following()
    await expect(app.companions.save(target, hero, "# New\n", "a1")).resolves.toEqual({
      saved: true,
      stamp: "b2",
    })
    expect(app.saves).toEqual([{ itemId: "hero", text: "# New\n", basedOn: "a1" }])
    app.saveReturns({
      saved: false,
      current: { stamp: "c3", text: "# Theirs\n", truncated: false, skill: true },
    })
    await expect(app.companions.save(target, hero, "# New\n", "a1")).resolves.toEqual({
      saved: false,
      current: {
        stamp: "c3",
        plan: {
          kind: "plan",
          text: "# Theirs\n",
          truncated: false,
          writable: true,
          skill: true,
        },
      },
    })
  })

  it("says why a plan can't be written, and leaves any other failure as it is", async () => {
    const app = following()
    for (const reason of ["gone", "folder", "transcript", "too-large", "not-a-plan"]) {
      app.saveFails(new WireError("PLAN_UNWRITABLE", "no", { data: { reason } }))
      // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
      const rejected = await app.companions.save(target, hero, "# New\n", "a1").catch((e) => e)
      expect(rejected).toBeInstanceOf(PlanUnwritableError)
      expect(rejected.reason).toBe(reason)
    }
    // Without a reason the runner can give, or with another code, the failure may pass.
    const unreasoned = new WireError("PLAN_UNWRITABLE", "no", { data: { reason: "other" } })
    app.saveFails(unreasoned)
    await expect(app.companions.save(target, hero, "# New\n", "a1")).rejects.toBe(unreasoned)
    const dropped = new WireError("DISCONNECTED")
    app.saveFails(dropped)
    await expect(app.companions.save(target, hero, "# New\n", "a1")).rejects.toBe(dropped)
  })

  it("passes on a file cut short or pointing past its end", async () => {
    const app = following()
    app.follow()
    const file = {
      kind: "file" as const,
      path: "/p/log",
      firstLine: 1,
      lines: ["a"],
      from: 1,
      to: 1,
      total: null,
      truncated: true,
      clamped: true,
    }
    app.push({ state: "ready", stamp: "1", content: file })
    await settle()
    expect(app.seen[0]).toEqual({ state: "ready", stamp: "1", content: file })
  })

  it("says why each thing can't show", async () => {
    const app = following()
    app.follow()
    const reasons = [
      "missing",
      "unreadable",
      "not-a-file",
      "too-large",
      "binary",
      "secret",
      "gone",
    ] as const
    for (const reason of reasons) app.push({ state: "unavailable", reason, size: 12 })
    await settle()
    expect(app.seen).toEqual(reasons.map((reason) => ({ state: "unavailable", reason, size: 12 })))
  })

  context("on a real runner", () => {
    it("shows an item it doesn't have, or one deleted since, as gone", async () => {
      const runner = await startTestRunner()
      try {
        const seen: ItemContent[] = []
        const companions = createRunnerCompanions(runner.client.companions)
        companions.follow(target, itemIdOf(crypto.randomUUID()), { reveal: undefined }, (content) =>
          seen.push(content),
        )
        await vi.waitFor(() =>
          expect(seen).toEqual([{ state: "unavailable", reason: "gone", size: null }]),
        )
        const terminal = await runner.client.terminals.create({
          id: crypto.randomUUID(),
          sessionId: runner.listing[0]!.sessions[0]!.session.id,
          cols: 80,
          rows: 24,
        })
        const directory = await mkdtemp(join(tmpdir(), "novadeck-content-"))
        await writeFile(join(directory, "notes.md"), "# Notes\n")
        const item = await runner.client.companions.attach({
          terminalId: terminal.id,
          path: join(directory, "notes.md"),
        })
        const later: ItemContent[] = []
        companions.follow(target, itemIdOf(item.id), { reveal: undefined }, (content) =>
          later.push(content),
        )
        await vi.waitFor(() => expect(later[0]).toMatchObject({ state: "ready" }))
        // Only a plan in a file is written: a file is no plan, and an unknown item no item.
        await expect(
          runner.client.companions.save({ itemId: item.id, text: "x", basedOn: "" }),
        ).rejects.toMatchObject({ code: "PLAN_UNWRITABLE", data: { reason: "not-a-plan" } })
        await expect(
          runner.client.companions.save({ itemId: crypto.randomUUID(), text: "x", basedOn: "" }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" })
        await runner.client.companions.close(item.id)
        await vi.waitFor(() =>
          expect(later.at(-1)).toEqual({ state: "unavailable", reason: "gone", size: null }),
        )
      } finally {
        await runner.close()
      }
    })
  })

  it("reports nothing once stopped", async () => {
    const app = following()
    const stop = app.follow()
    stop()
    app.push({ state: "unavailable", reason: "missing", size: null })
    await settle()
    expect(app.seen).toEqual([])
  })

  it("keeps a plan the runner found cut short read-only after a conflict", async () => {
    const app = following()
    app.saveReturns({
      saved: false,
      current: { stamp: "c3", text: "# Long", truncated: true, skill: false },
    })
    await expect(app.companions.save(target, hero, "x", "a1")).resolves.toMatchObject({
      current: { plan: { truncated: true, writable: false } },
    })
  })

  it("opens a file in the session's project window, and maps what the runner made", async () => {
    const app = following()
    const result = await app.companions.openInProject!(target, "src/a.ts", "pw")
    expect(app.opened).toEqual([{ sessionId: "s", path: "src/a.ts", windowId: "pw" }])
    expect(result.item).toMatchObject({ id: "pi", from: null, by: "person", version: 2 })
    expect(result.item).not.toHaveProperty("sessionId")
    expect(result.window).toEqual({
      id: "pw",
      home: "project",
      itemId: "pi",
      name: "a.ts",
      titleSource: { kind: "default" },
    })
  })
})

describe("the runner's items and windows", () => {
  it("name a plan's agent as the person knows it, and leave out the session", () => {
    const item = itemOf({
      id: "plan",
      sessionId: "s",
      holder: { terminalId: "t" },
      kind: "plan",
      name: "Plan",
      detail: "",
      path: "/p/plan.md",
      url: null,
      lines: null,
      secret: false,
      by: "agent",
      from: { terminalId: "t", handle: "moth" },
      version: 2,
      openAsked: false,
      shownAt: 1,
      plan: { agent: "codex", role: "root", source: "text" },
    })
    expect(item).not.toHaveProperty("sessionId")
    expect(item.plan).toEqual({ agent: "Codex", role: "root", source: "text" })
  })

  it("name a window by its title", () => {
    expect(
      windowOf({
        id: "w",
        sessionId: "s",
        itemId: "hero",
        home: "undocked",
        title: "Hero",
        titleSource: { kind: "person" },
      }),
    ).toEqual({
      id: "w",
      home: "undocked",
      itemId: "hero",
      name: "Hero",
      titleSource: { kind: "person" },
    })
  })
})

describe("what a page shows wrong", () => {
  const told = () => {
    const calls: { itemId: string; shown: number; troubles: readonly unknown[] }[] = []
    let failure: unknown
    const companions = createRunnerCompanions({
      content: () => channel<RunnerContent>().iterator,
      save: () => Promise.reject(new Error("unused")),
      openInProject: () => Promise.reject(new Error("unused")),
      pageTrouble: async (input) => {
        calls.push(input)
        if (failure) throw failure
        return undefined as never
      },
    })
    return {
      companions,
      calls,
      fails: (error: unknown) => {
        failure = error
      },
    }
  }

  it("tells the runner, as its schema has it, what the page showed wrong", async () => {
    const app = told()
    app.companions.trouble(target, hero, 3, [
      { kind: "error", text: "x".repeat(5000), source: "s".repeat(5000), line: 2.7 },
      { kind: "request", url: "u".repeat(5000), status: 1200, what: "w".repeat(100) },
      { kind: "load", text: "l".repeat(1000) },
    ])
    await settle()
    expect(app.calls).toHaveLength(1)
    const [call] = app.calls
    expect(call).toMatchObject({ itemId: "hero", shown: 3 })
    for (const trouble of call!.troubles) expect(pageTrouble.safeParse(trouble).success).toBe(true)
    expect(call!.troubles[0]).toMatchObject({ kind: "error", line: 2 })
    expect(call!.troubles[1]).toMatchObject({ kind: "request", status: 999 })
  })

  it("tells no more at a time than the runner takes, and nothing when there is nothing", async () => {
    const app = told()
    app.companions.trouble(target, hero, 1, [])
    app.companions.trouble(
      target,
      hero,
      1,
      Array.from({ length: maxPageTroubles + 5 }, () => ({ kind: "load" as const, text: "down" })),
    )
    await settle()
    expect(pageTroublesPerCall).toBe(maxPageTroubles)
    expect(app.calls.map((call) => call.troubles.length)).toEqual([maxPageTroubles])
  })

  it("clips text without splitting a character, and takes a line that isn't a number as 0", async () => {
    const app = told()
    const text = `${"x".repeat(255)}\u{1F600}`
    app.companions.trouble(target, hero, 1, [
      { kind: "load", text },
      { kind: "error", text: "e", source: "s", line: Infinity },
    ])
    await settle()
    const [load, error] = app.calls[0]!.troubles as { text: string; line: number }[]
    expect(load!.text).toBe("x".repeat(255))
    expect(pageTrouble.safeParse(error).success).toBe(true)
    expect(error!.line).toBe(0)
  })

  it("lets it go if the runner won't take it", async () => {
    const app = told()
    app.fails(new WireError("NOT_FOUND", "No such item"))
    expect(() =>
      app.companions.trouble(target, hero, 1, [{ kind: "load", text: "down" }]),
    ).not.toThrow()
    await settle()
    expect(app.calls).toHaveLength(1)
  })
})
