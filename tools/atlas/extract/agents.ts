import { execFileSync } from "node:child_process"

import type {
  AgentSurface,
  Anchor,
  ContractMember,
  Harness,
  Hook,
  JsonSchema,
  McpTool,
} from "../src/atlas.ts"
import type { Anchors } from "./anchors.ts"

const mcpFile = "backend/runner/src/shell/mcp.ts"
const managerFile = "backend/runner/src/terminals/manager.ts"
const companionFile = "backend/runner/src/terminals/companion.ts"
const callsFile = "backend/runner/src/terminals/calls.ts"
const contractFile = "harnesses/core/src/harness.ts"

// The method that performs each tool's call, and the runner file it is in.
const handlers: Record<string, { readonly file: string; readonly method: string }> = {
  show: { file: companionFile, method: "present" },
  showing: { file: companionFile, method: "showing" },
  close: { file: companionFile, method: "dismiss" },
  open_terminal: { file: callsFile, method: "open" },
  open_agent: { file: callsFile, method: "open" },
  close_terminal: { file: callsFile, method: "closePeer" },
  send: { file: managerFile, method: "send" },
  agents: { file: managerFile, method: "agents" },
  summarize: { file: callsFile, method: "summarize" },
  // The Inbox's tools, which the calls' dispatch hands to the Inbox.
  ask: { file: callsFile, method: "call" },
  tell: { file: callsFile, method: "call" },
  done: { file: callsFile, method: "call" },
}

const lineOf = (source: string | null, pattern: RegExp): number | null => {
  const index = source?.search(pattern) ?? -1
  return index === -1 || source === null ? null : source.slice(0, index).split("\n").length
}

