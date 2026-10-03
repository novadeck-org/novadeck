import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ItemContent as RunnerContent } from "@novadeck/protocol"
import { vi } from "vitest"

import { itemIdOf, type ItemContent } from "../../model/companion"
import { context, describe, expect, it } from "../../test"
import { createRunnerCompanions, itemOf, windowOf } from "./companions"
import { channel } from "./scripted"
import { startTestRunner } from "./testing"

const target = { projectId: "p", workspaceSessionId: "s" }
const hero = itemIdOf("hero")

// Companions over a runner whose content streams the test feeds.
const following = ({ livePages = false } = {}) => {
  const streams = new Map<string, ReturnType<typeof channel<RunnerContent>>>()
  const asked: { readonly itemId: string; readonly reveal: boolean | undefined }[] = []
  const attached: unknown[] = []
  const companions = createRunnerCompanions(
    {
      content: (itemId, options) => {
        asked.push({ itemId, reveal: options?.reveal })
        const stream = channel<RunnerContent>()
        streams.set(itemId, stream)
        return stream.iterator
      },
      attach: async (input) => {
        attached.push(input)
        return undefined as never
      },
    },
    { livePages },
  )
  const seen: ItemContent[] = []
  const follow = (reveal = false) =>
    companions.follow(target, hero, { reveal }, (content) => seen.push(content))
  return {
    companions,
    asked,
    attached,
    seen,
    follow,
    push: (content: RunnerContent) => streams.get(hero)?.push(content),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the runner's companion content", () => {
  it("follows what an item holds, revealed only when asked", async () => {
    const app = following()
    app.follow(true)
    app.push({
      state: "ready",
      stamp: "1",
      content: { kind: "image", src: "data:image/png;base64," },
    })
    await settle()
    expect(app.asked).toEqual([{ itemId: "hero", reveal: true }])
    expect(app.seen).toEqual([
      { state: "ready", stamp: "1", content: { kind: "image", src: "data:image/png;base64," } },
    ])
  })

  it("loads a page live where the host can", async () => {
    const app = following({ livePages: true })
    app.follow()
    app.push({ state: "ready", stamp: "1", content: { kind: "page", url: "http://localhost/" } })
    await settle()
    expect(app.seen[0]).toMatchObject({ content: { kind: "page", live: true } })
  })

  it("gives a plan as read-only, without saying when it changed", async () => {
    const app = following()
    app.follow()
    app.push({
      state: "ready",
      stamp: "a1",
      content: { kind: "plan", text: "# Plan\n", truncated: false, changedAt: 5 },
    })
    await settle()
    expect(app.seen).toEqual([
      {
        state: "ready",
        stamp: "a1",
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
      "held",
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
        companions.follow(target, itemIdOf(crypto.randomUUID()), { reveal: false }, (content) =>
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
        companions.follow(target, itemIdOf(item.id), { reveal: false }, (content) =>
          later.push(content),
        )
        await vi.waitFor(() => expect(later[0]).toMatchObject({ state: "ready" }))
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

  it("rejects saving a plan, and attaches a file to a terminal", async () => {
    const app = following()
    await expect(app.companions.save(target, hero, "text", "1")).rejects.toThrow()
    await app.companions.attach!({ ...target, terminalId: "t" }, "/p/notes.md")
    expect(app.attached).toEqual([{ terminalId: "t", path: "/p/notes.md" }])
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
      held: false,
      by: "agent",
      from: { terminalId: "t", handle: "t1" },
      version: 2,
      asked: false,
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
        title: "Hero",
        titleSource: { kind: "person" },
      }),
    ).toEqual({ id: "w", itemId: "hero", name: "Hero", titleSource: { kind: "person" } })
  })
})
