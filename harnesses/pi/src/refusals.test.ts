import type { ScreenText } from "@novadeck/emulator/headless"
import { explain } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { refusalProblems } from "@novadeck/harness-core/testing/refusal-guard"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"

const { screens } = loadProbe<{ screens: { [name: string]: ScreenText } }>(
  import.meta.dirname,
  "dialogs.probe.json",
)
const select = (title: string) =>
  dialogs.read(screens.select!.rows, {
    kind: "question",
    tool: "select",
    input: { title },
    cwd: null,
  })

describe("pi's dialog refusals", () => {
  it("do not stop a dialog that reads", () => {
    const { result, refusals } = explain(() => select("Allow bash: rm -rf build?"))
    expect(result).toBeDefined()
    expect(refusals).toEqual([])
  })

  it("name where a select stopped reading", () => {
    const { result, refusals } = explain(() => select("Allow bash: rm -rf dist?"))
    expect(result).toBeUndefined()
    expect(refusals).toEqual(["select.select.2"])
  })

  it("keep every read's rejection to a static code", () => {
    expect(refusalProblems(import.meta.dirname)).toEqual([])
  })
})
