import { randomUUID } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentName, TerminalChange, TerminalSummary } from "@novadeck/protocol"

import { CompanionItems } from "../companions/items.js"
import { handleWords } from "../terminals/handles.js"
import { Terminals, type TerminalOptions } from "../terminals/index.js"
import type { AgentTurn } from "../terminals/saved-terminals.js"
import { it as base } from "../test.js"
import { plainSealer } from "../testing/sealing.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { installShellFiles } from "./install.js"

export const bash = "/bin/bash"

export type Fixture = {
  home: string
  /** Where Novadeck writes the plugins agents install when connected. */
  plugins: string
  store: WorkspaceStore
  sessionId: string
  manager: (options?: TerminalOptions) => Terminals
  /** The items a manager's agents show, kept in the store. */
  items: (manager: Terminals) => CompanionItems
  /** Collects every change the manager reports, and waits for one that matches. */
  watch: (
    manager: Terminals,
  ) => (match: (terminal: TerminalSummary) => boolean) => Promise<TerminalSummary>
  until: (manager: Terminals, terminalId: string, text: string | RegExp) => Promise<string>
  /** Saves the session `agent` last reported in the terminal, as an earlier runner did. */
  saveSession: (id: string, agent: AgentName, sessionId: string, turn?: AgentTurn) => void
}

/** Everything the terminal printed so far, read from its screen. */
export const screen = async (terminals: Terminals, terminalId: string) => {
  const controller = new AbortController()
  const stream = terminals.attach({ terminalId, mode: "observe" }, "reader", controller.signal)
  try {
    for await (const event of stream) if (event.type === "snapshot") return event.data
    return ""
  } finally {
    controller.abort()
    await stream.return(undefined)
  }
}

