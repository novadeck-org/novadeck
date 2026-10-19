import { transcripts as agy } from "@novadeck/harness-agy/transcripts"
import { transcripts as claude } from "@novadeck/harness-claude/transcripts"
import { transcripts as codex } from "@novadeck/harness-codex/transcripts"
import { loadProbe } from "@novadeck/harness-core/testing/probes"

import type { Transcripts } from "./pipeline"

// The harnesses' recorded fixtures that carry transcript records, and where in each the
// records are. A fixture holds one conversation or several (a scenario each); every one is
// a list of the record lines the harness's decoder reads.

export type Conversation = { readonly name: string; readonly lines: readonly string[] }

export type Fixture = {
  // The golden's path below goldens/.
  readonly golden: string
  readonly harness: "claude" | "codex" | "agy"
  readonly agent: string
  readonly transcripts: Transcripts
  // Whether its conversations call tools.
  readonly tools: boolean
  readonly conversations: () => readonly Conversation[]
}

type Json = { readonly [key: string]: unknown }

const folderOf = (harness: Fixture["harness"]): string =>
  `${import.meta.dirname}/../../../harnesses/${harness}/src`

const load = (harness: Fixture["harness"], file: string): Json =>
  loadProbe<Json>(folderOf(harness), file)

const isRecords = (value: unknown): value is readonly object[] =>
  Array.isArray(value) && value.length > 0 && value.every((each) => typeof each === "object")

const linesOf = (records: readonly object[]): string[] =>
  records.map((record) => JSON.stringify(record))

// No records is a broken extractor or a fixture that changed shape, never an empty contract.
const found = (file: string, conversations: Conversation[]): Conversation[] => {
  if (conversations.length === 0) throw new Error(`${file} holds no transcript records`)
  return conversations
}

const recordsOf = (file: string, value: unknown): readonly object[] => {
  if (!isRecords(value)) throw new Error(`${file} holds no transcript records where expected`)
  return value
}

// { scenarios: { name: [record, …] } }
const scenarioLists = (harness: Fixture["harness"], file: string): Conversation[] => {
  const { scenarios } = load(harness, file) as { scenarios: { [name: string]: unknown } }
  return found(
    file,
    Object.entries(scenarios).map(([name, records]) => ({
      name,
      lines: linesOf(recordsOf(`${file} ${name}`, records)),
    })),
  )
}

// { records: [record, …] }
const records = (harness: Fixture["harness"], file: string): Conversation[] =>
  found(file, [
    {
      name: "records",
      lines: linesOf(recordsOf(file, (load(harness, file) as { records: unknown }).records)),
    },
  ])

// Claude's ask fixture keeps each scenario's transcript as `{ type, content }`, the record
// without the `message` Claude Code wraps its content in.
const claudeAsk = (file: string): Conversation[] => {
  const { scenarios } = load("claude", file) as {
    scenarios: { [name: string]: { transcriptTail?: { type: string; content: unknown }[] } }
  }
  return found(
    file,
    Object.entries(scenarios)
      .filter(([, { transcriptTail }]) => transcriptTail?.length)
      .map(([name, { transcriptTail }]) => ({
        name,
        lines: transcriptTail!.map(({ type, content }) =>
          JSON.stringify({ type, message: { content } }),
        ),
      })),
  )
}

// Codex's ask fixture keeps a scenario's rollout as it was at stages of the run, each
// holding the stages before it: the longest is the whole.
const rolloutKeys = [
  "rollout",
  "rolloutBeforeAnswer",
  "rolloutAfter",
  "rolloutAfterEsc",
  "rolloutFinal",
]
const codexAsk = (file: string): Conversation[] => {
  const { scenarios } = load("codex", file) as { scenarios: { [name: string]: Json } }
  return found(
    file,
    Object.entries(scenarios).flatMap(([name, scenario]) => {
      const stages = rolloutKeys.map((key) => scenario[key]).filter(isRecords)
      const whole = stages.toSorted((a, b) => b.length - a.length)[0]
      return whole ? [{ name, lines: linesOf(whole) }] : []
    }),
  )
}

// Antigravity's records are steps; wherever a scenario keeps a list of them (what a step
// was after an allow, a deny, a plan's approval), that is a conversation.
const isSteps = (value: unknown): value is readonly object[] =>
  isRecords(value) && value.every((each) => "step_index" in each && "source" in each)

const stepLists = (
  value: unknown,
  path: string[],
): { path: string; steps: readonly object[] }[] => {
  if (isSteps(value)) return [{ path: path.join("/"), steps: value }]
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([key, each]) => stepLists(each, [...path, key]))
}

const agyAsk = (file: string): Conversation[] =>
  found(
    file,
    stepLists(load("agy", file).scenarios, []).map(({ path, steps }) => ({
      name: path,
      lines: linesOf(steps),
    })),
  )

const agyTranscript = (file: string): Conversation[] => {
  const { transcript, parallel } = load("agy", file) as { transcript: unknown; parallel: unknown }
  return found(file, [
    { name: "transcript", lines: linesOf(recordsOf(file, transcript)) },
    { name: "parallel", lines: linesOf(recordsOf(file, parallel)) },
  ])
}

export const fixtures: readonly Fixture[] = [
  {
    golden: "claude/transcript",
    harness: "claude",
    agent: "Claude",
    transcripts: claude,
    tools: true,
    conversations: () => scenarioLists("claude", "transcript.probe.json"),
  },
  {
    golden: "claude/shell",
    harness: "claude",
    agent: "Claude",
    transcripts: claude,
    tools: true,
    conversations: () => scenarioLists("claude", "shell.probe.json"),
  },
  {
    golden: "claude/ask",
    harness: "claude",
    agent: "Claude",
    transcripts: claude,
    tools: true,
    conversations: () => claudeAsk("ask.probe.json"),
  },
  {
    golden: "codex/rollout",
    harness: "codex",
    agent: "Codex",
    transcripts: codex,
    tools: true,
    conversations: () => records("codex", "rollout.probe.json"),
  },
  {
    golden: "codex/shell",
    harness: "codex",
    agent: "Codex",
    transcripts: codex,
    tools: true,
    conversations: () => scenarioLists("codex", "shell.probe.json"),
  },
  {
    golden: "codex/plan",
    harness: "codex",
    agent: "Codex",
    transcripts: codex,
    tools: false,
    conversations: () => records("codex", "plan.probe.json"),
  },
  {
    golden: "codex/ask",
    harness: "codex",
    agent: "Codex",
    transcripts: codex,
    tools: true,
    conversations: () => codexAsk("ask.probe.json"),
  },
  {
    golden: "codex/ask.0.160.1",
    harness: "codex",
    agent: "Codex",
    transcripts: codex,
    tools: true,
    conversations: () => codexAsk("ask.probe.0.160.1.json"),
  },
  {
    golden: "agy/transcript",
    harness: "agy",
    agent: "Antigravity",
    transcripts: agy,
    tools: true,
    conversations: () => agyTranscript("transcript.probe.json"),
  },
  {
    golden: "agy/ask",
    harness: "agy",
    agent: "Antigravity",
    transcripts: agy,
    tools: true,
    conversations: () => agyAsk("ask.probe.json"),
  },
]
