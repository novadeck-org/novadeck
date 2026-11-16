import { explain } from "@novadeck/harness-core/dialogs"
import {
  dialogRecord,
  readRecord,
  type DialogRecord,
} from "@novadeck/harness-core/testing/dialog-record"
import { refusalProblems } from "@novadeck/harness-core/testing/refusal-guard"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import { command, permissionFacts, run } from "./dialogs.test-support.js"

describe("Antigravity's dialog refusals", () => {
  const rows = command.pending.screen120!.rows

  it("do not stop a dialog that reads", () => {
    const { result } = explain(() => dialogs.read(rows, permissionFacts(run("echo approved"))))
    expect(result).toBeDefined()
  })

  it("name where a confirmation stopped reading", () => {
    const { result, refusals } = explain(() =>
      dialogs.read(rows, permissionFacts(run("echo something else"))),
    )
    expect(result).toBeUndefined()
    expect(refusals).toEqual(["permission.shownStart.1", "permission.permission.1"])
  })

  it("keep every read's rejection to a static code", () => {
    expect(refusalProblems(import.meta.dirname)).toEqual([])
  })

  it("replay a saved dialog, as the runner wrote it, through the adapter", () => {
    const saved = dialogRecord({
      harness: "agy",
      version: "1.2.14",
      now: new Date("2026-11-16T12:00:00Z"),
      reason: "unrecognized",
      refusals: [],
      request: permissionFacts(run("echo approved")),
      rows: [...rows],
      columns: 120,
    })
    const file = JSON.parse(JSON.stringify(saved)) as DialogRecord
    expect(readRecord(dialogs, file)).toMatchObject({
      read: { dialog: { type: "choices", detail: "echo approved" } },
    })
  })
})