// Each `const <tool>: Tool<…> = {…}` literal in the MCP server, evaluated for its name,
// description and input schema; the arrow functions inside it are never called.
const extractTools = (anchors: Anchors, adapters: Adapter[]): McpTool[] => {
  const source = anchors.read(mcpFile)
  if (source === null) {
    anchors.report("mcp tools", mcpFile, "file not found")
    return []
  }
  const listing = /const tools: readonly Tool<unknown>\[\] = \[([^\]]*)\]/.exec(source)
  if (!listing)
    anchors.report("mcp tools", mcpFile, "expected `const tools: readonly Tool<unknown>[] = [`")
  const listed = listing?.[1] ?? ""
  // The efforts the tools name, read from the contract they come from.
  const effortList = /export const efforts = (\[[^\]]*\])/.exec(
    anchors.read(contractFile) ?? "",
  )?.[1]
  if (!effortList) anchors.report("mcp tools", contractFile, "expected `export const efforts = [`")
  const variables = listed
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  // The constants the literals spread or name, each ending at a blank line or a comment.
  const preamble = [
    ...source.matchAll(
      /^const (rules|agentChoices|entryFields|cwdProperty|focusProperty|effortProperty|noModel)\b[^=]*=\s*([\s\S]*?)\n(?=\n|\/\/)/gm,
    ),
  ]
    .map(([, name, value]) => `const ${name} = ${value}`)
    .join("\n")
  return variables.flatMap((variable) => {
    const start = source.indexOf(`const ${variable}: Tool<`)
    if (start === -1) {
      anchors.report("mcp tools", mcpFile, `expected "const ${variable}: Tool<"`)
      return []
    }
    const end = source.indexOf("\n}\n", start)
    const literal = source.slice(source.indexOf("= {", start) + 2, end + 2)
    try {
      const evaluate = new Function(
        "harnessIds",
        "harnesses",
        "efforts",
        `${preamble}\nreturn ${literal}`,
      ) as (
        ids: string[],
        list: { id: string; name: string }[],
        efforts: string[],
      ) => {
        name: string
        description: string
        inputSchema: JsonSchema
      }
      const tool = evaluate(
        adapters.map((each) => each.id),
        adapters.map((each) => ({ id: each.id, name: each.title })),
        effortList ? (JSON.parse(effortList.replaceAll(/,\s*]/g, "]")) as string[]) : [],
      )
      const mapped = handlers[tool.name]
      const line =
        mapped === undefined
          ? null
          : lineOf(
              anchors.read(mapped.file),
              new RegExp(`^  (?:private |async )*${mapped.method}\\(`, "m"),
            )
      if (mapped === undefined)
        anchors.report("mcp tools", mcpFile, `no runner method is mapped to tool ${tool.name}`)
      else if (line === null)
        anchors.report(
          "mcp tools",
          mapped.file,
          `expected a method \`${mapped.method}(\` for tool ${tool.name}`,
        )
      const handler: Anchor | null =
        mapped === undefined || line === null ? null : { file: mapped.file, line }
      return [
        {
          name: tool.name,
          description: tool.description,
          input: tool.inputSchema,
          anchor: { file: mcpFile, line: anchors.find(mcpFile, `const ${variable}: Tool<`) },
          handler,
        },
      ]
    } catch (error) {
      anchors.report(
        "mcp tools",
        mcpFile,
        `could not evaluate ${variable}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }
  })
}

type Adapter = { id: string; title: string; package: string }

// What each agent is called; a new harness package without a name here is flagged.
const titles: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
}

// Every `harnesses/*` package but the shared core is an adapter.
const findAdapters = (repo: string, anchors: Anchors): Adapter[] => {
  // Tracked packages only: a folder left behind with just an ignored node_modules is none.
  const ids = execFileSync("git", ["ls-files", "--", "harnesses/*/package.json"], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\n")
    .map((file) => file.split("/")[1])
    .filter((id): id is string => id !== undefined && id !== "core")
    .toSorted()
  if (ids.length === 0) anchors.report("harness adapters", "harnesses", "found 0 adapter packages")
  return ids.map((id) => {
    const manifest = `harnesses/${id}/package.json`
    const name = (JSON.parse(anchors.read(manifest) ?? "{}") as { name?: string }).name
    if (titles[id] === undefined)
      anchors.report("harness adapters", manifest, `no display name for ${id} in extract/agents.ts`)
    return { id, title: titles[id] ?? id, package: name ?? `@novadeck/harness-${id}` }
  })
}

const hookSummaries: Record<string, string> = {
  SessionStart: "A session begins, resumes or restarts; binds it to the terminal.",
  UserPromptSubmit: "The person submits a prompt, which starts a turn.",
  PreInvocation: "Before each model call; delivers messages with the prompt.",
  Stop: "A turn ends; a waiting message can continue it.",
  StopFailure: "A turn ends on an API error.",
  Interrupt: "The person interrupts a turn.",
  SubagentStart: "A subagent starts.",
  SubagentStop: "A subagent ends.",
  PermissionRequest: "A request is waiting on the person.",
  Elicitation: "The agent asks the person a question.",
  ElicitationResult: "The person answered the agent's question.",
  PreToolUse: "Before a tool call; reports it, and answers at once.",
  PostToolUse: "A tool call finished; delivers the lead's messages.",
  PostToolUseFailure: "A tool call failed.",
  StatusLine: "The status line refreshes; Novadeck passes on the person's own.",
}

// The events a harness registers, and where in its source they are written.
const hookEvents = (source: string, id: string): { events: string[]; from: number } => {
  const list = /^const events = \[([^\]]*)\]/m.exec(source)
  if (list?.[1] !== undefined) {
    return {
      events: [...list[1].matchAll(/"(\w+)"/g)]
        .map(([, event]) => event ?? "")
        .concat(id === "claude" ? ["StatusLine"] : []),
      from: list.index,
    }
  }
  const from = source.indexOf('path: "hooks.json"')
  if (from === -1) return { events: [], from: 0 }
  const body = source.slice(from, source.indexOf("settings:", from))
  return {
    events: [...new Set([...body.matchAll(/\b([A-Z]\w+): \[/g)].map(([, event]) => event ?? ""))],
    from,
  }
}

const lineFrom = (source: string, needle: string, from: number): number | null => {
  const index = source.indexOf(needle, from)
  return index === -1 ? null : source.slice(0, index).split("\n").length
}

const extractAdapters = (
  anchors: Anchors,
  adapters: Adapter[],
): { harnesses: Harness[]; hooks: Hook[] } => {
  const harnesses: Harness[] = []
  const hooks: Hook[] = []
  for (const { id, title, package: pkg } of adapters) {
    const file = `harnesses/${id}/src/index.ts`
    const source = anchors.read(file)
    if (source === null) {
      anchors.report("harness adapters", file, "file not found")
      continue
    }
    const start = source.indexOf(`export const ${id} = {`)
    const end = source.indexOf("} satisfies Harness", start)
    if (start === -1) anchors.report("harness adapters", file, `expected "export const ${id} = {"`)
    if (end === -1) anchors.report("harness adapters", file, 'expected "} satisfies Harness"')
    const members =
      start === -1 || end === -1
        ? []
        : [...source.slice(start, end).matchAll(/^ {2}(\w+)\s*[:,(]/gm)].map(
            ([, name]) => name ?? "",
          )
    harnesses.push({
      id,
      title,
      package: pkg,
      implements: [...new Set(members)],
      anchor: { file, line: anchors.find(file, `export const ${id} = {`) },
    })
    const { events, from } = hookEvents(source, id)
    if (events.length === 0)
      anchors.report(
        "harness adapters",
        file,
        "found 0 hook events (`const events = [` or hooks.json)",
      )
    for (const event of events) {
      hooks.push({
        harness: id,
        event,
        summary: hookSummaries[event] ?? "A hook Novadeck registers.",
        anchor: {
          file,
          line:
            lineFrom(source, `"${event}"`, from) ??
            lineFrom(source, `${event}:`, from) ??
            anchors.find(file, event),
        },
      })
    }
  }
  return { harnesses, hooks }
}

const memberNotes: Record<string, string> = {
  id: "Which agent it is.",
  disconnect: "Its plugin commands that remove Novadeck.",
}

// The members of `type Harness` in harnesses/core, with their doc comments' first sentence.
const extractContract = (anchors: Anchors): ContractMember[] => {
  const source = anchors.read(contractFile)
  if (source === null) {
    anchors.report("harness contract", contractFile, "file not found")
    return []
  }
  const lines = source.split("\n")
  const first = lines.findIndex((line) => line.startsWith("export type Harness = {"))
  if (first === -1) {
    anchors.report("harness contract", contractFile, 'expected "export type Harness = {"')
    return []
  }
  const members: ContractMember[] = []
  let doc: string[] = []
  for (let index = first + 1; index < lines.length; index++) {
    const line = lines[index] ?? ""
    if (line === "}") break
    const text = line.trim()
    if (line.startsWith("  /**")) {
      doc = []
      if (text.endsWith("*/")) doc.push(text.slice(3, -2).trim())
      else if (text.length > 3) doc.push(text.slice(3).trim())
      continue
    }
    if (line.startsWith("   ") && (text.startsWith("*") || text.startsWith("/"))) {
      const piece = text.replace(/^\*\/?\s?/, "").trim()
      if (piece !== "" && !text.startsWith("*/")) doc.push(piece)
      continue
    }
    const member = /^ {2}readonly (\w+)(\?)?:/.exec(line)
    if (member) {
      const summary =
        doc.join(" ").replace(/\s+/g, " ").trim() || (memberNotes[member[1] ?? ""] ?? "")
      const sentence = /^.*?[.:](?=\s|$)/.exec(summary)?.[0] ?? summary
      members.push({
        name: member[1] ?? "",
        optional: member[2] === "?",
        summary: sentence,
        anchor: { file: contractFile, line: index + 1 },
      })
      doc = []
    }
  }
  if (members.length === 0)
    anchors.report("harness contract", contractFile, "found 0 members in `Harness`")
  return members
}

// Novadeck as an agent sees it: MCP tools, hooks, the harness contract and its adapters.
export const extractAgents = (repo: string, anchors: Anchors): AgentSurface => {
  const adapters = findAdapters(repo, anchors)
  const { harnesses, hooks } = extractAdapters(anchors, adapters)
  const tools = extractTools(anchors, adapters)
  if (tools.length === 0) anchors.report("mcp tools", mcpFile, "found 0 tools")
  return { tools, hooks, contract: extractContract(anchors), harnesses }
}
