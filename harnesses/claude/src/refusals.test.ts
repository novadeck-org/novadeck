import { explain } from "@novadeck/harness-core/dialogs"
import {
  dialogRecord,
  readRecord,
  type DialogRecord,
} from "@novadeck/harness-core/testing/dialog-record"
import { refusalProblems } from "@novadeck/harness-core/testing/refusal-guard"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import { factsOf, other, screen } from "./dialogs.test-support.js"

describe("Claude Code's dialog refusals", () => {
  it("do not stop a dialog that reads", () => {
    const { result } = explain(() =>
      dialogs.read(screen("bash-long", "120x40"), factsOf("bash-long")),
    )
    expect(result).toBeDefined()
  })

  it("name where a permission dialog stopped reading", () => {
    const facts = other(factsOf("bash-long"), { command: "rm -rf /" })
    const { result, refusals } = explain(() => dialogs.read(screen("bash-long", "120x40"), facts))
    expect(result).toBeUndefined()
    expect(refusals).toEqual(["permission.shows.5", "permission.permission.5"])
  })

  it("keep every read's rejection to a static code", () => {
    expect(refusalProblems(import.meta.dirname)).toEqual([])
  })

  it("replay a saved dialog, as the runner wrote it, through the adapter", () => {
    const facts = factsOf("bash-long")
    const saved = dialogRecord({
      harness: "claude",
      version: "2.1.323",
      now: new Date("2026-11-16T12:00:00Z"),
      reason: "unrecognized",
      refusals: ["permission.shows.3"],
      request: facts,
      rows: screen("bash-long", "120x40"),
      columns: 120,
    })
    const file = JSON.parse(JSON.stringify(saved)) as DialogRecord
    expect(file.scenario.events[0]).toMatchObject({
      event: "PermissionRequest",
      payload: { tool_name: facts.tool, tool_input: facts.input },
    })
    expect(readRecord(dialogs, file)).toMatchObject({
      read: { dialog: { type: "choices" } },
      refusals: [],
    })
  })
})
