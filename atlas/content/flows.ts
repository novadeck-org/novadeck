import type { AnchorRef, Flow, FlowStep } from "../src/atlas.ts"

type CuratedStep = Omit<FlowStep, "anchor" | "label"> & { label?: string; anchor: AnchorRef }

const host = "application/host/src"
const runnerSrc = "application/runner/src"
const ui = "application/ui/src"
const relay = "application/relay/src"

// Paths written by hand from the code. `pnpm --filter @novadeck/atlas check` fails when an anchor stops resolving; the steps
// themselves are not traced, so a flow can go stale while its anchors still resolve.
export const flows: (Omit<Flow, "steps"> & { steps: CuratedStep[] })[] = [
  {
    id: "boot",
    title: "Boot",
    summary: "From launching the app to the UI showing the workspace.",
    actors: ["electron-main", "runner", "preload", "renderer"],
    steps: [
      {
        from: "electron-main",
        to: "runner",
        label: "fork runner",
        text: "The host forks the runner as a utility process, passing the database, relay and engine paths as arguments.",
        anchor: { file: `${host}/main/runner.ts`, text: "utilityProcess.fork(" },
      },
      {
        from: "runner",
        to: "runner",
        label: "open SQLite workspace",
        text: "The runner opens the SQLite workspace and writes the shell integration and agent plugins.",
        anchor: {
          file: `${runnerSrc}/runner.ts`,
          text: "const store = openStore(options.database)",
        },
      },
      {
        from: "electron-main",
        to: "renderer",
        label: "load packaged UI",
        text: "The host creates the window and loads the packaged UI, or the Vite dev server in development.",
        anchor: { file: `${host}/main/index.ts`, text: "void window.loadFile(" },
      },
      {
        from: "preload",
        to: "renderer",
        label: "expose window.novadeck",
        text: "The preload exposes window.novadeck, including requestRunner, to the page.",
        anchor: {
          file: `${host}/preload/index.ts`,
          text: 'contextBridge.exposeInMainWorld("novadeck"',
        },
      },
      {
        from: "renderer",
        to: "electron-main",
        label: "request runner port",
        text: "The UI's desktop transport asks the host for a runner port, which the preload sends over IPC.",
        anchor: { file: "application/protocol/src/desktop.ts", text: "host.requestRunner(id)" },
      },
      {
        from: "electron-main",
        to: "runner",
        label: "MessageChannel to runner",
        text: "After checking that the sender is its own window, the host makes a MessageChannel and gives one end to the runner.",
        anchor: {
          file: `${host}/main/runner.ts`,
          text: 'send(child ?? spawn(), { type: "connect" }, [port1])',
        },
      },
      {
        from: "electron-main",
        to: "renderer",
        label: "port → page via preload",
        text: "The other end goes to the page, relayed by the preload as a window message because a port cannot cross the context bridge.",
        anchor: { file: `${host}/preload/index.ts`, text: "ipcRenderer.on(runnerPortChannel" },
      },
      {
        from: "runner",
        to: "runner",
        label: "serve router on port",
        text: "The runner serves the router over the port it was handed.",
        anchor: { file: `${host}/runner/index.ts`, text: "servePort(runner, ports[0])" },
      },
      {
        from: "renderer",
        to: "runner",
        label: "connect + handshake",
        text: "The UI connects the protocol client and completes the handshake before anything renders.",
        anchor: {
          file: `${ui}/backend/runner/index.ts`,
          text: "runner = await connectRunner(through(), { signal })",
        },
      },
      {
        from: "renderer",
        to: "runner",
        label: "list / seed projects",
        text: "It lists projects, sessions and terminals, and a first run gets a Home project and a session created for it.",
        anchor: {
          file: `${ui}/backend/runner/index.ts`,
          text: 'runner.projects.create({ id: newId(), name: "Home" })',
        },
      },
    ],
  },
  {
    id: "keystroke",
    title: "Keystroke",
    summary: "A key typed in a terminal reaches the shell, and its output comes back to xterm.",
    actors: ["renderer", "runner", "agent"],
    steps: [
      {
        from: "renderer",
        to: "renderer",
        label: "key → xterm data",
        text: "xterm turns the key into data, and the screen passes it on unless the shell has exited.",
        anchor: {
          file: `${ui}/backend/runner/screens.ts`,
          text: "const input = xterm.onData(send)",
        },
      },
      {
        from: "renderer",
        to: "runner",
        label: "terminals.write",
        text: "The attachment sends the data in a terminals.write call.",
        anchor: {
          file: "application/protocol/src/runner.ts",
          text: "await link.wire.terminals.write({ terminalId: this.id, data })",
        },
      },
      {
        from: "runner",
        to: "runner",
        label: "check control",
        text: "The router hands the call to the terminal manager, which checks that this connection controls the terminal.",
        anchor: {
          file: `${runnerSrc}/router.ts`,
          text: "write: authorized.terminals.write.handler",
        },
      },
      {
        from: "runner",
        to: "agent",
        label: "write to PTY",
        text: "Unless a doorbell or answer holds the input, the manager writes the data to the PTY.",
        anchor: {
          file: `${runnerSrc}/terminals/manager.ts`,
          text: "record.process.write(input.data)",
        },
      },
      {
        from: "agent",
        to: "runner",
        label: "PTY output",
        text: "The shell or agent in the PTY prints, and node-pty reports the output.",
        anchor: { file: `${runnerSrc}/terminals/manager.ts`, text: "child.onData((data) => {" },
      },
      {
        from: "runner",
        to: "runner",
        label: "draw headless screen",
        text: "The manager draws the output on its own headless screen, then emits it in chunks to every subscriber.",
        anchor: {
          file: `${runnerSrc}/terminals/manager.ts`,
          text: "private output(record: Record, child: pty.IPty, data: string): void",
        },
      },
      {
        from: "runner",
        to: "renderer",
        label: "attach output event",
        text: "The attach stream yields each chunk as an output event.",
        anchor: {
          file: `${runnerSrc}/router.ts`,
          text: "attach: authorized.terminals.attach.handler",
        },
      },
      {
        from: "renderer",
        to: "renderer",
        label: "xterm draws chunk",
        text: "The UI writes the chunk into xterm, which draws it.",
        anchor: {
          file: `${ui}/backend/runner/follow.ts`,
          text: 'else if (event.type === "output") await screen.write(event.data)',
        },
      },
    ],
  },
  {
    id: "show",
    title: "Show",
    summary:
      "An agent calls the show MCP tool and the item appears in the bar beside its terminal.",
    actors: ["agent", "relay", "runner", "renderer"],
    steps: [
      {
        from: "agent",
        to: "relay",
        label: "show tool call",
        text: "The agent calls the show tool, and the call goes to the relay as a JSON-RPC line on stdin.",
        anchor: { file: `${relay}/mcp.rs`, text: "async fn carry(" },
      },
      {
        from: "relay",
        to: "runner",
        label: "forward JSON-RPC line",
        text: "The relay forwards the line unchanged over the socket it opened for this terminal.",
        anchor: { file: `${relay}/mcp.rs`, text: "to_runner.write_all(&buffer[..read])" },
      },
      {
        from: "runner",
        to: "runner",
        label: "bind terminal + token",
        text: "The runner's report server answers the session, binding each call to the terminal and token the relay named.",
        anchor: { file: `${runnerSrc}/shell/reports.ts`, text: "const relayCall =" },
      },
      {
        from: "runner",
        to: "runner",
        label: "map show to present",
        text: "The MCP server maps the show tool to a present call.",
        anchor: { file: `${runnerSrc}/shell/mcp.ts`, text: "const show: Tool<Shown> = {" },
      },
      {
        from: "runner",
        to: "runner",
        label: "route call by type",
        text: "The terminal manager routes the call by type.",
        anchor: {
          file: `${runnerSrc}/terminals/manager.ts`,
          text: "private call(call: Call): Promise<unknown>",
        },
      },
      {
        from: "runner",
        to: "runner",
        label: "check token",
        text: "It checks the terminal's token and reads the request.",
        anchor: {
          file: `${runnerSrc}/terminals/manager.ts`,
          text: "async present(call: Call): Promise<PresentAnswer>",
        },
      },
      {
        from: "runner",
        to: "runner",
        label: "save companion item",
        text: "The companion items point at the file or page and save the item in the store against the terminal.",
        anchor: { file: `${runnerSrc}/companions/items.ts`, text: "private keep(" },
      },
      {
        from: "runner",
        to: "renderer",
        label: "companions watch stream",
        text: "The change goes out on the companions watch stream every connection holds.",
        anchor: {
          file: `${runnerSrc}/companions/items.ts`,
          text: "async *watch(ownerId: string, signal?: AbortSignal): AsyncGenerator<CompanionChange>",
        },
      },
      {
        from: "renderer",
        to: "renderer",
        label: "item → companion bar",
        text: "The UI applies the change, and the item appears in the terminal's bar.",
        anchor: { file: `${ui}/backend/runner/items.ts`, text: "const changes = runner.watch()" },
      },
      {
        from: "runner",
        to: "agent",
        label: 'reply "Showing …"',
        text: 'Meanwhile the runner answers the call with text such as "Showing …", which the relay prints back to the agent.',
        anchor: { file: `${runnerSrc}/shell/reports.ts`, text: "const serveSession = (" },
      },
    ],
  },
  {
    id: "permission",
    title: "Permission",
    summary: "An agent asks the person for permission and they answer from the chat view.",
    actors: ["agent", "relay", "runner", "renderer"],
    steps: [
      {
        from: "agent",
        to: "relay",
        label: "PermissionRequest hook",
        text: "Claude Code reaches a permission prompt and fires its PermissionRequest hook, a command the plugin registered.",
        anchor: { file: "harnesses/claude/src/index.ts", text: "command: hook(platform, event)," },
      },
      {
        from: "relay",
        to: "runner",
        label: "forward hook payload",
        text: "The relay forwards the payload with the terminal and token, and this hook is only reported, not answered.",
        anchor: {
          file: `${relay}/hook.rs`,
          text: "pub fn run(agent: &str, event: &str, config: &Config)",
        },
      },
      {
        from: "runner",
        to: "runner",
        label: "report, no answer",
        text: "The report server hands a hook without a deadline to the manager as a report.",
        anchor: { file: `${runnerSrc}/shell/reports.ts`, text: "handlers.report(report)" },
      },
      {
        from: "runner",
        to: "runner",
        label: "decode payload",
        text: "The manager lets the agent's harness decode the payload into events.",
        anchor: {
          file: `${runnerSrc}/terminals/manager.ts`,
          text: "const decoded = firedFacts(harnesses[report.agent].decode(report), report)",
        },
      },
      {
        from: "runner",
        to: "runner",
        label: "attention-requested",
        text: "Claude's decoder turns a PermissionRequest into an attention-requested event of kind permission, question or plan.",
        anchor: { file: "harnesses/claude/src/decode.ts", text: 'type: "attention-requested",' },
      },
      {
        from: "runner",
        to: "runner",
        label: "add pending request",
        text: "The activity reducer adds the request to the agent's pending list.",
        anchor: {
          file: `${runnerSrc}/harnesses/activity.ts`,
          text: 'case "attention-requested": {',
        },
      },
      {
        from: "runner",
        to: "renderer",
        label: "agents.detail stream",
        text: "The agents.detail stream sends the changed detail to the UI.",
        anchor: {
          file: `${runnerSrc}/router.ts`,
          text: "detail: authorized.agents.detail.handler",
        },
      },
      {
        from: "renderer",
        to: "renderer",
        label: "requests → chat cards",
        text: "The conversation turns the pending requests into cards in the chat view, where the person picks an answer.",
        anchor: {
          file: `${ui}/backend/runner/conversations.ts`,
          text: "const requestsOf = (detail: AgentDetail, root: string | null)",
        },
      },
      {
        from: "renderer",
        to: "runner",
        label: "agents.answer call",
        text: "The chosen answer goes to the runner as an agents.answer call.",
        anchor: {
          file: `${ui}/backend/runner/conversations.ts`,
          text: "streams.answer(terminalId, request, requestAnswerOf(answer))",
        },
      },
      {
        from: "runner",
        to: "agent",
        label: "press dialog keys",
        text: "The runner reads the dialog off the terminal screen, checks it is the one answered, and presses the keys a person would.",
        anchor: {
          file: `${runnerSrc}/terminals/answers.ts`,
          text: "const steps = read.keys(answer)",
        },
      },
    ],
  },
  {
    id: "message",
    title: "Message",
    summary: "One agent sends a message to another agent's terminal.",
    actors: ["agent", "relay", "runner"],
    steps: [
      {
        from: "agent",
        to: "relay",
        label: "send tool call",
        text: "The sending agent calls the send tool with the recipient's handle and a text.",
        anchor: { file: `${runnerSrc}/shell/mcp.ts`, text: 'name: "send",' },
      },
      {
        from: "relay",
        to: "runner",
        label: "carry call to runner",
        text: "The relay carries the call to the runner over its terminal's socket.",
        anchor: { file: `${runnerSrc}/shell/reports.ts`, text: "const relayCall =" },
      },
      {
        from: "runner",
        to: "runner",
        label: "route to peers",
        text: "The manager passes the send call to its peers.",
        anchor: { file: `${runnerSrc}/terminals/manager.ts`, text: "return this.peers.send(call)" },
      },
      {
        from: "runner",
        to: "runner",
        label: "store waiting message",
        text: "Messaging checks the text and recipient, finds or starts a thread, applies the limits and stores the message as waiting.",
        anchor: {
          file: `${runnerSrc}/messaging/messaging.ts`,
          text: "private sendFrom(live: Live, request: unknown, about: About): SendAnswer",
        },
      },
      {
        from: "runner",
        to: "agent",
        label: "doorbell paste",
        text: "If the recipient is idle at its prompt, the doorbell pastes a short line into its PTY and presses Enter once it has landed alone.",
        anchor: { file: `${runnerSrc}/terminals/doorbell.ts`, text: "export class Doorbell {" },
      },
      {
        from: "agent",
        to: "relay",
        label: "UserPromptSubmit hook",
        text: "The recipient starts a turn and fires its UserPromptSubmit hook; a working recipient would get the message from a tool or Stop hook instead.",
        anchor: { file: "harnesses/claude/src/index.ts", text: 'UserPromptSubmit: "prompt",' },
      },
      {
        from: "relay",
        to: "runner",
        label: "hook with deadline",
        text: "The relay sends the hook with a deadline, so the runner treats it as an ask and answers by then.",
        anchor: {
          file: `${runnerSrc}/shell/reports.ts`,
          text: "answer = await within(handlers.ask(report, hook.deadline), ms, unheard)",
        },
      },
      {
        from: "runner",
        to: "runner",
        label: "lease as context",
        text: "Messaging leases the waiting message and wraps it as the agent's attributed context, never as the person's prompt.",
        anchor: {
          file: `${runnerSrc}/messaging/messaging.ts`,
          text: "private askPrompt({ live, root, profile, silent, events, time }: Asked): HookAnswer",
        },
      },
      {
        from: "relay",
        to: "agent",
        label: "print hook output",
        text: "The relay prints the runner's answer as the hook's output, which the agent adds to its context.",
        anchor: { file: `${relay}/hook.rs`, text: "fn print(text: &str) -> bool" },
      },
      {
        from: "relay",
        to: "runner",
        label: "ack lease",
        text: "The relay acknowledges the lease, and the runner marks the message delivered.",
        anchor: { file: `${relay}/hook.rs`, text: 'json!({ "ack": lease })' },
      },
    ],
  },
]
