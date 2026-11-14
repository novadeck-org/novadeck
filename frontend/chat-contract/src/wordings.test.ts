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
// adapter no longer reads it. The fixtures are the probes' (`ask.probe*.json`).

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

// Every screen a scenario recorded, anywhere in it.
const screens = (scenario: Scenario): readonly (readonly string[])[] =>
  objects(scenario).flatMap((each) =>
    Array.isArray(each.rows) && each.rows.every((row) => typeof row === "string")
      ? [each.rows as string[]]
      : [],
  )

const asked = (kind: unknown): kind is RequestFacts["kind"] =>
  kind === "permission" || kind === "plan" || kind === "question"

// Claude Code's PermissionRequest hook names the tool and its input.
const claudeRequests: Requests = (scenario) =>
  objects(scenario).flatMap((each) => {
    const payload = each.payload as { tool_name?: unknown; tool_input?: unknown } | undefined
    if (each.event !== "PermissionRequest" || typeof payload?.tool_name !== "string") return []
    const tool = payload.tool_name
    const kind =
      tool === "ExitPlanMode" ? "plan" : tool === "AskUserQuestion" ? "question" : "permission"
    return [{ kind, tool, input: payload.tool_input, cwd: null }]
  })

// Codex's hooks, decoded as the runner decodes them.
const codexRequests: Requests = (scenario) =>
  objects(scenario).flatMap((each) => {
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
  })

// Antigravity says nothing of a confirmation but on its status line: the request is the
// call its PreToolUse named last, as the runner remembers it.
const agyRequests: Requests = (scenario) =>
  objects(scenario).flatMap((each) => {
    const call = (each.in as { toolCall?: unknown } | undefined)?.toolCall
    return each.event === "PreToolUse" && call !== undefined
      ? [{ kind: "permission" as const, tool: "confirmation", input: call, cwd: null }]
      : []
  })

// Calls a probe ran without recording their hooks, as the harness's own dialog tests give
// them: Antigravity's replace_file_content probe (1.2.14) kept only its screen.
const agyUnrecorded: readonly RequestFacts[] = [
  {
    kind: "permission",
    tool: "confirmation",
    input: { name: "replace_file_content", args: { TargetFile: "/tmp/sandbox/project/probe.txt" } },
    cwd: null,
  },
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
// (and probed versions) that show it. A screen whose scenario recorded no request of its own
// (Antigravity's later probes keep screens alone) is read with the requests the harness's
// other scenarios recorded: an adapter reads a dialog only for the request it asks about.
const reads = (agent: AgentName): Map<string, { read: Read; seen: Set<string> }> => {
  const { dialogs, requests, unrecorded, folder } = profiles[agent]
  const sources = harnessSources(folder)
  const files = readdirSync(join(sources, "fixtures"))
    .filter((file) => /^ask\.probe(\..+)?\.json$/.test(file))
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
  const found = new Map<string, { read: Read; seen: Set<string> }>()
  for (const { file, name, scenario, facts } of recorded) {
    const version = /^ask\.probe\.(.+)\.json$/.exec(file)?.[1]
    for (const rows of screens(scenario)) {
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
        const entry = found.get(key) ?? { read, seen: new Set<string>() }
        entry.seen.add(version ? `${name}@${version}` : name)
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
        `# ${read.kind}: ${[...seen].toSorted().join(", ")}`,
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
