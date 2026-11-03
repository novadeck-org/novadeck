import type { HarnessEvent } from "@novadeck/harness-core/events"

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
