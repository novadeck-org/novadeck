import type { ScreenText } from "@novadeck/emulator/headless"
import type { DialogRead, KeyStep, RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import type { RequestAnswer } from "@novadeck/protocol"

import { dialogs } from "./dialogs.js"

// What opencode's dialog tests share: the probe's screens (fixtures/dialogs.probe.json, probed
// 2026-11-22, 1.19.6), the requests and answers a test gives, and the keys and waits it reads back.

export const { screens } = loadProbe<{ screens: { [name: string]: ScreenText } }>(
  import.meta.dirname,
  "dialogs.probe.json",
)
// The screen each rows array came from, as the runner gives the adapter both.
const owners = new WeakMap<readonly string[], ScreenText>()
export const rowsOf = (name: string): readonly string[] => {
  const found = screens[name]
  if (!found) throw new Error(`no screen ${name}`)
  owners.set(found.rows, found)
  return found.rows
}
export const readOn = (rows: readonly string[], request: RequestFacts): DialogRead | undefined =>
  dialogs.read(rows, request, owners.get(rows))

const project = "/home/user/project"

// A `permission.asked` event's facts, as the plugin reports them: the permission's name, then
// its patterns, metadata and always.
export const permissionFacts = (
  tool: string,
  input: { patterns: string[]; metadata?: object; always?: string[] },
): RequestFacts => ({
  kind: "permission",
  tool,
  cwd: project,
  input: { metadata: {}, always: [], ...input },
})

export const bash = (command: string, always = ["echo *"]) =>
  permissionFacts("bash", { patterns: [command], metadata: { command }, always })

export const edit = (file: string, diff: string) =>
  permissionFacts("edit", {
    patterns: [file.slice(1)],
    metadata: { filepath: file, diff },
    always: ["*"],
  })

// A unified diff as opencode's event carries it: four header lines, then the hunk.
export const diffOf = (...lines: string[]): string =>
  ["Index: f", "=".repeat(67), "--- f", "+++ f", "@@ -1 +1 @@", ...lines].join("\n")

export const questionFacts = (...questions: object[]): RequestFacts => ({
  kind: "question",
  tool: "question",
  cwd: project,
  input: { questions },
})

export const colours = (
  header = "Colour",
  options = ["Red", "Blue", "Green"],
  extra: { multiple?: boolean; custom?: boolean; question?: string } = {},
) => ({
  question: extra.question ?? "Which colour?",
  header,
  options: options.map((label) => ({ label, description: `about ${label.toLowerCase()}` })),
  ...(extra.multiple !== undefined && { multiple: extra.multiple }),
  ...(extra.custom !== undefined && { custom: extra.custom }),
})

export const read = (rows: readonly string[], request: RequestFacts): DialogRead => {
  const found = readOn(rows, request)
  if (!found) throw new Error("the dialog went unrecognised")
  return found
}

// What a step list presses and types, with its waits left out.
export const sent = (steps: readonly KeyStep[] | undefined) =>
  steps?.flatMap((step) =>
    "press" in step ? [step.press] : "type" in step ? [`"${step.type}"`] : [],
  )
// The screens a step list's waits ask for, in order.
export const waits = (steps: readonly KeyStep[] | undefined) =>
  steps?.flatMap((step) => ("until" in step ? [step.until] : []))

export const choice = (option: string, text?: string) =>
  ({
    type: "choice",
    dialog: "d",
    option,
    ...(text !== undefined && { text }),
  }) satisfies RequestAnswer
export const questionsAnswer = (
  ...answers: { question: string; options: string[]; text?: string }[]
) => ({ type: "questions", dialog: "d", answers }) satisfies RequestAnswer
export const chat = (text?: string) =>
  ({ type: "chat", dialog: "d", ...(text !== undefined && { text }) }) satisfies RequestAnswer

export const right = "\x1b[C"
