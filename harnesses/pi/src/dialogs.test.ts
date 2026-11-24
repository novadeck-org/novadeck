import type { ScreenText } from "@novadeck/emulator/headless"
import type { DialogRead, KeyStep, RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import type { RequestAnswer } from "@novadeck/protocol"
import { describe as context, describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"

type Probe = { screens: { [name: string]: ScreenText } }

// Probed 2026-11-24, pi 1.6.0 (fixtures/dialogs.probe.json; the rig's ext-dialogs.ts draws the
// extension dialogs, pi's examples question.ts and permission-gate.ts the rest).
const { screens } = loadProbe<Probe>(import.meta.dirname, "dialogs.probe.json")
const { screens: boxes } = loadProbe<Probe>(import.meta.dirname, "input-box.probe.json")
const rows = (name: string): readonly string[] => {
  const found = screens[name] ?? boxes[name]
  if (!found) throw new Error(`no state ${name}`)
  return found.rows
}

/** A request as Novadeck's extension reports a dialog opening (`ui_prompt_start`). */
const asked = (tool: string, title: string, extra: object = {}): RequestFacts => ({
  kind: tool === "confirm" ? "permission" : "question",
  tool,
  input: { title, ...extra },
  cwd: "/home/a/project",
})

const read = (name: string, request: RequestFacts): DialogRead | undefined =>
  dialogs.read(rows(name), request)

const steps = (found: DialogRead, answer: RequestAnswer): readonly KeyStep[] => {
  const keys = found.keys(answer)
  if (!keys) throw new Error("no keys")
  return keys
}

const presses = (keys: readonly KeyStep[]): string =>
  keys.flatMap((step) => ("press" in step ? [step.press] : [])).join("")

const waits = (keys: readonly KeyStep[]) => keys.flatMap((step) => ("until" in step ? [step] : []))

const pickOne = (option: string): RequestAnswer => ({
  type: "questions",
  dialog: "d",
  answers: [{ question: "1", options: [option] }],
})

const words = (text: string): RequestAnswer => ({
  type: "questions",
  dialog: "d",
  answers: [{ question: "1", options: [], text }],
})

describe("pi's dialogs", () => {
  context("an extension's select", () => {
    const request = asked("select", "Allow bash: rm -rf build?")

    it("reads as one question, its options as the screen lists them", () => {
      expect(read("select", request)?.dialog).toEqual({
        type: "questions",
        questions: [
          {
            id: "1",
            header: null,
            question: "Allow bash: rm -rf build?",
            options: [
              { id: "1", label: "Yes", description: null },
              { id: "2", label: "Yes, always", description: null },
              { id: "3", label: "No", description: null },
            ],
            multiSelect: false,
            text: false,
          },
        ],
        chat: null,
      })
    })

    it("picks an option with Down, sees it selected, then Enter", () => {
      const found = read("select", request)!
      const keys = steps(found, pickOne("2"))
      expect(presses(keys)).toBe("\x1b[B\r")
      expect(waits(keys)[0]!.until(rows("selectDown"))).toBe(true)
      expect(waits(keys)[0]!.until(rows("select"))).toBe(false)
      expect(presses(steps(found, pickOne("1")))).toBe("\r")
    })

    it("moves up from a selection further down", () => {
      expect(presses(steps(read("selectDown", request)!, pickOne("1")))).toBe("\x1b[A\r")
    })

    it("is answered once it goes", () => {
      const found = read("select", request)!
      expect(found.answered(rows("selectAnswered"))).toBe(true)
      expect(found.answered(rows("selectDown"))).toBe(false)
    })

    it("takes no words and no option it doesn't list", () => {
      const found = read("select", request)!
      expect(found.keys(pickOne("4"))).toBeUndefined()
      expect(found.keys(words("maybe"))).toBeUndefined()
      expect(found.keys({ type: "chat", dialog: "d", text: "wait" })).toBeUndefined()
    })

    it("reads a title of several lines, as given", () => {
      const title = "Dangerous command:\n\n  rm -rf build\n\nAllow?"
      expect(read("selectMultiline", asked("select", title))?.dialog).toMatchObject({
        questions: [{ question: title, options: [{ label: "Yes" }, { label: "No" }] }],
      })
      expect(read("select60", asked("select", title))).toBeDefined()
    })

    it("reads a title and a label that wrap, a long word's parts joined", () => {
      const title = `Allow this ${"very ".repeat(40)}long request?`
      for (const name of ["long", "long60"]) {
        const found = read(name, asked("select", title))
        expect(found?.dialog, name).toMatchObject({
          questions: [
            {
              options: [{ label: `Yes, and a long label ${"x".repeat(150)}` }, { label: "No" }],
            },
          ],
        })
      }
    })

    it("refuses a select under another title", () => {
      expect(read("select", asked("select", "Allow bash: rm -rf dist?"))).toBeUndefined()
      expect(read("ready", request)).toBeUndefined()
    })

    it("refuses a list that shows only part of its options", () => {
      expect(read("many", asked("select", "Pick one"))).toBeUndefined()
      expect(read("many60", asked("select", "Pick one"))).toBeUndefined()
    })

    it("reads a permission gate's select, its turn's tool row above it", () => {
      const title = "⚠️ Dangerous command:\n\n  rm -rf /tmp/pi-probe-nothing\n\nAllow?"
      expect(read("permissionGate", asked("select", title))?.dialog).toMatchObject({
        questions: [{ options: [{ label: "Yes" }, { label: "No" }] }],
      })
    })
  })

  context("an extension's confirm", () => {
    const request = asked("confirm", "Delete build?", { message: "This removes the build folder." })

    it("reads as Yes or No, its message as the detail", () => {
      expect(read("confirm", request)?.dialog).toEqual({
        type: "choices",
        title: "Delete build?",
        detail: "This removes the build folder.",
        options: [
          { id: "yes", label: "Yes", text: null },
          { id: "no", label: "No", text: null },
        ],
      })
      expect(read("confirm", asked("confirm", "Delete build?"))?.dialog).toMatchObject({
        detail: "This removes the build folder.",
      })
    })

    it("reads one with no message", () => {
      expect(read("bare", asked("confirm", "Proceed?"))?.dialog).toMatchObject({ detail: null })
      expect(read("bare60", asked("confirm", "Proceed?"))).toBeDefined()
    })

    it("says No with Down, and Yes with Enter alone", () => {
      const found = read("confirm", request)!
      const no = steps(found, { type: "choice", dialog: "d", option: "no" })
      expect(presses(no)).toBe("\x1b[B\r")
      expect(waits(no)[0]!.until(rows("confirmNo"))).toBe(true)
      expect(presses(steps(found, { type: "choice", dialog: "d", option: "yes" }))).toBe("\r")
      expect(found.answered(rows("confirmDone"))).toBe(true)
    })

    it("refuses a confirm whose message is another", () => {
      expect(
        read("confirm", asked("confirm", "Delete build?", { message: "Other." })),
      ).toBeUndefined()
      expect(read("select", asked("confirm", "Allow bash: rm -rf build?"))).toBeUndefined()
    })
  })

  context("an extension's input", () => {
    const request = asked("input", "Your name?")

    it("reads as a question answered in words", () => {
      expect(read("input2", request)?.dialog).toEqual({
        type: "questions",
        questions: [
          {
            id: "1",
            header: null,
            question: "Your name?",
            options: [],
            multiSelect: false,
            text: true,
          },
        ],
        chat: null,
      })
    })

    it("types the words, sees them in its field, then Enter", () => {
      const found = read("input2", request)!
      const keys = steps(found, words("Grace Hopper"))
      expect(keys[0]).toEqual({ type: "Grace Hopper" })
      expect(presses(keys)).toBe("\r")
      expect(waits(keys)[0]!.until(rows("inputPasted"))).toBe(true)
      expect(waits(keys)[0]!.until(rows("input2"))).toBe(false)
      expect(found.answered(rows("inputPastedDone"))).toBe(true)
    })

    it("types nothing over words already in its field, nor a line break", () => {
      expect(read("inputTyped2", request)?.keys(words("Grace"))).toBeUndefined()
      expect(read("input2", request)?.keys(words("a\nb"))).toBeUndefined()
    })
  })

  context("an extension's editor", () => {
    const request = asked("editor", "Edit the plan")

    it("reads as a question answered in words", () => {
      expect(read("editorOpen", request)?.dialog).toMatchObject({
        type: "questions",
        questions: [{ question: "Edit the plan", options: [], text: true }],
      })
      expect(read("editorOpen60", request)).toBeDefined()
    })

    it("empties its text with the box's keys, types the words, sees them, then Enter", () => {
      const found = read("editorOpen", request)!
      const keys = steps(found, words("new plan"))
      expect(keys[0]).toEqual({ press: "\x1b[B\x05\x15\x15\x05\x15\x15" })
      expect(waits(keys)[0]!.until(rows("editorErased"))).toBe(true)
      expect(waits(keys)[0]!.until(rows("editorOpen"))).toBe(false)
      expect(keys[2]).toEqual({ type: "new plan" })
      expect(waits(keys)[1]!.until(rows("editorTyped"))).toBe(true)
      expect(found.answered(rows("editorDone"))).toBe(true)
    })
  })

  context("the trust prompt", () => {
    it("is a request only the screen tells, naming its folder", () => {
      const told = dialogs.screenRequest?.(rows("trust"))
      expect(told).toEqual({
        kind: "question",
        tool: "trust",
        input: {
          title: "Trust project folder?",
          folder: "/tmp/claude-1000/pi-rig/homes/dialogs2-1.6.0/project",
        },
        subject: "Trust project folder?",
      })
      for (const name of ["ready", "select", "trustedReady"])
        expect(dialogs.screenRequest?.(rows(name)), name).toBeUndefined()
    })

    it("reads as its five choices, and picks one with Down and Enter", () => {
      const told = dialogs.screenRequest!(rows("trust"))!
      const found = dialogs.read(rows("trust"), { ...told, cwd: null })!
      expect(found.dialog).toMatchObject({
        type: "choices",
        title: "Trust project folder?",
        options: [
          { label: "Trust" },
          { label: "Trust parent folder (/tmp/claude-1000/pi-rig/homes/dialogs2-1.6.0)" },
          { label: "Trust (this session only)" },
          { label: "Do not trust" },
          { label: "Do not trust (this session only)" },
        ],
      })
      const keys = steps(found, { type: "choice", dialog: "d", option: "3" })
      expect(presses(keys)).toBe("\x1b[B\x1b[B\r")
      expect(waits(keys)[0]!.until(rows("trustDown"))).toBe(true)
      expect(found.answered(rows("trustedReady"))).toBe(true)
    })
  })

  context("held out of view", () => {
    const searching = (name: string): readonly string[] =>
      rows(name).map((row, at) => (at === 2 ? `${row.slice(0, 70)}│ Find in transcript   │` : row))

    it("closes the transcript's search over a dialog with Escape", () => {
      expect(dialogs.reveal?.(searching("select"))).toBe("\x1b")
      expect(dialogs.reveal?.(searching("input2"))).toBe("\x1b")
    })

    it("presses nothing with no dialog under the search, nor a dialog with no search", () => {
      expect(dialogs.reveal?.(rows("searchCsiU120x40"))).toBeUndefined()
      expect(dialogs.reveal?.(rows("select"))).toBeUndefined()
    })
  })

  it("reads no dialog for a tool it doesn't know", () => {
    expect(read("select", asked("custom", "Allow bash: rm -rf build?"))).toBeUndefined()
  })
})
