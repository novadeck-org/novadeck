import type { HarnessEvent } from "@novadeck/harness-core/events"
import { vi } from "vitest"

import { harnesses } from "../../harnesses/registry.js"
import { describe, expect, it } from "../../test.js"
import type { Record } from "../record.js"
import { Reports, type ReportsHost } from "./reports.js"

describe("a root turn's prompt told from the transcript", () => {
  // Their hooks name the prompt (UserPromptSubmit), so a session bound at its prompt, as a
  // resumed one, takes its first prompt as any other: nothing is read or changed.
  for (const agent of ["claude", "codex"] as const)
    it(`leaves ${agent}'s turns as its hooks told them`, async () => {
      expect(harnesses[agent].messaging.typedEntry).toBeUndefined()
      const record = {
        summary: { id: "T" },
        root: { agent, sessionId: "s", instance: "1", source: "status-line" },
        transcript: "/t.jsonl",
        seenEntry: undefined,
      } as unknown as Record
      const events: HarnessEvent[] = [
        {
          type: "turn-started",
          agent,
          sessionId: "s",
          instance: "1",
          startedAt: 1,
          cause: "prompt",
        },
      ]
      // A host that fails any use: none is needed.
      const reports = new Reports(new Proxy({}, { get: () => () => expect.fail() }) as ReportsHost)
      expect(await reports.attributed(record, events)).toBe(events)
      expect(record.seenEntry).toBeUndefined()
    })
})

describe("the screen an agent says it is at before its first session", () => {
  const saying = async (agent: "agy" | "claude", expecting: string, state: string) => {
    const record = {
      token: "tok",
      expecting,
      startupScreen: undefined,
      terminal: { exiting: false },
      bound: null,
    } as unknown as Record
    const reports = new Reports({
      records: () => new Map([["T", record]]),
      bindings: () => ({}),
    } as unknown as ReportsHost)
    await reports.report({
      terminalId: "T",
      token: "tok",
      agent,
      event: "StatusLine",
      seq: 1,
      instance: null,
      env: { cursor: false },
      payload: { agent_state: state, conversation_id: "" },
    })
    return record.startupScreen
  }

  it("is kept from the agent expected there", async () => {
    expect(await saying("agy", "agy", "authenticating")).toBe("sign-in")
  })

  it("isn't taken from any other agent, as a job its shell runs first", async () => {
    expect(await saying("agy", "claude", "authenticating")).toBeUndefined()
  })
})

describe("the bound session's transcript, named by a later hook", () => {
  const hook = (agent: "claude" | "codex", sessionId: string) => ({
    terminalId: "T",
    token: "tok",
    agent,
    event: "Nothing", // A hook the harness decodes to no event.
    seq: 1,
    instance: null,
    env: { cursor: false },
    payload: { session_id: sessionId, transcript_path: "/new.jsonl" },
  })
  const reportTo = async (report: ReturnType<typeof hook>) => {
    const learned = vi.fn<(...args: unknown[]) => void>()
    const record = {
      token: "tok",
      terminal: { exiting: false },
      bound: { binding: { agent: "claude", sessionId: "s1", instance: null } },
    } as unknown as Record
    const reports = new Reports({
      records: () => new Map([["T", record]]),
      bindings: () => ({ learnTranscript: learned }),
    } as unknown as ReportsHost)
    await reports.report(report)
    return learned
  }

  it("is told to the bindings for the agent bound", async () => {
    expect(await reportTo(hook("claude", "s1"))).toHaveBeenCalledWith(
      expect.anything(),
      "s1",
      "/new.jsonl",
    )
  })

  it("is not told for another agent's hook", async () => {
    expect(await reportTo(hook("codex", "s1"))).not.toHaveBeenCalled()
  })
})