/** Waits until the terminal's screen shows `text`. */
const until = async (terminals: Terminals, terminalId: string, text: string | RegExp) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- Polls the screen until it shows the text.
    const shown = await screen(terminals, terminalId)
    if (shown.includes("stand-in TUI startup failed:"))
      throw new Error(`Terminal fixture exited before readiness:\n${shown}`)
    if (typeof text === "string" ? shown.includes(text) : text.test(shown)) return shown
    // eslint-disable-next-line no-await-in-loop -- As above.
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Terminal never showed ${String(text)}:\n${await screen(terminals, terminalId)}`)
}

export const it = base.extend<{ shell: Fixture }>({
  shell: async ({ resources }, use) => {
    // Long names, as Windows shells report them.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-integration-")))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const home = join(root, "home")
    mkdirSync(home)
    const store = new WorkspaceStore(join(root, "data", "workspace.sqlite"))
    resources.defer(() => store.close())
    const project = await store.createProject({ id: randomUUID(), name: "P", cwd: home })
    const session = store.createSession({ id: randomUUID(), projectId: project.id, name: "S" })
    const companions = new WeakMap<Terminals, CompanionItems>()
    const manager = (options: TerminalOptions = {}) => {
      // What agents show, kept in the store as the runner keeps it.
      const items = new CompanionItems({
        records: store,
        terminal: (terminalId) => terminals.place(terminalId),
        project: () => undefined,
        livePlan: (item) => terminals.livePlan(item),
        pollMs: 20,
      })
      const terminals: Terminals = new Terminals({
        shell: bash,
        env: { HOME: home, PS1: "$ ", PATH: process.env.PATH },
        // Only when the test has none of its own: an install nobody waits for would fail
        // unseen once the folder goes.
        shellFiles:
          "shellFiles" in options
            ? options.shellFiles
            : installShellFiles(join(root, "data", "shell")),
        records: store,
        messages: store,
        projectOf: (sessionId) => store.session(sessionId).projectId,
        items,
        // Masks nothing: these tests are about when screens are saved, not about secrets.
        redactor: { redact: async ({ text }) => text, close: async () => {} },
        // Seals nothing: these tests read the transcripts saved.
        sealer: plainSealer(),
        transcriptMs: 50,
        // The list's order, not each session's shuffle, so tests know the handles given.
        handleOrder: () => handleWords,
        ...options,
      })
      resources.defer(() => terminals.shutdown())
      companions.set(terminals, items)
      return terminals
    }
    const watch = (terminals: Terminals) => {
      const controller = new AbortController()
      const stream = terminals.watch("watcher", controller.signal)
      resources.defer(async () => {
        controller.abort()
        await stream.return(undefined)
      })
      const seen: TerminalChange[] = []
      return async (match: (terminal: TerminalSummary) => boolean) => {
        const earlier = seen.find((change) => change.type === "changed" && match(change.terminal))
        if (earlier?.type === "changed") return earlier.terminal
        while (true) {
          // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
          const result = await stream.next()
          if (result.done) throw new Error("Watch ended")
          seen.push(result.value)
          if (result.value.type === "changed" && match(result.value.terminal))
            return result.value.terminal
        }
      }
    }
    const plugins = join(root, "data", "shell", "plugins")
    const saveSession = (id: string, agent: AgentName, sessionId: string, turn?: AgentTurn) =>
      store.saveTerminal({
        id,
        sessionId: session.id,
        cwd: store.terminal(id)?.cwd ?? home,
        handle: store.terminal(id)?.handle ?? store.giveHandle(session.id),
        naming: store.terminal(id)?.naming ?? {
          person: null,
          opener: null,
          murmur: null,
          summary: null,
        },
        openedBy: null,
        ledBy: null,
        command: null,
        lastProgram: null,
        work: null,
        agents: { [agent]: { sessionId, seq: 1, ...(turn && { turn }) } },
        promptedAt: null,
      })
    const items = (terminals: Terminals) => companions.get(terminals)!
    await use({
      home,
      plugins,
      store,
      sessionId: session.id,
      manager,
      items,
      watch,
      until,
      saveSession,
    })
  },
})

export const create = (
  manager: Terminals,
  fixture: Fixture,
  input: {
    id?: string
    sessionId?: string
    cwd?: string
    restore?: boolean
    resume?: AgentName
    command?: string
  } = {},
) =>
  manager.create(
    {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId ?? fixture.sessionId,
      cwd: input.cwd ?? fixture.home,
      cols: 100,
      rows: 20,
      ...(input.restore !== undefined && { restore: input.restore }),
      ...(input.resume !== undefined && { resume: input.resume }),
      ...(input.command !== undefined && { command: input.command }),
    },
    "owner",
  )

// A stand-in agent in the foreground that sends the hook's reports as given, one after
// another, as Novadeck's relay does: each hears its answer, acknowledging a lease it
// names, before the next goes. Then it waits.
export const reporter = (
  home: string,
  reports: {
    agent: string
    sessionId: string
    seq: number
    source: string
    /** The agent process that reported it; unknown when left out. */
    instance?: string
    /** The hook event, SessionStart when left out, and more of its payload. */
    event?: string
    fields?: object
    /** How long to wait before sending it, in milliseconds, so a test sees the state before. */
    wait?: number
  }[],
): string => {
  const bin = join(home, "bin")
  mkdirSync(bin, { recursive: true })
  const script = join(bin, "report.cjs")
  writeFileSync(
    script,
    [
      'const net = require("node:net")',
      `const reports = ${JSON.stringify(reports)}`,
      "const { NOVADECK_TERMINAL_ID: terminalId, NOVADECK_REPORT_TOKEN: token } = process.env",
      // Hooks send wall-clock times; the given ones order the reports after that.
      "const base = Date.now()",
      "const send = (index) => setTimeout(() => post(index), reports[index]?.wait ?? 0)",
      "const post = (index) => {",
      '  if (index === reports.length) { console.log("reports sent"); return process.stdin.resume() }',
      "  const socket = net.connect(process.env.NOVADECK_REPORT)",
      '  socket.on("close", () => send(index + 1))',
      "  const { agent, sessionId, seq, source, instance = null, fields = {} } = reports[index]",
      // As the relay forwards it: the event, and the agent's own payload as it came.
      '  const event = reports[index].event ?? (agent === "agy" ? "PreInvocation" : "SessionStart")',
      '  const payload = agent === "agy" ? { conversationId: sessionId, ...fields } : { hook_event_name: event, session_id: sessionId, source, ...fields }',
      // The agent process: Claude Code names itself, the others are the nearest ancestor
      // with the agent's name.
      '  const named = instance !== null && agent === "claude"',
      "  const env = named ? { CLAUDE_PID: instance } : {}",
      "  const ancestors = instance !== null && !named ? [{ pid: Number(instance), name: agent }] : []",
      "  const hook = { relay: 2, kind: 'hook', terminalId, token, agent, event, seq: base + seq, ancestors, env, payload: JSON.stringify(payload) }",
      '  let text = ""',
      '  socket.setEncoding("utf8")',
      '  socket.on("data", (chunk) => {',
      "    text += chunk",
      '    if (!text.includes("\\n")) return',
      "    const { leaseId } = JSON.parse(text)",
      '    socket.end(leaseId ? JSON.stringify({ ack: leaseId }) + "\\n" : undefined)',
      "  })",
      '  socket.write(JSON.stringify(hook) + "\\n")',
      "}",
      "send(0)",
    ].join("\n"),
  )
  writeFileSync(join(bin, "report"), `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`)
  chmodSync(join(bin, "report"), 0o755)
  return bin
}

// How a stand-in calls a tool of Novadeck's MCP server, as Novadeck's relay carries an
// agent's session: its first line names the terminal and the token, and once the runner
// takes the session, a `tools/call` names the tool for the runner's call of `type`. It hands `done` what the agent was
// told: `{ ok: true, text }`, or `{ ok: false, reason }` with the failure's text, or null
// without an answer. Then the session ends.
export const toolCall = [
  "const toolCall = (type, args, token, done) => {",
  '  const tools = { show: "show", open: "open_terminal", close: "close_terminal" }',
  "  const socket = net.connect(process.env.NOVADECK_REPORT)",
  '  let text = ""',
  '  socket.setEncoding("utf8")',
  // The runner takes the session with a line of its own, then answers the call.
  '  const answer = () => text.split("\\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.id === 1)',
  '  socket.on("data", (chunk) => {',
  "    text += chunk",
  '    if (answer()) socket.end(JSON.stringify({ relay: "eof" }) + "\\n")',
  "  })",
  '  socket.on("close", () => {',
  "    const { result } = answer() ?? {}",
  "    const said = result && result.content[0].text",
  "    done(!result ? null : result.isError ? { ok: false, reason: said } : { ok: true, text: said })",
  "  })",
  "  const terminalId = process.env.NOVADECK_TERMINAL_ID",
  "  const hello = { relay: 2, kind: 'mcp', terminalId, token }",
  "  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tools[type] ?? type, arguments: args } }",
  '  socket.write(JSON.stringify(hello) + "\\n" + JSON.stringify(call) + "\\n")',
  "}",
].join("\n")

// A stand-in for an agent calling Novadeck's tools: `call-tools <name>` makes the calls in
// `<name>.json`, one after another, keeps what each told the agent in
// `<name>.answers.json`, then says so. Each call is a `show` unless it names its type.
export const showStandIn = (home: string): string => {
  const bin = join(home, "bin")
  mkdirSync(bin, { recursive: true })
  const script = join(bin, "call-tools.cjs")
  writeFileSync(
    script,
    [
      'const fs = require("node:fs")',
      'const net = require("node:net")',
      "const name = process.argv[2]",
      'const calls = JSON.parse(fs.readFileSync(name + ".json", "utf8"))',
      "const { NOVADECK_REPORT_TOKEN: token } = process.env",
      "const answers = []",
      toolCall,
      "const send = (index) => {",
      "  if (index === calls.length) {",
      '    fs.writeFileSync(name + ".answers.json", JSON.stringify(answers))',
      '    return console.log("answered " + require("node:path").basename(name))',
      "  }",
      '  const { request, token: given, type = "show" } = calls[index]',
      "  toolCall(type, request, given ?? token, (answer) => {",
      "    answers.push(answer)",
      "    send(index + 1)",
      "  })",
      "}",
      "send(0)",
    ].join("\n"),
  )
  writeFileSync(join(bin, "call-tools"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(join(bin, "call-tools"), 0o755)
  return bin
}

// A stand-in agent that prints how it was started, and what it sees, then waits.
export const fakeAgent = (home: string, agent: AgentName): string => {
  const bin = join(home, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, agent),
    `#!/bin/sh\necho "${agent} args: $* prompt=[\${FROM_PROMPT:-}] resume=[\${NOVADECK_RESUME:-}]"\nread line\n`,
    { mode: 0o755 },
  )
  return bin
}

