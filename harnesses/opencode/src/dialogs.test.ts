import {
  dialogRecord,
  readRecord,
  type DialogRecord,
} from "@novadeck/harness-core/testing/dialog-record"
import { refusalProblems } from "@novadeck/harness-core/testing/refusal-guard"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import {
  bash,
  colours,
  permissionFacts,
  questionFacts,
  readOn,
  rowsOf,
  screens,
} from "./dialogs.test-support.js"

describe("opencode's dialogs", () => {
  it("read no plan: it draws none", () => {
    expect(
      readOn(rowsOf("permBash"), { kind: "plan", tool: "plan", cwd: null, input: null }),
    ).toBeUndefined()
    expect(dialogs.screenRequest).toBeUndefined()
  })

  it("read a permission or a question only for the kind the request says", () => {
    expect(readOn(rowsOf("qOne"), bash("echo approved"))).toBeUndefined()
    expect(readOn(rowsOf("permBash"), questionFacts(colours()))).toBeUndefined()
  })

  it("read nothing from its screens at rest or under its other dialogs", () => {
    for (const name of [
      "models",
      "models60",
      "help",
      "palette",
      "connectKey",
      "refused401",
      "noProviders",
    ]) {
      expect(readOn(rowsOf(name), bash("echo approved")), name).toBeUndefined()
      expect(readOn(rowsOf(name), questionFacts(colours())), name).toBeUndefined()
    }
  })

  it("keep every read's rejection to a static code", () => {
    expect(refusalProblems(import.meta.dirname)).toEqual([])
  })

  it("replay a saved dialog, as the runner wrote it, through the adapter", () => {
    const saved = dialogRecord({
      harness: "opencode",
      version: "1.19.6",
      now: new Date("2026-11-22T12:00:00Z"),
      reason: "unrecognized",
      refusals: [],
      request: bash("echo approved"),
      rows: [...rowsOf("permBash")],
      lit: screens.permBash!.lit,
      columns: 120,
    })
    const file = JSON.parse(JSON.stringify(saved)) as DialogRecord
    expect(readRecord(dialogs, file)).toMatchObject({
      read: { dialog: { type: "choices", detail: "echo approved" } },
    })
  })

  it("take a permission's facts as the plugin gives them, whole", () => {
    expect(readOn(rowsOf("permBash"), { ...bash("echo approved"), input: null })).toBeUndefined()
    expect(
      readOn(rowsOf("permBash"), permissionFacts("bash", { patterns: ["echo approved"] })),
    ).toBeUndefined()
  })
})
