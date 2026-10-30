import type { ScreenText } from "@novadeck/emulator/headless"
import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import type { RequestAnswer } from "@novadeck/protocol"
import { expect } from "vitest"

import { dialogs } from "./dialogs.js"
import { codex } from "./index.js"
import { report } from "./report.test-support.js"

// What Codex's dialog tests share: the probes' scenarios, as screens and the requests their
// hooks told, and the answers and keys a test reads.

export type Hook = { readonly event: string; readonly payload: Report["payload"] }
type Scenario = {
  readonly screens?: Record<"wide" | "narrow", ScreenText>
  readonly screen?: ScreenText
  readonly hooksAll?: {
    readonly kind: string
    readonly event?: string
    readonly payload?: Report["payload"]
  }[]
  readonly pressed?: { readonly screen: ScreenText }[]
  readonly screenAfterEsc?: ScreenText
}
type Probe = { scenarios: Record<string, Scenario> }
export const load = (file: string) => loadProbe(import.meta.dirname, file) as Probe
// The pin's screens, and those of the newest release probed (0.160.1).
export const probe = load("ask.probe.json")
export const newer = load("ask.probe.0.160.1.json")

export const session = "11111111-2222-4333-8444-555555555555"
export const hooks = (name: string, source = probe): readonly Hook[] =>
  source.scenarios[name]!.hooksAll!.filter(({ kind }) => kind === "start").map(
    ({ event, payload }) => ({ event: event!, payload: { ...payload!, session_id: session } }),
  )
export const decoded = (hook: Hook): readonly HarnessEvent[] =>
  codex.decode({ ...report(hook.event, hook.payload), seq: 1000, instance: null })
export const asks = (name: string, source = probe) =>
  hooks(name, source)
    .flatMap((hook) => decoded(hook))
    .filter((event) => event.type === "attention-requested")
// The request as the runner holds it for the dialog, from the hooks Codex fired.
export const factsOf = (name: string, at = 0, source = probe): RequestFacts => {
  const event = asks(name, source)[at]!
  if (event.type !== "attention-requested") throw new Error("no request")
  return { kind: event.kind, tool: event.toolName, input: event.input, cwd: null }
}
export const screen = (
  name: string,
  size: "wide" | "narrow" = "wide",
  source = probe,
): string[] => [...source.scenarios[name]!.screens![size].rows]
export const sizes = ["wide", "narrow"] as const

export const read = (rows: readonly string[], facts: RequestFacts) => dialogs.read(rows, facts)
export const keys = (rows: readonly string[], facts: RequestFacts, answer: RequestAnswer) =>
  read(rows, facts)!.keys(answer)
export const choice = (option: string, text?: string): RequestAnswer => ({
  type: "choice",
  dialog: "d",
  option,
  ...(text !== undefined && { text }),
})
export const replaced = (rows: readonly string[], from: string | RegExp, to: string): string[] => {
  const out = rows.map((row) => row.replace(from, to))
  expect(out).not.toEqual(rows)
  return out
}

export const answer = (options: string[], text?: string): RequestAnswer => ({
  type: "questions",
  dialog: "d",
  answers: [{ question: "color", options, ...(text !== undefined && { text }) }],
})
