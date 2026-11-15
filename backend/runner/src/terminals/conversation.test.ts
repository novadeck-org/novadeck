import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import { started } from "../harnesses/activity.js"
import { agentDetail, rootRef } from "../harnesses/detail.js"
import { describe, expect, it } from "../test.js"
import { Shown, type ShownHost } from "./binding/shown.js"
import { conversationOf, type ConversationRecord } from "./conversation.js"
import type { Record } from "./record.js"
import { followTranscript } from "./transcripts.js"

const sessionId = "11111111-2222-3333-4444-555555555555"
const resumed = (agent: AgentName, transcript = "/saved.jsonl"): ConversationRecord => ({
  bound: null,
  transcript: null,
  agents: { [agent]: { sessionId, seq: 1, transcript } },
  resumeClaim: `${agent}:${sessionId}`,
  startupRuns: true,
  expecting: agent,
})

describe("the conversation of a resumed agent before its first hook", () => {
  for (const agent of ["claude", "codex", "agy"] as const) {
    it(`gives ${agent}'s root and saved history without binding a live session`, () => {
      const record = resumed(agent)
      const found = conversationOf(record)!
      const detail = agentDetail("t1", found.binding, found.activity, null)
      expect(detail).toMatchObject({ agent, sessionId, activity: null, requests: [] })
      expect(detail.actors).toEqual([
        { ref: rootRef(found.binding), role: "root", parent: null, type: null },
      ])
      expect(found.transcript).toBe("/saved.jsonl")
      expect(record.bound).toBeNull()
    })
  }

  it("does not show a cancelled or ended resume, a fresh startup, or another saved session", () => {
    const record = resumed("codex")
    for (const changed of [
      { startupRuns: false },
      { expecting: null },
      { expecting: "claude" as const },
      { resumeClaim: undefined },
      { resumeEnded: true as const },
      { agents: { codex: { sessionId: "other", seq: 1, transcript: "/other.jsonl" } } },
      { agents: { codex: { sessionId, seq: 1 } } },
    ])
      expect(conversationOf({ ...record, ...changed })).toBeUndefined()
  })

  it("gives the live session precedence once a hook binds it", () => {
    const record = resumed("codex")
    record.bound = {
      binding: { agent: "claude", sessionId: "next", instance: "2" },
      activity: started(1),
      telemetry: null,
    }
    record.transcript = "/next.jsonl"
    expect(conversationOf(record)).toMatchObject({
      binding: { agent: "claude", sessionId: "next", instance: "2" },
      transcript: "/next.jsonl",
    })
  })

  it("hides history after a verified prompt switches threads and restores it on return", () => {
    const reader = new AbortController()
    const record = {
      ...resumed("codex"),
      summary: { id: "t1" },
      sourceReaders: new Set([reader]),
    } as unknown as Record
    const shown = new Shown({
      messaging: () => ({ shown: () => {} }),
      bindings: () => ({ publishAgent: () => {} }),
    } as unknown as ShownHost)
    const prompt = {
      type: "prompt-shown" as const,
      agent: "codex" as const,
      instance: null,
      startedAt: 1,
    }
    shown.showPrompt(record, { ...prompt, sessionPrefix: sessionId.slice(0, 8) })
    expect(conversationOf(record)).toBeDefined()
    shown.showPrompt(record, { ...prompt, sessionPrefix: "other" })
    expect(conversationOf(record)).toBeUndefined()
    expect(reader.signal.aborted).toBe(true)
    shown.showPrompt(record, { ...prompt, sessionPrefix: sessionId.slice(0, 8) })
    expect(conversationOf(record)?.binding.sessionId).toBe(sessionId)
    record.expecting = null
    shown.showPrompt(record, { ...prompt, sessionPrefix: sessionId.slice(0, 8) })
    expect(conversationOf(record)).toBeUndefined()
  })
})

describe("reading a resumed conversation", () => {
  for (const agent of ["claude", "codex", "agy"] as const) {
    it(`reads ${agent}'s saved transcript and reads again when its first hook binds`, async ({
      resources,
    }) => {
      const folder = mkdtempSync(join(tmpdir(), "novadeck-resumed-chat-"))
      resources.defer(() => rmSync(folder, { recursive: true, force: true }))
      const path =
        agent === "agy"
          ? join(folder, "brain", sessionId, ".system_generated", "logs", "transcript_full.jsonl")
          : join(folder, `${agent}.jsonl`)
      mkdirSync(join(path, ".."), { recursive: true })
      const line =
        agent === "codex"
          ? {
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Yesterday's prompt" }],
              },
            }
          : agent === "claude"
            ? { type: "user", uuid: "u1", message: { role: "user", content: "Yesterday's prompt" } }
            : {
                step_index: 0,
                source: "USER_EXPLICIT",
                type: "USER_INPUT",
                content: "<USER_REQUEST>\nYesterday's prompt\n</USER_REQUEST>",
              }
      writeFileSync(path, `${JSON.stringify(line)}\n`)
      const record = {
        ...resumed(agent, path),
        sourceReaders: new Set<AbortController>(),
        interruptions: agent === "agy" ? [{ sessionId, step: 0, at: 10 }] : [],
      } as unknown as Record
      const signal = new AbortController()
      resources.defer(() => signal.abort())
      const actor = rootRef(conversationOf(record)!.binding)
      const stream = followTranscript(record, actor, signal.signal)
      const first = await stream.next()
      expect(first.value).toMatchObject({
        type: "items",
        items: expect.arrayContaining([expect.objectContaining({ text: "Yesterday's prompt" })]),
      })
      if (agent === "agy")
        expect(first.value).toMatchObject({
          items: expect.arrayContaining([expect.objectContaining({ interrupted: true, at: 10 })]),
        })
      // Binding follows the session's sources anew and aborts its earlier readers.
      record.bound = {
        binding: { agent, sessionId, instance: "2" },
        activity: started(1),
        telemetry: null,
      }
      record.transcript = path
      for (const reader of record.sourceReaders) reader.abort()
      await expect(stream.next()).rejects.toMatchObject({ code: "NOT_FOUND" })
      const live = followTranscript(record, actor, signal.signal)
      expect((await live.next()).value).toMatchObject({
        type: "items",
        items: expect.arrayContaining([expect.objectContaining({ text: "Yesterday's prompt" })]),
      })
      signal.abort()
      await live.return(undefined)
    })
  }
})