// A stand-in for Claude Code with Novadeck's plugin connected: it runs the plugin's
// SessionStart hook through sh with the session on stdin, then waits.
export const fakeClaude = (home: string, plugins: string, session: string): string => {
  const hooks = join(plugins, "claude", "novadeck", "hooks", "hooks.json")
  const bin = join(home, "bin")
  mkdirSync(bin, { recursive: true })
  const path = join(bin, "claude")
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      // As Claude Code names itself to its hooks: a script's process goes by its shell's
      // name on macOS, so it can't be found by name there.
      "export CLAUDE_PID=$$",
      `command=$("${process.execPath}" -e 'console.log(require(process.argv[1]).hooks.SessionStart[0].hooks[0].command)' '${hooks}')`,
      `printf '{"hook_event_name":"SessionStart","source":"startup","session_id":"${session}","cwd":"%s"}' "$PWD" | sh -c "$command"`,
      'echo "claude is running"',
      "read line",
    ].join("\n"),
  )
  chmodSync(path, 0o755)
  return bin
}

/**
 * Makes the calls from the terminal, as an agent calls Novadeck's tools, and reads what
 * each told it.
 */
export const show = async (
  shell: Fixture,
  manager: Terminals,
  terminalId: string,
  calls: { request: object; token?: string; type?: "show" | "open" | "close" }[],
  // Who controls the terminal's input.
  owner = "owner",
): Promise<unknown[]> => {
  const name = `calls-${randomUUID().slice(0, 8)}`
  const path = join(shell.home, name)
  writeFileSync(`${path}.json`, JSON.stringify(calls))
  manager.write({ terminalId, data: `call-tools ${path}\r` }, owner)
  await shell.until(manager, terminalId, `answered ${name}`)
  return JSON.parse(readFileSync(`${path}.answers.json`, "utf8")) as unknown[]
}

// A call to open a terminal, as Novadeck's MCP server sends it.
export const open = (request: object, token?: string) => ({
  type: "open" as const,
  request,
  ...(token !== undefined && { token }),
})
