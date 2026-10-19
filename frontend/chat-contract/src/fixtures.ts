import { transcripts as agy } from "@novadeck/harness-agy/transcripts"
import { transcripts as claude } from "@novadeck/harness-claude/transcripts"
import { transcripts as codex } from "@novadeck/harness-codex/transcripts"
import { loadProbe } from "@novadeck/harness-core/testing/probes"

import type { Transcripts } from "./pipeline"
import { claudeAskSkipped } from "./skipped"
import { agyVocabulary } from "./vocabulary/agy"
import { claudeVocabulary } from "./vocabulary/claude"
import { codexVocabulary } from "./vocabulary/codex"

// The harnesses' recorded fixtures that carry transcript records, and where in each the
// records are, and the hand-written vocabulary conversations beside them. A fixture holds
// one conversation or several (a scenario each); every one is a list of the record lines
// the harness's decoder reads.

export type Conversation = { readonly name: string; readonly lines: readonly string[] }

// What an extractor found: the conversations, and the scenarios it had nothing to render in.
export type Extracted = { readonly conversations: Conversation[]; readonly skipped: string[] }

export type Fixture = {
  // The golden's path below goldens/.
  readonly golden: string
  readonly harness: "claude" | "codex" | "agy"
  readonly agent: string
  readonly transcripts: Transcripts
  // Whether its conversations call tools.
  readonly tools: boolean
  // How many conversations it has, and which scenarios it has none in.
  readonly count: number
  readonly skipped: readonly string[]
  readonly extract: () => Extracted
}

type Json = { readonly [key: string]: unknown }

const folderOf = (harness: Fixture["harness"]): string =>
  `${import.meta.dirname}/../../../harnesses/${harness}/src`

const load = (harness: Fixture["harness"], file: string): Json =>
  loadProbe<Json>(folderOf(harness), file)

