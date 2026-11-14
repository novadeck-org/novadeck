import { readdirSync } from "node:fs"
import { join } from "node:path"

import type { ChatDialogOption } from "@novadeck/core/conversation"
import { optionExtras, type OptionExtras } from "@novadeck/core/conversation/extras"
import { agy } from "@novadeck/harness-agy/index"
import { claude } from "@novadeck/harness-claude/index"
import { codex } from "@novadeck/harness-codex/index"
import type { DialogAdapter, RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { hookReport } from "@novadeck/harness-core/testing/reports"
import { agentNames, type AgentName } from "@novadeck/protocol/harnesses"

import { harnessSources } from "./harnesses.test-support"
import { describe, expect, it } from "./test"

// What core reads into each permission's and plan's options (`conversation/extras`: role,
// scope, effect, armed), for every such dialog a harness's probe recorded, read by the
// harness's own dialog adapter from the screen with the request its hooks told. A harness
// that rewords a dialog changes the lines here, or drops the dialog from them, when its
// adapter no longer reads it, at any of the sizes it was recorded at. The fixtures are the
// probes' (`ask.probe*.json`, and `tall.probe.json`'s commands taller than the screen).

type Scenario = Record<string, unknown>
// The requests a scenario's hooks told, as the runner holds them for its dialog.
type Requests = (scenario: Scenario) => readonly RequestFacts[]

const objects = (value: unknown): Record<string, unknown>[] => {
  if (typeof value !== "object" || value === null) return []
  const each = Array.isArray(value) ? value : Object.values(value)
  return [
    ...(Array.isArray(value) ? [] : [value as Record<string, unknown>]),
    ...each.flatMap(objects),
  ]
}

// Every screen a scenario recorded, anywhere in it, by where: "screens.120x40".
type Screen = { readonly at: string; readonly rows: readonly string[] }
const screens = (value: unknown, at: readonly string[] = []): readonly Screen[] => {
  if (typeof value !== "object" || value === null) return []
  const { rows } = value as { rows?: unknown }
  if (Array.isArray(rows) && rows.every((row) => typeof row === "string"))
    return [{ at: at.length > 0 ? at.join(".") : "its screen", rows }]
  return Object.entries(value).flatMap(([key, each]) => screens(each, [...at, key]))
}

// A probe of commands taller than the screen names the commands it ran, not its hooks.
const commandsOf = (scenario: Scenario): readonly string[] =>
  Array.isArray(scenario.commands)
    ? scenario.commands.filter((each): each is string => typeof each === "string")
    : []

const asked = (kind: unknown): kind is RequestFacts["kind"] =>
  kind === "permission" || kind === "plan" || kind === "question"

// Claude Code's PermissionRequest hook names the tool and its input; the runner adds the
// folder it asks from. The probe ran in `<sandbox>/project` and redacted its paths so, on
// screen and in its hooks: each request reads as recorded (a screen that shows the redacted
// path), and with its paths absolute again under that folder (a subtitle relative to it, as
// `../outside/OUT.txt`).
const claudeFolder = "/sandbox/project"
const unredacted = (input: unknown): unknown =>
  JSON.parse(JSON.stringify(input ?? null).replaceAll("<sandbox>", "/sandbox"))
const claudeRequests: Requests = (scenario) => [
  ...objects(scenario).flatMap((each): RequestFacts[] => {
    const payload = each.payload as { tool_name?: unknown; tool_input?: unknown } | undefined
    if (each.event !== "PermissionRequest" || typeof payload?.tool_name !== "string") return []
    const tool = payload.tool_name
    const kind: RequestFacts["kind"] =
      tool === "ExitPlanMode" ? "plan" : tool === "AskUserQuestion" ? "question" : "permission"
    return [
      { kind, tool, input: payload.tool_input, cwd: null },
      { kind, tool, input: unredacted(payload.tool_input), cwd: claudeFolder },
    ]
  }),
  ...commandsOf(scenario).map((command) => ({
    kind: "permission" as const,
    tool: "Bash",
    input: { command, description: "Make a file" },
    cwd: claudeFolder,
  })),
]

// Codex's hooks, decoded as the runner decodes them.
const codexRequests: Requests = (scenario) => [
  ...commandsOf(scenario).map((command) => ({
    kind: "permission" as const,
    tool: "Bash",
    input: { command },
    cwd: null,
  })),
  ...objects(scenario).flatMap((each) => {
    if (each.kind !== "start" || typeof each.event !== "string") return []
    const payload = {
      ...(each.payload as object),
      session_id: "11111111-2222-4333-8444-555555555555",
    }
    return codex
      .decode(hookReport("codex", each.event, payload, { seq: 1000, instance: null }))
      .flatMap((event) =>
        event.type === "attention-requested" && asked(event.kind)
          ? [{ kind: event.kind, tool: event.toolName, input: event.input, cwd: null }]
          : [],
      )
  }),
]

// Antigravity says nothing of a confirmation but on its status line: the request is the
// call its PreToolUse named last, as the runner remembers it.
const confirming = (call: unknown): RequestFacts => ({
  kind: "permission",
  tool: "confirmation",
  input: call,
  cwd: null,
})
const agyRun = (command: string) => ({
  name: "run_command",
  args: { CommandLine: command, Cwd: "/tmp/sandbox/project" },
})
const agyRequests: Requests = (scenario) => [
  ...commandsOf(scenario).map((command) => confirming(agyRun(command))),
  ...objects(scenario).flatMap((each) => {
    const call = (each.in as { toolCall?: unknown } | undefined)?.toolCall
    return each.event === "PreToolUse" && call !== undefined ? [confirming(call)] : []
  }),
]

// Calls a probe ran without recording their hooks, as the harness's own dialog tests give
// them: Antigravity's replace_file_content probe and its twin commands (1.2.14) kept only
// their screens.
const agyUnrecorded: readonly RequestFacts[] = [
  confirming({
    name: "replace_file_content",
    args: { TargetFile: "/tmp/sandbox/project/probe.txt" },
  }),
  confirming(agyRun("echo same")),
]

const profiles: Record<
  AgentName,
  {
    readonly dialogs: DialogAdapter
    readonly requests: Requests
    readonly unrecorded: readonly RequestFacts[]
    readonly folder: AgentName
  }
> = {
  claude: { dialogs: claude.dialogs, requests: claudeRequests, unrecorded: [], folder: "claude" },
  codex: { dialogs: codex.dialogs, requests: codexRequests, unrecorded: [], folder: "codex" },
  agy: { dialogs: agy.dialogs, requests: agyRequests, unrecorded: agyUnrecorded, folder: "agy" },
}

type Read = {
  readonly kind: RequestFacts["kind"]
  readonly options: readonly ChatDialogOption[]
}

// A probe's scenarios: by name, or (Antigravity's later probes) its screens, by name.
const scenariosOf = (probe: Record<string, unknown>): Record<string, Scenario> =>
  (probe.scenarios ?? probe.screens ?? {}) as Record<string, Scenario>

// Each permission or plan dialog the adapter reads on a recorded screen, by the scenarios
// (and probed versions) and screens that show it. A screen whose scenario recorded no
// request of its own (Antigravity's later probes keep screens alone) is read with the
// requests the harness's other scenarios recorded, which only holds where its adapter reads
// the same dialog for them: Antigravity's 1.4.3 names its file tools `write_file` and
// `edit_file`, and its adapter takes either family by the dialog's header. An adapter reads a
// dialog only for the request it asks about, so no other request reads it.
type Seen = Map<string, Set<string>>
const reads = (agent: AgentName): Map<string, { read: Read; seen: Seen }> => {
  const { dialogs, requests, unrecorded, folder } = profiles[agent]
  const sources = harnessSources(folder)
  const files = readdirSync(join(sources, "fixtures"))
    .filter((file) => /^(ask|tall)\.probe(\..+)?\.json$/.test(file))
    .toSorted()
  const recorded = files.flatMap((file) =>
    Object.entries(scenariosOf(loadProbe(sources, file))).map(([name, scenario]) => ({
      file,
      name,
      scenario,
      facts: requests(scenario),
    })),
  )
  const pool = [...recorded.flatMap(({ facts }) => facts), ...unrecorded]
  const found = new Map<string, { read: Read; seen: Seen }>()
  for (const { file, name, scenario, facts } of recorded) {
    const [, probe, version] = /^(ask|tall)\.probe(?:\.(.+))?\.json$/.exec(file)!
    const scenarioName = `${probe === "tall" ? "tall/" : ""}${name}${version ? `@${version}` : ""}`
    for (const { at, rows } of screens(scenario)) {
      const shown = dialogs.screenRequest?.(rows)
      const candidates = [
        ...(facts.length > 0 ? facts : pool),
        ...(shown ? [{ ...shown, cwd: null }] : []),
      ]
      for (const request of candidates) {
        if (request.kind === "question") continue
        const dialog = dialogs.read(rows, request)?.dialog
        if (dialog?.type !== "choices") continue
        const read: Read = { kind: request.kind, options: dialog.options }
        const key = JSON.stringify(read)
        const entry = found.get(key) ?? { read, seen: new Map() }
        entry.seen.set(scenarioName, (entry.seen.get(scenarioName) ?? new Set()).add(at))
        found.set(key, entry)
      }
    }
  }
  return found
}

const extrasLine = ({ role, lines, effect, hard }: OptionExtras): string =>
  [
    role,
    ...(lines ? [`lines "${lines.head}" / "${lines.scope}"`] : []),
    ...(effect ? [`effect "${effect}"`] : []),
    ...(hard ? ["armed"] : []),
  ].join(", ")

const golden = (agent: AgentName): string => {
  const blocks = [...reads(agent).values()]
    .map(({ read, seen }) => {
      const extras = optionExtras(read.kind, read.options)
      return [
        `# ${read.kind}`,
        ...[...seen]
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([name, at]) => `  on ${name}: ${[...at].toSorted().join(", ")}`),
        ...read.options.map(
          (option, at) =>
            `  ${option.label}${option.text ? ` [${option.text}]` : ""} → ${extrasLine(extras[at]!)}`,
        ),
      ].join("\n")
    })
    .toSorted()
  return `${blocks.join("\n\n")}\n`
}

describe("a harness's permission and plan options", () => {
  for (const agent of agentNames) {
    it(`read as they did on ${agent}'s recorded dialogs`, async () => {
      await expect(golden(agent)).toMatchFileSnapshot(`./wordings/${agent}.txt`)
    })

    it(`are recorded for both a permission and a plan on ${agent}`, () => {
      const kinds = new Set([...reads(agent).values()].map(({ read }) => read.kind))
      expect([...kinds].toSorted()).toEqual(["permission", "plan"])
    })
  }
})
