import type { ScreenText } from "@novadeck/emulator/headless"
import type { DialogRead, KeyStep, RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import type { RequestAnswer } from "@novadeck/protocol"
import { expect, vi } from "vitest"

import { dialogs } from "./dialogs.js"

// What Claude Code's dialog tests share: the probe's scenarios, as screens and the
// requests their hooks told, and the answers and keys a test reads.

type Scenario = {
  events: { event?: string; payload?: { tool_name: string; tool_input: unknown } }[]
  version?: string
  prompts?: string[]
  screens: { [size: string]: ScreenText }
  steps: { [name: string]: ScreenText }
}
export const probe = loadProbe(import.meta.dirname, "ask.probe.json") as {
  scenarios: { [name: string]: Scenario }
}

export const scenario = (name: string): Scenario => probe.scenarios[name]!
export const screen = (name: string, size: string): string[] => [
  ...scenario(name).screens[size]!.rows,
]
export const step = (name: string, key: string): string[] => [...scenario(name).steps[key]!.rows]

// What the request asks, as its PermissionRequest or Elicitation hook told it.
export const factsOf = (name: string): RequestFacts => {
  const asked = scenario(name).events.find(({ event }) => event === "Elicitation")?.payload
  if (asked) {
    const fields = asked as unknown as Record<string, unknown>
    return {
      kind: "question",
      tool: `mcp__${String(fields.mcp_server_name)}__elicitation`,
      input: fields,
      cwd: null,
    }
  }
  const payload = scenario(name).events.find(({ event }) => event === "PermissionRequest")!.payload!
  return {
    kind:
      payload.tool_name === "AskUserQuestion"
        ? "question"
        : payload.tool_name === "ExitPlanMode"
          ? "plan"
          : "permission",
    tool: payload.tool_name,
    input: payload.tool_input,
    cwd: null,
  }
}

export const readOf = (name: string, size: string): DialogRead | undefined =>
  dialogs.read(screen(name, size), factsOf(name))

export const need = (found: DialogRead | undefined): DialogRead => {
  expect(found).toBeDefined()
  return found!
}

export const sizes = ["120x40", "60x20"]
export const choice = (option: string, text?: string): RequestAnswer => ({
  type: "choice",
  dialog: "d",
  option,
  ...(text !== undefined && { text }),
})
export const pressed = (steps: readonly KeyStep[] | undefined): string[] =>
  (steps ?? []).flatMap((each) => ("press" in each ? [each.press] : []))
export const waits = (steps: readonly KeyStep[] | undefined) =>
  (steps ?? []).flatMap((each) => ("until" in each ? [each] : []))
export const typed = (steps: readonly KeyStep[] | undefined): string[] =>
  (steps ?? []).flatMap((each) => ("type" in each ? [each.type] : []))

export const Down = "\x1b[B"
export const Right = "\x1b[C"

export const asks = (tool: string, input: unknown): RequestFacts => ({
  kind: "permission",
  tool,
  input,
  cwd: null,
})
export const writing = (file_path: string) => ({ file_path, content: "hello\nworld\n" })
export const chat = (text?: string): RequestAnswer =>
  ({ type: "chat", dialog: "d", ...(text !== undefined && { text }) }) as RequestAnswer
export const other = (facts: RequestFacts, input: unknown): RequestFacts => ({ ...facts, input })
export const answer = (options: string[], text?: string): RequestAnswer => ({
  type: "questions",
  dialog: "d",
  answers: [{ question: "q1", options, ...(text !== undefined && { text }) }],
})
export const options = (question: Record<string, unknown>) =>
  question.options as { label: string; description?: string }[]
export const blanksBefore = (text: string): boolean => /[ \t]\n/.test(text)
export const time = (run: () => unknown): number => {
  const started = performance.now()
  run()
  return performance.now() - started
}
// Lines as a diff counts them: a text's last break ends a line, it does not start one.
export const linesOfText = (text: string) => {
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  return lines
}
// What Claude Code's edit does to a file: `old_string` replaced by `new_string` where it is
// the only one, but a text replaced by nothing takes the line break after it too.
export const effect = (file: string, old: string, fresh: string): string | undefined => {
  if (old === "" || file.indexOf(old) < 0 || file.indexOf(old) !== file.lastIndexOf(old)) {
    return undefined
  }
  if (fresh === "" && !old.endsWith("\n") && file.includes(`${old}\n`)) {
    return file.replace(`${old}\n`, () => "")
  }
  return file.replace(old, () => fresh)
}

// A row's text as Ink wraps it at the screen's width: at the last space that fits, which it
// drops, or inside a word where none does; later rows repeat the number column and marker.
export const wrapRow = (prefix: string, text: string, cols: number): string[] => {
  const rows: string[] = []
  const continued = `${" ".repeat(prefix.length - 1)}${prefix.at(-1)}`
  const room = cols - prefix.length
  let rest = text
  for (let first = true; ; first = false) {
    const lead = first ? prefix : continued
    if (rest.length <= room) {
      rows.push((lead + rest).trimEnd())
      return rows
    }
    const cut = rest.lastIndexOf(" ", room)
    if (cut > 0) {
      rows.push(lead + rest.slice(0, cut))
      rest = rest.slice(cut + 1)
    } else {
      rows.push(lead + rest.slice(0, room))
      rest = rest.slice(room)
    }
  }
}
export const swap = (rows: string[], from: string, to: string) =>
  rows.map((row) => row.replace(from, to))
export const replace = (from: string | RegExp, to: string) => (rows: string[]) =>
  rows.map((row) => row.replace(from, to))

// A step's wait that holds only once its screen has held for a moment, as a form drops keys
// sent at once: asked now, then after the time it wants.
export const eventually = (wait: KeyStep | undefined, rows: readonly string[]): boolean => {
  if (!wait || !("until" in wait)) throw new Error("not a wait")
  let now = 1_000_000
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
  try {
    const first = wait.until(rows)
    now += 600
    const later = wait.until(rows)
    // Never true at once on a screen that had not held.
    return later && !first
  } finally {
    clock.mockRestore()
  }
}
export const never = (wait: KeyStep | undefined, rows: readonly string[]): boolean => {
  if (!wait || !("until" in wait)) throw new Error("not a wait")
  let now = 1_000_000
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
  try {
    wait.until(rows)
    now += 600
    return wait.until(rows)
  } finally {
    clock.mockRestore()
  }
}
