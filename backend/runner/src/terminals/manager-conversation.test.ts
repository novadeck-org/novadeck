import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { ptyOptions } from "../testing/pty.js"
import { plainSealer } from "../testing/sealing.js"
import type { Shown } from "./binding/shown.js"
import { Terminals } from "./manager.js"
import type { Record } from "./record.js"

type Inside = {
  records: Map<string, Record>
  keyed: (record: Record, data: string) => void
  shown: Shown
  bindings: {
    endBinding: (record: Record) => boolean
    forgetAgent: (records: Iterable<Record>, agent: "codex") => void
  }
}

const it = base.extend<{
  resumed: {
    manager: Terminals
    inside: Inside
    record: Record
    sessionId: string
    folder: string
    signal: AbortSignal
  }
}>({
  resumed: async ({ resources }, use) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-chat-resume-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const manager = new Terminals({
      ...ptyOptions,
      redactor: { redact: async ({ text }) => text, close: async () => {} },
      sealer: plainSealer(),
    })
    resources.defer(() => manager.shutdown())
    const controller = new AbortController()
    resources.defer(() => controller.abort())
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "workspace", cwd: folder, cols: 80, rows: 24 },
      "creator",
    )
    const inside = manager as unknown as Inside
    const record = inside.records.get(terminal.id)!
    const sessionId = randomUUID()
    const transcript = join(folder, "rollout.jsonl")
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Yesterday's answer" }],
        },
      })}\n`,
    )
    record.agents = { codex: { sessionId, seq: 1, transcript } }
    record.resumeClaim = `codex:${sessionId}`
    record.startupRuns = true
    record.expecting = "codex"
    await use({ manager, inside, record, sessionId, folder, signal: controller.signal })
  },
})

describe("an open chat while its agent resumes", () => {
  for (const action of ["cancel", "clear", "exit", "disconnect"] as const) {
    it(`withdraws the saved conversation when the person chooses ${action}`, async ({
      resumed,
    }) => {
      const { manager, inside, record, sessionId, folder, signal } = resumed
      const detail = manager.detail(record.summary.id, signal)
      const first = await detail.next()
      if (first.done) throw new Error("The resumed terminal's detail ended")
      expect(first.value).toMatchObject({ sessionId, activity: null, requests: [] })
      const root = first.value!.actors.find((actor) => actor.role === "root")!.ref
      const transcript = manager.transcript(record.summary.id, root, signal)
      expect((await transcript.next()).value).toMatchObject({
        type: "items",
        items: [{ text: "Yesterday's answer" }],
      })
      expect(record.bound).toBeNull()

      if (action === "cancel") {
        record.resumeFile = join(folder, "resume.sh")
        writeFileSync(record.resumeFile, "pending resume")
        inside.keyed(record, "x")
      } else if (action === "clear") {
        inside.shown.showPrompt(record, {
          type: "prompt-shown",
          agent: "codex",
          instance: null,
          sessionPrefix: "different-thread",
          startedAt: Date.now(),
        })
      } else if (action === "disconnect") {
        // Another harness's saved session keeps agentRan true after Codex is forgotten.
        record.agents = { ...record.agents, claude: { sessionId: "earlier", seq: 0 } }
        record.summary = { ...record.summary, agentRan: true }
        inside.bindings.forgetAgent([record], "codex")
      } else inside.bindings.endBinding(record)

      expect((await detail.next()).value).toMatchObject({ sessionId: null, actors: [] })
      expect(await transcript.next()).toMatchObject({ done: true })
      expect(record.sourceReaders.size).toBe(0)

      if (action === "clear") {
        inside.shown.showPrompt(record, {
          type: "prompt-shown",
          agent: "codex",
          instance: null,
          sessionPrefix: sessionId,
          startedAt: Date.now(),
        })
        expect((await detail.next()).value).toMatchObject({ sessionId })
      }
      await detail.return(undefined)
    })
  }
})
