import { explain } from "@novadeck/harness-core/dialogs"
import {
  dialogRecord,
  readRecord,
  type DialogRecord,
} from "@novadeck/harness-core/testing/dialog-record"
import { refusalProblems } from "@novadeck/harness-core/testing/refusal-guard"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import { factsOf, replaced, screen } from "./dialogs.test-support.js"

describe("Codex's dialog refusals", () => {
  it("do not stop a dialog that reads", () => {
    const { result } = explain(() => dialogs.read(screen("exec-approve"), factsOf("exec-approve")))
    expect(result).toBeDefined()
  })

  it("name where an approval stopped reading", () => {
    const rows = replaced(
      screen("exec-approve"),
      "Would you like to run the following command?",
      "Would you like to do something else?",
    )
    const { result, refusals } = explain(() => dialogs.read(rows, factsOf("exec-approve")))
    expect(result).toBeUndefined()
    // Each reader that looked at it noted where it stopped, the last one the decision.
    expect(refusals).toEqual([
      "permission.mcpApproval.1",
      "permission.approval.2",
      "dialogs.read.1",
    ])
  })

  it("keep every read's rejection to a static code", () => {
    expect(refusalProblems(import.meta.dirname)).toEqual([])
  })

  it("replay a saved dialog, as the runner wrote it, through the adapter", () => {
    const facts = factsOf("exec-approve")
    const rows = screen("exec-approve")
    const saved = dialogRecord({
      harness: "codex",
      version: "0.159.3",
      now: new Date("2026-11-16T12:00:00Z"),
      reason: "unrecognized",
      refusals: [],
      request: facts,
      rows,
      columns: 120,
    })
    const file = JSON.parse(JSON.stringify(saved)) as DialogRecord
    expect(readRecord(dialogs, file)).toMatchObject({
      read: { dialog: { type: "choices", detail: "echo approved > probe-out.txt" } },
    })
  })
})