const isRecords = (value: unknown): value is readonly object[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((each) => typeof each === "object" && each !== null)

const linesOf = (records: readonly object[]): string[] =>
  records.map((record) => JSON.stringify(record))

// No records is a broken extractor or a fixture that changed shape, never an empty contract.
const found = (file: string, extracted: Extracted): Extracted => {
  if (extracted.conversations.length === 0) throw new Error(`${file} holds no transcript records`)
  return extracted
}

const recordsOf = (file: string, value: unknown): readonly object[] => {
  if (!isRecords(value)) throw new Error(`${file} holds no transcript records where expected`)
  return value
}

// { scenarios: { name: [record, …] } }
const scenarioLists = (harness: Fixture["harness"], file: string): Extracted => {
  const { scenarios } = load(harness, file) as { scenarios: { [name: string]: unknown } }
  return found(file, {
    conversations: Object.entries(scenarios).map(([name, records]) => ({
      name,
      lines: linesOf(recordsOf(`${file} ${name}`, records)),
    })),
    skipped: [],
  })
}

// { records: [record, …] }
const records = (harness: Fixture["harness"], file: string): Extracted =>
  found(file, {
    conversations: [
      {
        name: "records",
        lines: linesOf(recordsOf(file, (load(harness, file) as { records: unknown }).records)),
      },
    ],
    skipped: [],
  })

// Claude's ask fixture keeps each scenario's transcript as `{ type, content }`, the record
// without the `message` Claude Code wraps its content in.
const claudeAsk = (file: string): Extracted => {
  const { scenarios } = load("claude", file) as {
    scenarios: { [name: string]: { transcriptTail?: { type: string; content: unknown }[] } }
  }
  const entries = Object.entries(scenarios)
  return found(file, {
    conversations: entries
      .filter(([, { transcriptTail }]) => transcriptTail?.length)
      .map(([name, { transcriptTail }]) => ({
        name,
        lines: transcriptTail!.map(({ type, content }) =>
          JSON.stringify({ type, message: { content } }),
        ),
      })),
    skipped: entries.filter(([, { transcriptTail }]) => !transcriptTail?.length).map(([n]) => n),
  })
}

// Codex's ask fixture keeps a scenario's rollout as it was at stages of the run (every key
// that starts with `rollout`), each holding the stages before it: the longest is the whole.
const codexAsk = (file: string): Extracted => {
  const { scenarios } = load("codex", file) as { scenarios: { [name: string]: Json } }
  const conversations: Conversation[] = []
  const skipped: string[] = []
  for (const [name, scenario] of Object.entries(scenarios)) {
    const stages = Object.entries(scenario)
      .filter(([key, value]) => key.startsWith("rollout") && isRecords(value))
      .map(([key, value]) => [key, linesOf(value as readonly object[])] as const)
      .toSorted((a, b) => b[1].length - a[1].length)
    const whole = stages[0]
    if (!whole) {
      skipped.push(name)
      continue
    }
    for (const [key, lines] of stages.slice(1))
      if (lines.some((line, at) => line !== whole[1][at]))
        throw new Error(`${file} ${name}: ${key} is not the start of ${whole[0]}`)
    conversations.push({ name, lines: whole[1] })
  }
  return found(file, { conversations, skipped })
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

const agyAsk = (file: string): Extracted => {
  const { scenarios } = load("agy", file) as { scenarios: { [name: string]: unknown } }
  const conversations: Conversation[] = []
  const skipped: string[] = []
  for (const [name, scenario] of Object.entries(scenarios)) {
    const lists = stepLists(scenario, [name])
    if (lists.length === 0) skipped.push(name)
    for (const { path, steps } of lists) conversations.push({ name: path, lines: linesOf(steps) })
  }
  return found(file, { conversations, skipped })
}

const agyTranscript = (file: string): Extracted => {
  const { transcript, parallel } = load("agy", file) as { transcript: unknown; parallel: unknown }
  return found(file, {
    conversations: [
      { name: "transcript", lines: linesOf(recordsOf(file, transcript)) },
      { name: "parallel", lines: linesOf(recordsOf(file, parallel)) },
    ],
    skipped: [],
  })
}

const vocabulary = (conversations: Conversation[]): Extracted =>
  found("vocabulary", { conversations, skipped: [] })

const codexAskSkipped = ["rui-default-off", "y-with-no-dialog"]

export const fixtures: readonly Fixture[] = [
  {
    golden: "claude/transcript",
    harness: "claude",
    agent: "Claude",
    transcripts: claude,
    tools: true,
    count: 2,
    skipped: [],
    extract: () => scenarioLists("claude", "transcript.probe.json"),
  },
  {
    golden: "claude/shell",
    harness: "claude",
    agent: "Claude",
    transcripts: claude,
    tools: true,
    count: 6,
    skipped: [],
    extract: () => scenarioLists("claude", "shell.probe.json"),
  },
  {
    golden: "claude/ask",
    harness: "claude",
    agent: "Claude",
    transcripts: claude,
    tools: true,
    count: 55,
    skipped: claudeAskSkipped,
    extract: () => claudeAsk("ask.probe.json"),
  },
  {
    golden: "codex/rollout",
    harness: "codex",
    agent: "Codex",
    transcripts: codex,
    tools: true,
    count: 1,
    skipped: [],
    extract: () => records("codex", "rollout.probe.json"),
  },
  {
    golden: "codex/shell",
    harness: "codex",
    agent: "Codex",
    transcripts: codex,
    tools: true,
    count: 6,
    skipped: [],
    extract: () => scenarioLists("codex", "shell.probe.json"),
  },
  {
    golden: "codex/plan",
    harness: "codex",
    agent: "Codex",
    transcripts: codex,
    // A proposed plan, as text.
    tools: false,
    count: 1,
    skipped: [],
    extract: () => records("codex", "plan.probe.json"),
  },
  {
    golden: "codex/ask",
    harness: "codex",
    agent: "Codex",
    transcripts: codex,
    tools: true,
    count: 34,
    skipped: codexAskSkipped,
    extract: () => codexAsk("ask.probe.json"),
  },
  {
    golden: "codex/ask.0.160.1",
    harness: "codex",
    agent: "Codex",
    transcripts: codex,
    tools: true,
    count: 32,
    skipped: codexAskSkipped,
    extract: () => codexAsk("ask.probe.0.160.1.json"),
  },
  {
    golden: "agy/transcript",
    harness: "agy",
    agent: "Antigravity",
    transcripts: agy,
    tools: true,
    count: 2,
    skipped: [],
    extract: () => agyTranscript("transcript.probe.json"),
  },
  {
    golden: "agy/ask",
    harness: "agy",
    agent: "Antigravity",
    transcripts: agy,
    tools: true,
    count: 6,
    skipped: ["ask_question", "hook", "answered", "twin", "replace_file_content"],
    extract: () => agyAsk("ask.probe.json"),
  },
  // Hand-written, in each harness's native shape (see vocabulary/README.md).
  {
    golden: "vocabulary/claude",
    harness: "claude",
    agent: "Claude",
    transcripts: claude,
    tools: true,
    count: 7,
    skipped: [],
    extract: () => vocabulary(claudeVocabulary()),
  },
  {
    golden: "vocabulary/codex",
    harness: "codex",
    agent: "Codex",
    transcripts: codex,
    tools: true,
    count: 5,
    skipped: [],
    extract: () => vocabulary(codexVocabulary()),
  },
  {
    golden: "vocabulary/agy",
    harness: "agy",
    agent: "Antigravity",
    transcripts: agy,
    tools: true,
    count: 6,
    skipped: [],
    extract: () => vocabulary(agyVocabulary()),
  },
]
