import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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

describe("a yielded command's permission", () => {
  const capture = JSON.parse(
    readFileSync(new URL("./fixtures/yielded-permission.probe.json", import.meta.url), "utf8"),
  ) as {
    hooks: { kind: string; event: string; payload?: Report["payload"] }[]
    completion: { payload: { item: Record<string, unknown> } }
  }
  const payload = capture.hooks.find(
    (hook) => hook.kind === "start" && hook.event === "PermissionRequest",
  )!.payload!
  const asked = (actor: string | null) =>
    decode({
      terminalId: "t",
      token: "0".repeat(48),
      agent: "codex",
      event: "PermissionRequest",
      seq: 0,
      instance: session.instance,
      env: { cursor: false },
      payload: { ...payload, session_id: session.sessionId, agent_id: actor },
    })[0]!
  const completed = (fields = {}) =>
    JSON.stringify({
      timestamp: "2026-11-12T12:00:00Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { ...capture.completion.payload.item, ...fields },
      },
    })

  it("settles the exact request its missing PostToolUse would have settled", () => {
    expect(capture.hooks.some((hook) => hook.event === "PostToolUse")).toBe(false)
    const request = asked(null)
    expect(rolloutEvents(completed(), session)).toContainEqual({
      type: "attention-resolved",
      agent: "codex",
      ...session,
      startedAt: Date.parse("2026-11-12T12:00:00Z"),
      requestId: "requestId" in request ? request.requestId : undefined,
      actor: null,
      toolName: "Bash",
      loose: false,
      outcome: "settled",
    })
    expect(rolloutEvents(completed({ status: "failed", exit_code: 3 }), session)).toContainEqual(
      expect.objectContaining({ type: "attention-resolved", outcome: "settled" }),
    )
  })

  it("uses the subagent's identity for its own command, never its root's", () => {
    const events = subagentEvents(completed(), session, "a1", 0)
    expect(events).toMatchObject([
      { actor: "a1", requestId: (asked("a1") as { requestId: string }).requestId },
    ])
    expect(events[0]).not.toHaveProperty(
      "requestId",
      (asked(null) as { requestId: string }).requestId,
    )
    expect(subagentEvents(completed(), session, "a1", Date.parse("2026-11-12T12:00:01Z"))).toEqual(
      [],
    )
  })

  it("takes no user command, uncompleted command, denied request or malformed argv as execution", () => {
    for (const fields of [
      { source: "user_shell" },
      { status: "inProgress" },
      { status: "declined" },
      { command: [] },
      { command: ["bash", "-lc", 42] },
    ])
      expect(
        rolloutEvents(completed(fields), session).some(
          (event) => event.type === "attention-resolved",
        ),
      ).toBe(false)
  })
})

describe("following a rollout", () => {
  let folder: string | undefined
  afterEach(() => {
    if (folder) rmSync(folder, { recursive: true, force: true })
    folder = undefined
  })

  it("keeps separate command settlements from its first read, up to the pending-request limit", async () => {
    folder = mkdtempSync(join(tmpdir(), "novadeck-rollout-"))
    const path = join(folder, "rollout.jsonl")
    writeFileSync(
      path,
      Array.from({ length: 35 }, (_, index) =>
        JSON.stringify({
          timestamp: `2026-11-12T12:00:${String(index).padStart(2, "0")}Z`,
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "CommandExecution",
              command: ["bash", "-lc", `echo ${index}`],
              status: "completed",
            },
          },
        }),
      ).join("\n") + "\n",
    )
    const told: HarnessEvent[] = []
    let received!: () => void
    const ready = new Promise<void>((resolve) => {
      received = resolve
    })
    const controller = new AbortController()
    const following = followRollout(
      { ...session, transcript: path },
      controller.signal,
      (event) => {
        told.push(event)
        if (told.filter((held) => held.type === "attention-resolved").length === 32) received()
      },
    )
    try {
      await ready
      const last = told.filter((event) => event.type === "attention-resolved")
      expect(new Set(last.map((event) => event.requestId)).size).toBe(32)
      expect(last[0]?.startedAt).toBe(Date.parse("2026-11-12T12:00:03Z"))
    } finally {
      controller.abort()
      await following
    }
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

  it("holds its backlog until the file appears, then tells the latest of it alone", async () => {
    folder = mkdtempSync(join(tmpdir(), "novadeck-rollout-"))
    const path = join(folder, "rollout.jsonl")
    const told: HarnessEvent[] = []
    const controller = new AbortController()
    const following = followRollout({ ...session, transcript: path }, controller.signal, (event) =>
      told.push(event),
    )
    try {
      // Polls that find no file go by first.
      await new Promise((resolve) => setTimeout(resolve, 1000))
      writeFileSync(
        path,
        ["10:00", "10:01", "10:02"]
          .map((at, index) => `${ended(`t${index + 1}`, `2026-11-01T${at}:00Z`)}\n`)
          .join(""),
      )
      await expect.poll(() => turns(told), { timeout: 5000 }).toEqual(["t3"])
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
