import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import type { HarnessEvent } from "./events.js"
import { doorbellLine, type UserEntry } from "./harness.js"
import { harnesses } from "./registry.js"
import type { Root } from "./roots.js"
import { lastUserInput, typedPromptStart, type TypedPrompts } from "./typed-prompts.js"

// A user input step of Antigravity's transcript, as it wraps the person's text.
const input = (text: string, step: number, at = "2026-10-01T12:00:05Z") =>
  JSON.stringify({
    step_index: step,
    created_at: at,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n</ADDITIONAL_METADATA>`,
  })

// A step of the agent's output, 300 KB of it.
const output = (step: number) =>
  JSON.stringify({
    step_index: step,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    content: "x".repeat(300 * 1024),
  })

const folder = (resources: { defer: (cleanup: () => void) => void }) => {
  const path = mkdtempSync(join(tmpdir(), "novadeck-typed-"))
  resources.defer(() => rmSync(path, { recursive: true, force: true }))
  return path
}

const root: Root = { agent: "agy", sessionId: "c-root", instance: "7", source: "status-line" }
const base = { agent: "agy", sessionId: "c-root", instance: "7", startedAt: 1 } as const
const started: HarnessEvent = { type: "turn-started", ...base, cause: "harness" }
const typedEntry = harnesses.agy.messaging.typedEntry!
const enteredAt = Date.parse("2026-10-01T12:00:05.700Z")
const line = doorbellLine("k3f9q2")

/** The turn's facts told from a transcript whose last typed entry is `entry`. */
const told = (entry: UserEntry | null, given: Partial<TypedPrompts> = {}) =>
  typedPromptStart(
    [started],
    { root, typedEntry, transcript: "/t.jsonl", seen: 9, enteredAt, ringing: undefined, ...given },
    () => Promise.resolve(entry),
    { waitMs: 2, gapMs: 1 },
  )

const entry = (text: string, id: number, at = Date.parse("2026-10-01T12:00:06Z")) => ({
  text,
  at,
  id,
})

describe("a typed prompt where hooks name none", () => {
  it("is a new typed entry's, told as Claude Code's and Codex's prompts are", async () => {
    await expect(told(entry("fix the build", 12))).resolves.toEqual({
      events: [{ ...started, cause: "prompt", prompt: "fix the build" }],
      seen: 12,
    })
    // A doorbell line typed alone: the ring's prompt, its nonce for delivery to check.
    await expect(told(entry(line, 12))).resolves.toMatchObject({
      events: [{ cause: "doorbell", nonce: "k3f9q2" }],
    })
    // A stale line left with the person's text: their prompt, the line removed.
    await expect(told(entry(`${line}fix the build`, 12))).resolves.toMatchObject({
      events: [{ cause: "prompt", prompt: "fix the build" }],
    })
  })

  it("leaves a turn nothing new was typed for as the harness's", async () => {
    await expect(told(entry("fix the build", 9))).resolves.toEqual({ events: [started], seen: 9 })
    await expect(told(null)).resolves.toEqual({ events: [started], seen: 9 })
    await expect(told({ ...entry("fix it", 12), id: null })).resolves.toEqual({
      events: [started],
      seen: 9,
    })
    // A subagent's turn, in its own conversation, is never the root's.
    const other: HarnessEvent = { ...started, sessionId: "c-sub" }
    await expect(
      typedPromptStart(
        [other],
        {
          root,
          typedEntry,
          transcript: "/t.jsonl",
          seen: 9,
          enteredAt,
          ringing: undefined,
        },
        () => Promise.resolve(entry("fix it", 12)),
      ),
    ).resolves.toEqual({ events: [other], seen: 9 })
  })

  it("before any read, takes an entry timed after the Enter, a later second than its own", async () => {
    await expect(told(entry("fix it", 1), { seen: undefined })).resolves.toMatchObject({
      events: [{ cause: "prompt" }],
      seen: 1,
    })
    // In the Enter's own second, rounded down, it may be older than the Enter: it fails safe.
    await expect(
      told(entry("fix it", 1, Date.parse("2026-10-01T12:00:05Z")), { seen: undefined }),
    ).resolves.toMatchObject({ events: [{ cause: "harness" }] })
    // With no Enter, only the very line it was started with, as `agy -i "<line>"`.
    await expect(
      told(entry(line, 0), { seen: undefined, enteredAt: undefined, startedWith: "k3f9q2" }),
    ).resolves.toMatchObject({ events: [{ cause: "doorbell", nonce: "k3f9q2" }] })
    // A stale line a resumed session's transcript still ends with: not its start's.
    await expect(
      told(entry(doorbellLine("OLD"), 4), {
        seen: undefined,
        enteredAt: undefined,
        startedWith: "k3f9q2",
      }),
    ).resolves.toMatchObject({ events: [{ cause: "harness" }] })
    await expect(
      told(entry(line, 0), { seen: undefined, enteredAt: undefined }),
    ).resolves.toMatchObject({ events: [{ cause: "harness" }] })
    await expect(
      told(entry("fix it", 0), { seen: undefined, enteredAt: undefined }),
    ).resolves.toMatchObject({ events: [{ cause: "harness" }] })
    // Nothing typed yet is seen too.
    await expect(told(null, { seen: undefined })).resolves.toMatchObject({ seen: -1 })
  })

  it("before any read, takes the line of the ring waiting on it, never a stale one", async () => {
    // A terminal the runner restored has read nothing of its resumed transcript yet.
    const restored = { seen: undefined, enteredAt: undefined, ringing: "k3f9q2" }
    await expect(told(entry(line, 7), restored)).resolves.toEqual({
      events: [{ ...started, cause: "doorbell", nonce: "k3f9q2" }],
      seen: 7,
    })
    // A line another ring left, which the transcript still ends with, or the person's text.
    await expect(told(entry(doorbellLine("OLD"), 4), restored)).resolves.toEqual({
      events: [started],
      seen: 4,
    })
    await expect(told(entry("fix it", 4), restored)).resolves.toMatchObject({
      events: [{ cause: "harness" }],
    })
  })

  it("reads Antigravity's last typed entry from its transcript, unwrapped", async ({
    resources,
  }) => {
    const transcript = join(folder(resources), "transcript.jsonl")
    writeFileSync(transcript, "")
    await expect(lastUserInput(transcript, typedEntry)).resolves.toBeNull()
    writeFileSync(transcript, `${input("hello", 0)}\n${input(line, 4)}\n`)
    await expect(lastUserInput(transcript, typedEntry)).resolves.toEqual({
      text: line,
      at: Date.parse("2026-10-01T12:00:05Z"),
      id: 4,
    })
    await expect(lastUserInput(`${transcript}.missing`, typedEntry)).resolves.toBeUndefined()
  })

  it("tells a new entry by its step after hundreds of kilobytes of the agent's output", async ({
    resources,
  }) => {
    const transcript = join(folder(resources), "transcript.jsonl")
    // Many small turns, then bulky ones: the tail holds fewer typed entries than before.
    const small = Array.from({ length: 5 }, (_, index) => input(`p${index}`, index * 2))
    writeFileSync(transcript, `${small.join("\n")}\n`)
    let seen = (await lastUserInput(transcript, typedEntry))!.id!
    const given = { root, typedEntry, transcript, enteredAt, ringing: undefined }
    for (let turn = 0; turn < 3; turn += 1) {
      appendFileSync(transcript, `${output(20 + turn * 2)}\n`)
      appendFileSync(transcript, `${input(`person prompt ${turn}`, 21 + turn * 2)}\n`)
      // eslint-disable-next-line no-await-in-loop -- Each turn reads what the last left.
      const now = await typedPromptStart([started], { ...given, seen })
      expect(now).toEqual({
        events: [{ ...started, cause: "prompt", prompt: `person prompt ${turn}` }],
        seen: 21 + turn * 2,
      })
      // The same entry, read again at a turn nobody typed for, is nothing new.
      // eslint-disable-next-line no-await-in-loop -- As above.
      const again = await typedPromptStart([started], { ...given, seen: now.seen }, undefined, {
        waitMs: 2,
        gapMs: 1,
      })
      expect(again.events).toEqual([started])
      seen = now.seen!
    }
  })
})
