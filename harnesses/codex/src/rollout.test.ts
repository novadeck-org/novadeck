import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"
import { afterEach, describe, expect, it } from "vitest"

import { decode } from "./decode.js"
import { followRollout, rolloutEvents, subagentEvents } from "./rollout.js"

const session = { sessionId: "s", instance: "7" }

// A turn's end as a rollout records it.
const ended = (turn: string, at: string) =>
  JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turn, last_agent_message: null },
  })

const turns = (told: readonly HarnessEvent[]) =>
  told.flatMap((event) => (event.type === "turn-ended" && event.turn ? [event.turn] : []))

describe("following a rollout", () => {
  let folder: string | undefined
  afterEach(() => {
    if (folder) rmSync(folder, { recursive: true, force: true })
    folder = undefined
  })

  it("tells only what a rewritten file records past the last record read, never an old one, losing none", async () => {
    folder = mkdtempSync(join(tmpdir(), "novadeck-rollout-"))
    const path = join(folder, "rollout.jsonl")
    const times = ["10:00", "10:01", "10:02", "10:03", "10:04"].map((at) => `2026-11-01T${at}:00Z`)
    const records = (count: number) =>
      times
        .slice(0, count)
        .map((at, index) => `${ended(`t${index + 1}`, at)}\n`)
        .join("")
    writeFileSync(path, records(2))
    const told: HarnessEvent[] = []
    const controller = new AbortController()
    const following = followRollout({ ...session, transcript: path }, controller.signal, (event) =>
      told.push(event),
    )
    // Another file put in its place, as a migration or a sync tool writes one.
    const replace = (content: string) => {
      const next = join(folder!, "next.jsonl")
      writeFileSync(next, content)
      renameSync(next, path)
    }
    try {
      // Its backlog: the latest turn's end alone.
      await expect.poll(() => turns(told), { timeout: 5000 }).toEqual(["t2"])
      // The same records again: nothing is news.
      replace(records(2))
      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(turns(told)).toEqual(["t2"])
      // The same records and two more: both new ones are told, none of the old.
      replace(records(4))
      await expect.poll(() => turns(told), { timeout: 5000 }).toEqual(["t2", "t3", "t4"])
      // Appended after it, as ever.
      appendFileSync(path, records(5).split("\n").at(-2)! + "\n")
      await expect.poll(() => turns(told), { timeout: 5000 }).toEqual(["t2", "t3", "t4", "t5"])
    } finally {
      controller.abort()
      await following
    }
  })
})

describe("a subagent's MCP tool call, in its own rollout", () => {
  const input = { name: "a" }
  // Its approval, as the subagent's PermissionRequest asks it.
  const [asked] = decode({
    event: "PermissionRequest",
    seq: 0,
    instance: "7",
    env: {},
    payload: {
      session_id: "s",
      agent_id: "a1",
      tool_name: "mcp__probe__touch",
      tool_input: input,
    },
  } as unknown as Report) as readonly { requestId?: string }[]
  const completed = (at: string) =>
    JSON.stringify({
      timestamp: at,
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "McpToolCall",
          id: "call_1",
          server: "probe",
          tool: "touch",
          arguments: input,
        },
      },
    })
  const since = Date.parse("2026-11-01T10:00:00Z")

  it("settles its request once the call completes, however its approval went, as no hook says a cancel", () => {
    expect(subagentEvents(completed("2026-11-01T10:00:05Z"), session, "a1", since)).toEqual([
      {
        type: "attention-resolved",
        agent: "codex",
        sessionId: "s",
        instance: "7",
        startedAt: Date.parse("2026-11-01T10:00:05Z"),
        requestId: asked!.requestId,
        actor: "a1",
        toolName: "mcp__probe__touch",
        loose: false,
        outcome: "settled",
      },
    ])
  })

  it("settles nothing for a call completed before its request was asked", () => {
    expect(subagentEvents(completed("2026-11-01T09:59:59Z"), session, "a1", since)).toEqual([])
  })

  it("is not the root's: the root's own item names another request", () => {
    const [root] = rolloutEvents(completed("2026-11-01T10:00:05Z"), session) as readonly {
      requestId?: string
    }[]
    expect(root?.requestId).toBeDefined()
    expect(root?.requestId).not.toBe(asked!.requestId)
  })
})
