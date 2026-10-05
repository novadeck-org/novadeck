import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"

import { describe, expect, it } from "../../test.js"
import type { Install } from "../harness.js"
import { confirmingPrefix, startedSession, title, titleSetting, titleWorking } from "./title.js"

describe("Codex's terminal title", () => {
  it("shows its prompt once it says Ready, with the start of its thread's id", () => {
    expect(title("Ready | 01a0f932-a824-7c30-b713-b59ed...", 9)).toEqual({
      type: "prompt-shown",
      agent: "codex",
      instance: null,
      startedAt: 9,
      sessionPrefix: "01a0f932-a824-7c30-b713-b59ed",
    })
    // A whole id, which it doesn't cut short.
    expect(title("Ready | 01a0f932-a824-7c30-b713-b59ed562f00b", 9)).toMatchObject({
      sessionPrefix: "01a0f932-a824-7c30-b713-b59ed562f00b",
    })
  })

  it("reads the person's own title the same, whatever else it holds, in any order", () => {
    expect(title("codex | 01a0f932-a824... | myproject | Ready", 9)).toMatchObject({
      sessionPrefix: "01a0f932-a824",
    })
  })

  it("says nothing without exactly one state, Ready, and exactly one thread's id", () => {
    for (const text of [
      "Working | 01a0f932-a824-7c30-b713-b59ed...",
      "Starting | 01a0f932-a824",
      // Its state alone, as it first sets it, or with other words: no thread named.
      "Ready",
      "vim | Ready",
      "Ready | my-project",
      "w",
      "",
      // Two states, or two ids: nothing tells which is Codex's.
      "Ready | Working | 01a0f932-a824",
      "Ready | 01a0f932-a824... | 01a0f99f-0000...",
    ])
      expect(title(text, 9)).toBeUndefined()
  })

  it("is the title Novadeck's shim asks for: its state, then its thread's id", () => {
    expect(titleSetting).toBe("tui.terminal_title=['status','thread-id']")
  })
})

describe("a thread Codex just started", () => {
  const folders: string[] = []
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })
  const thread = "01a0f99f-0000-7000-8000-000000000000"
  // The start of its id the title shows, cut short as Codex cuts it.
  const shown = thread.slice(0, 29)
  // A Codex home whose writer locks are the threads given, each made at its time.
  const home = (threads: { readonly id: string; readonly at: number }[]): Install => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-codex-"))
    folders.push(folder)
    const locks = join(folder, "thread-writer-locks")
    mkdirSync(locks)
    for (const { id, at } of threads) {
      const file = join(locks, `${id}.lock`)
      writeFileSync(file, "")
      utimesSync(file, at / 1000, at / 1000)
    }
    return { env: { CODEX_HOME: folder }, home: folder, platform: process.platform, plugin: "" }
  }

  it("is one whose writer lock it made as the title came, held by its own process", async () => {
    const now = Date.now()
    const where = home([{ id: thread, at: now }])
    expect(await startedSession(where, shown, now, () => Promise.resolve(true), 0)).toBe(true)
    // Where the platform can't tell who holds it, its time alone tells.
    expect(await startedSession(where, shown, now, () => Promise.resolve(undefined), 0)).toBe(true)
    // A lock no process of the terminal's holds is another Codex's.
    expect(await startedSession(where, shown, now, () => Promise.resolve(false), 0)).toBe(false)
  })

  it("is no thread without a lock, as a /side conversation, nor one locked long before, as an agent spawned earlier", async () => {
    const now = Date.now()
    expect(await startedSession(home([]), shown, now, undefined, 0)).toBe(false)
    expect(
      await startedSession(home([{ id: thread, at: now - 60_000 }]), shown, now, undefined, 0),
    ).toBe(false)
  })

  it("never confirms a start of an id too short to tell threads of one moment apart", async () => {
    const now = Date.now()
    const where = home([{ id: thread, at: now }])
    expect(
      await startedSession(where, thread.slice(0, confirmingPrefix - 1), now, undefined, 0),
    ).toBe(false)
    expect(await startedSession(where, thread.slice(0, confirmingPrefix), now, undefined, 0)).toBe(
      true,
    )
  })

  it("waits a moment for a lock made just after the title", async () => {
    const now = Date.now()
    const where = home([])
    setTimeout(
      () => writeFileSync(join(where.home, "thread-writer-locks", `${thread}.lock`), ""),
      150,
    )
    expect(await startedSession(where, shown, now, undefined, 2_000)).toBe(true)
  })
})

describe("Codex's title saying a turn runs", () => {
  it("tells a run state past Ready and Starting", () => {
    expect(titleWorking("Working | 01a0f932-a824...")).toBe(true)
    expect(titleWorking("Thinking | 01a0f932-a824...")).toBe(true)
    expect(titleWorking("Ready | 01a0f932-a824...")).toBe(false)
    expect(titleWorking("Starting | 01a0f932-a824...")).toBe(false)
    expect(titleWorking("my own title")).toBe(false)
  })
})
