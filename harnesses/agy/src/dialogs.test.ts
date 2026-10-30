import type { ScreenText } from "@novadeck/emulator/headless"
import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import {
  asking,
  choice,
  colour,
  colours,
  permission,
  question,
  questions,
  read,
  run,
  same,
  sent,
  waits,
} from "./dialogs.test-support.js"

describe("Antigravity 1.3.0's dialogs (fixtures/ask.probe.1.3.0.json)", () => {
  const latest = (
    loadProbe(import.meta.dirname, "ask.probe.1.3.0.json") as {
      screens: { [name: string]: ScreenText }
    }
  ).screens

  it("read as 1.2.14's do: the same options, keys and answered", () => {
    const found = read(latest.command!.rows, permission(run("echo approved")))
    expect(found.dialog).toMatchObject({
      detail: "echo approved",
      options: [{}, {}, {}, { id: "4" }],
    })
    expect(sent(found.keys(choice("4")))).toEqual(["4"])
    expect(found.answered(latest.command!.rows)).toBe(false)
    expect(found.answered(latest.planApproved!.rows)).toBe(true)
    const file = { name: "write_to_file", args: { TargetFile: "/tmp/sandbox/project/probe.txt" } }
    expect(read(latest.write!.rows, permission(file)).dialog).toMatchObject({ options: [{}, {}] })
    const asked = read(latest.ask!.rows, question(colour))
    expect(sent(asked.keys(questions({ question: "1", options: ["2"] })))).toEqual(["\x1b[B", "\r"])
    expect(
      sent(asked.keys(questions({ question: "1", options: [], text: "Purple" }))),
    ).toHaveLength(6)
    const typedIn = waits(
      asked.keys(questions({ question: "1", options: [], text: "Purple" })),
    )![2]!
    expect(typedIn(latest.writeInTyped!.rows)).toBe(true)
    expect(typedIn(latest.writeIn!.rows)).toBe(false)
    expect(read(latest.writeIn!.rows, question(colour)).dialog).toEqual(asked.dialog)
    expect(
      read(latest.multi!.rows, question(asking(colours(["Red", "Green", "Blue"], true)))).dialog,
    ).toMatchObject({ questions: [{ multiSelect: true }] })
    const two = asking(colours(["Red", "Green"]), {
      question: "Which size?",
      options: ["Small", "Large"],
      is_multi_select: false,
    })
    expect(read(latest.q1!.rows, question(two)).dialog).toMatchObject({ questions: [{}, {}] })
    expect(read(latest.q2!.rows, question(two)).dialog).toMatchObject({ questions: [{}, {}] })
  })

  it("read the plan review as 1.2.14's", () => {
    const request: RequestFacts = { kind: "plan", tool: "artifact", cwd: null, input: null }
    expect(dialogs.screenRequest!(latest.planWritten!.rows)).toMatchObject({ kind: "plan" })
    const found = read(latest.planWritten!.rows, request)
    const [listed] = waits(found.keys(choice("approve")))!
    expect(listed!(latest.review!.rows)).toBe(true)
    expect(found.answered(latest.review!.rows)).toBe(false)
    expect(found.answered(latest.planApproved!.rows)).toBe(true)
    expect(dialogs.screenRequest!(latest.planApproved!.rows)).toBeUndefined()
  })
})

// 1.4's file tools are write_file and edit_file, naming the file as Path; its dialogs read
// as before (probed 2026-10-20, 1.4.3).
describe("Antigravity 1.4.3's dialogs", () => {
  const { screens } = loadProbe(import.meta.dirname, "ask.probe.1.4.3.json") as {
    screens: { [name: string]: ScreenText }
  }
  const file = "/tmp/sandbox/project/probe.txt"
  const written = { name: "write_file", args: { Path: file, Content: "hello\n" } }
  const edited = {
    name: "edit_file",
    args: { Path: file, Target: "hello", Replacement: "goodbye" },
  }

  it("reads write_file's confirmation, agreeing with its Path", () => {
    const screen = screens.write!.rows
    const found = read(screen, permission(written))
    expect(found.dialog).toEqual({
      type: "choices",
      title: "Allow creation of this file?",
      detail: `${file}  +1\n  1  +  hello`,
      options: [
        { id: "1", label: "Yes, allow creation", text: null },
        { id: "2", label: "No, deny creation", text: "prompt" },
      ],
    })
    expect(sent(found.keys(choice("1")))).toEqual(["1"])
    const other = { name: "write_file", args: { Path: "/tmp/sandbox/project/other.txt" } }
    expect(dialogs.read(screen, permission(other))).toBeUndefined()
    expect(dialogs.read(screen, permission(edited))).toBeUndefined()
  })

  it("agrees with a Windows Path it draws with forward slashes", () => {
    // Its call names C:\…\probe.txt, its screen C:/…/probe.txt (seen on Windows, 1.4.3).
    const screen = same(
      screens.write!.rows,
      `${file}  +1`,
      "C:/Users/runner/Temp/project/probe.txt  +1",
    )
    const windows = {
      name: "write_file",
      args: { Path: "C:\\Users\\runner\\Temp\\project\\probe.txt" },
    }
    expect(read(screen, permission(windows)).dialog).toMatchObject({
      title: "Allow creation of this file?",
    })
    const other = {
      name: "write_file",
      args: { Path: "C:\\Users\\runner\\Temp\\project\\other.txt" },
    }
    expect(dialogs.read(screen, permission(other))).toBeUndefined()
  })

  it("reads edit_file's confirmation, agreeing with its Path", () => {
    const screen = screens.edit!.rows
    const found = read(screen, permission(edited))
    expect(found.dialog).toEqual({
      type: "choices",
      title: "Accept this file edit?",
      detail: `${file}  +1 -1\n  1  -  hello\n  1  +  goodbye`,
      options: [
        { id: "1", label: "Yes, accept this change", text: null },
        { id: "2", label: "No, reject this change", text: "prompt" },
      ],
    })
    expect(dialogs.read(screen, permission(written))).toBeUndefined()
  })

  it("reads a command's confirmation for a call with no Cwd, and ask_question", () => {
    const echo = { name: "run_command", args: { CommandLine: "echo approved" } }
    expect(read(screens.command!.rows, permission(echo)).dialog).toMatchObject({
      type: "choices",
      title: "Run this command?",
      detail: "echo approved",
    })
    expect(read(screens.ask!.rows, question(colour)).dialog).toMatchObject({
      type: "questions",
      questions: [{ question: "Which colour?" }],
    })
  })
})
