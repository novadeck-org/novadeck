import { loadProbe } from "@novadeck/harness-core/testing/probes"
import type { AgentName } from "@novadeck/protocol/harnesses"

import { agyAskSkipped, claudeAskSkipped, codexAskSkipped } from "./skipped"
import { agyVocabulary } from "./vocabulary/agy"
import { claudeVocabulary } from "./vocabulary/claude"
import { codexVocabulary } from "./vocabulary/codex"

// The harnesses' recorded fixtures that carry transcript records, and where in each the
// records are, and the hand-written vocabulary conversations beside them. A fixture holds
// one conversation or several (a scenario each); every one is a list of the record lines
// the harness's decoder reads.

type Conversation = { readonly name: string; readonly lines: readonly string[] }

// A hand-written conversation: its records, as the harness would write them.
export type Written = { readonly name: string; readonly records: readonly object[] }

// What an extractor found: the conversations, and the scenarios it had nothing to render in.
export type Extracted = { readonly conversations: Conversation[]; readonly skipped: string[] }

export type Fixture = {
  // The golden's path below goldens/.
  readonly golden: string
  readonly harness: AgentName
  // Whether its conversations call tools.
  readonly tools: boolean
  // How many conversations it has, and which scenarios it has none in.
  readonly count: number
  readonly skipped: readonly string[]
  readonly extract: () => Extracted
}

type Json = { readonly [key: string]: unknown }

const folderOf = (harness: AgentName): string =>
  `${import.meta.dirname}/../../../harnesses/${harness}/src`

// A fixture, typed as the shape its extractor expects; nothing checks it is that shape.
const load = <T>(harness: AgentName, file: string): T => loadProbe<T>(folderOf(harness), file)

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
const scenarioLists = (harness: AgentName, file: string): Extracted => {
  const { scenarios } = load<{ scenarios: { [name: string]: unknown } }>(harness, file)
  return found(file, {
    conversations: Object.entries(scenarios).map(([name, records]) => ({
      name,
      lines: linesOf(recordsOf(`${file} ${name}`, records)),
    })),
    skipped: [],
  })
}

// { records: [record, …] }
const records = (harness: AgentName, file: string): Extracted =>
  found(file, {
    conversations: [
      {
        name: "records",
        lines: linesOf(recordsOf(file, load<{ records: unknown }>(harness, file).records)),
      },
    ],
    skipped: [],
  })

// Claude's ask fixture keeps each scenario's transcript as `{ type, content }`, the record
// without the `message` Claude Code wraps its content in.
const claudeAsk = (file: string): Extracted => {
  const { scenarios } = load<{
    scenarios: { [name: string]: { transcriptTail?: { type: string; content: unknown }[] } }
  }>("claude", file)
  const conversations: Conversation[] = []
  const skipped: string[] = []
  for (const [name, { transcriptTail }] of Object.entries(scenarios)) {
    if (!transcriptTail?.length) {
      skipped.push(name)
      continue
    }
    conversations.push({
      name,
      lines: transcriptTail.map(({ type, content }) =>
        JSON.stringify({ type, message: { content } }),
      ),
    })
  }
  return found(file, { conversations, skipped })
}

// Codex's ask fixture keeps a scenario's rollout as it was at stages of the run (every key
// that starts with `rollout`), each holding the stages before it: the longest is the whole.
const codexAsk = (file: string): Extracted => {
  const { scenarios } = load<{ scenarios: { [name: string]: Json } }>("codex", file)
  const conversations: Conversation[] = []
  const skipped: string[] = []
  for (const [name, scenario] of Object.entries(scenarios)) {
    const stages = Object.entries(scenario)
      .flatMap(([key, value]) =>
        key.startsWith("rollout") && isRecords(value) ? [[key, linesOf(value)] as const] : [],
      )
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
  const { scenarios } = load<{ scenarios: { [name: string]: unknown } }>("agy", file)
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
  const { transcript, parallel } = load<{ transcript: unknown; parallel: unknown }>("agy", file)
  return found(file, {
    conversations: [
      { name: "transcript", lines: linesOf(recordsOf(file, transcript)) },
      { name: "parallel", lines: linesOf(recordsOf(file, parallel)) },
    ],
    skipped: [],
  })
}

const vocabulary = (written: readonly Written[]): Extracted =>
  found("vocabulary", {
    conversations: written.map((each) => ({ name: each.name, lines: linesOf(each.records) })),
    skipped: [],
  })

export const fixtures: readonly Fixture[] = [
  {
    golden: "claude/transcript",
    harness: "claude",
    tools: true,
    count: 2,
    skipped: [],
    extract: () => scenarioLists("claude", "transcript.probe.json"),
  },
  {
    golden: "claude/queued",
    harness: "claude",
    tools: true,
    count: 1,
    skipped: [],
    extract: () => scenarioLists("claude", "queued.probe.json"),
  },
  {
    golden: "claude/shell",
    harness: "claude",
    tools: true,
    count: 6,
    skipped: [],
    extract: () => scenarioLists("claude", "shell.probe.json"),
  },
  {
    golden: "claude/ask",
    harness: "claude",
    tools: true,
    count: 55,
    skipped: claudeAskSkipped,
    extract: () => claudeAsk("ask.probe.json"),
  },
  {
    golden: "codex/rollout",
    harness: "codex",
    tools: true,
    count: 1,
    skipped: [],
    extract: () => records("codex", "rollout.probe.json"),
  },
  {
    golden: "codex/shell",
    harness: "codex",
    tools: true,
    count: 6,
    skipped: [],
    extract: () => scenarioLists("codex", "shell.probe.json"),
  },
  {
    golden: "codex/plan",
    harness: "codex",
    // A proposed plan, as text.
    tools: false,
    count: 1,
    skipped: [],
    extract: () => records("codex", "plan.probe.json"),
  },
  {
    golden: "codex/ask",
    harness: "codex",
    tools: true,
    count: 42,
    skipped: codexAskSkipped,
    extract: () => codexAsk("ask.probe.json"),
  },
  {
    golden: "codex/ask.0.160.1",
    harness: "codex",
    tools: true,
    count: 32,
    skipped: codexAskSkipped,
    extract: () => codexAsk("ask.probe.0.160.1.json"),
  },
  {
    golden: "codex/ask.0.165.0",
    harness: "codex",
    tools: true,
    count: 11,
    skipped: [],
    extract: () => codexAsk("ask.probe.0.165.0.json"),
  },
  {
    golden: "agy/transcript",
    harness: "agy",
    tools: true,
    count: 2,
    skipped: [],
    extract: () => agyTranscript("transcript.probe.json"),
  },
  {
    golden: "agy/ask",
    harness: "agy",
    tools: true,
    count: 6,
    skipped: agyAskSkipped,
    extract: () => agyAsk("ask.probe.json"),
  },
  // Hand-written, in each harness's native shape (see vocabulary/README.md).
  {
    golden: "vocabulary/claude",
    harness: "claude",
    tools: true,
    count: 7,
    skipped: [],
    extract: () => vocabulary(claudeVocabulary),
  },
  {
    golden: "vocabulary/codex",
    harness: "codex",
    tools: true,
    count: 5,
    skipped: [],
    extract: () => vocabulary(codexVocabulary),
  },
  {
    golden: "vocabulary/agy",
    harness: "agy",
    tools: true,
    count: 7,
    skipped: [],
    extract: () => vocabulary(agyVocabulary),
  },
]
