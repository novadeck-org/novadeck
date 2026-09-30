# Backend API

This describes the runner behind the [terminal plan](backend-plan.md) and how the UI
uses it. The Electron host runs the runner and hands its window a port to it; the UI
connects through that port, or in a browser over a WebSocket, with the runner adapter
in `application/ui/src/backend/runner/`.

## Run and test

Use the repository's Node.js 26 and pnpm versions. `node-pty` is a native dependency;
installation can require Python and a C/C++ toolchain for your platform.
`node-pty` is pinned exactly to `1.2.0-beta.14` for its native cleanup fixes and
correct macOS spawn-helper permissions. One local patch
(`patches/node-pty@1.2.0-beta.14.patch`) adds an error listener to its Windows input
socket ([#942](https://github.com/microsoft/node-pty/issues/942),
[#976](https://github.com/microsoft/node-pty/issues/976)). A failed write, such as
EAGAIN, used to crash the process. The failed socket cannot take input again, so the
patch logs it and ends that terminal, which its viewers see as an exit. It also makes
ending a terminal twice harmless. Drop the patch once upstream fixes those issues; pnpm
refuses an install whose patch no longer matches the pinned version.
Do not advance the pin without checking the reported
[Windows startup regression in beta.15](https://github.com/microsoft/node-pty/issues/955).
Beta.14 retains the older
[delayed-worker startup deadlock risk](https://github.com/microsoft/node-pty/pull/943),
particularly under a debugger. Keep its pnpm build script enabled and validate
dependency upgrades on Linux, macOS, and Windows.

On Windows the runner uses node-pty's bundled ConPTY (`useConptyDll`), a newer console
host from Windows Terminal, instead of the one built into Windows. The built-in host
occasionally lost terminal input: a traced test command never reached the program
although node-pty reported no error. node-pty marks this option experimental, and
console-host fixes now arrive with node-pty upgrades rather than Windows Update.
Packaged builds use node-pty's N-API prebuilds as they are (`npmRebuild: false`): a
source rebuild would take precedence over them without the bundled ConPTY files. The
release workflow runs `pnpm --filter @novadeck/host smoke` against each unpacked
package. It checks that the Windows package ships `conpty.dll` and `OpenConsole.exe`
and has no source-built node-pty, runs a real shell through the packaged runner, and on
Windows confirms that `OpenConsole.exe` hosts it.

From the repository root:

```sh
pnpm install
pnpm exec turbo run build --filter=@novadeck/runner
cp application/runner/example.env application/runner/.env
```

Generate a credential with the command in `example.env`, then set `NOVADECK_TOKEN`
in the ignored `.env` file. Leave `HOST=127.0.0.1` for local testing. Run:

```sh
pnpm --filter @novadeck/runner start
pnpm exec turbo run test --filter=@novadeck/runner
```

The turbo test command builds the protocol package and the runner CLI before running.
Tests use ephemeral listeners, temporary SQLite files, and real PTYs; the UI is not
involved.

- API tests use a small controllable child program inside a real PTY. Separate
  smoke tests exercise the platform shell and launch the built CLI in a fresh
  process, including configuration, authentication, and metadata across restarts.
- Recovery tests feed terminal events into headless xterm instances and compare
  screen state before and after reconnection, including cursor position, styling,
  alternate buffers, Unicode, and resize events.
- Generated fast-check command sequences exercise ownership and output-budget
  accounting. Failures report a seed and shrink path for reproduction.
- Each test owns its resources. Cleanup attempts every registered release, even
  if another cleanup fails.

Backend CI runs on Linux, macOS, and Windows. POSIX signal and hangup assertions
are explicitly platform-specific; Windows process termination is not a graceful
SIGTERM test. Packaged Electron builds and remote TLS deployment are checked
separately from these tests.

Without a token, the runner exposes only the existing HTTP status behavior.
With a token, the RPC WebSocket endpoint is `/api/rpc`. The CLI persists metadata
at `~/.local/share/novadeck/workspace.sqlite` unless `NOVADECK_DATABASE` is set, and
writes its [shell integration](#shell-integration-and-restoring-terminals) to a `shell`
folder beside it.
Programmatic `startServer` from `@novadeck/runner/server` and `createRunner` use
an in-memory database when no path is supplied. `@novadeck/runner/http` stays free
of native terminal code, so the Electron main process can serve the status endpoint
without it.

For a VPS, terminate TLS at a trusted reverse proxy and forward WebSocket upgrades.
Set `CORS_ORIGINS` to the exact trusted frontend origins. A static UI can later
connect directly over WSS; it does not need a terminal backend on Cloudflare.
Follow the [runner trust boundary](../SECURITY.md#terminal-runner) before exposing
the service. There is no TLS, login page, or public multi-user hosting layer here.

## Runner API

The runner owns shells and workspace metadata. The UI talks to it through one
`Runner` interface, whether the runner is bundled with the host or deployed
separately; only the transport differs.

```ts
import { connectRunner, desktop, messagePort, websocket } from "@novadeck/protocol/client"

// Deployed separately: a token-authenticated WebSocket (use wss:// remotely).
const runner = await connectRunner(websocket("ws://127.0.0.1:8787/api/rpc", { token }))

// Bundled in the NovaDeck desktop app: a port from the host to its runner process.
const runner = await connectRunner(desktop())

// Any other host that hands the page a MessagePort to a runner.
const runner = await connectRunner(messagePort(port))
```

`connectRunner` resolves after the first handshake and rejects with a typed
`RunnerError` (for example `UNAUTHORIZED` or `INCOMPATIBLE_PROTOCOL`). After that
it reconnects on its own. `runner.status` holds the current state, and
`runner.watch()` yields it and every change, so a UI reads connection state with
`for await` instead of registering callbacks.

```ts
const id = () => crypto.randomUUID()
const project = await runner.projects.create({
  id: id(),
  name: "My project",
  cwd: "/work/project",
})
const session = await runner.sessions.create({
  id: id(),
  projectId: project.id,
  name: "Development",
})
const created = await runner.terminals.create({
  id: id(),
  sessionId: session.id,
  cols: 120,
  rows: 30,
})

const terminal = await runner.terminals.attach(created.id)
for await (const event of terminal) render(event) // snapshot, output, resized, exited

// Independent of reading, typically from keyboard and layout handlers:
await terminal.write("pwd\r")
await terminal.resize({ cols: 100, rows: 32 })
await terminal.detach() // or `break` out of the loop; the shell keeps running
await runner.terminals.close(created.id) // ends the shell and removes the terminal
```

An attached terminal is a single async stream of events. The client handles
everything else:

- **Acknowledgement.** Requesting the next event acknowledges the previous one, so
  flow control follows the renderer's actual pace.
- **Reconnection.** After a connection drops, the attachment resumes after the
  last event it produced. Missed output is replayed, or a fresh snapshot replaces
  the screen when the history has expired. A cursor never crosses runner
  lifetimes.
- **Slow viewers.** A viewer that falls too far behind skips its backlog and
  resumes from a fresh snapshot instead of failing.
- **Errors.** Iteration ends normally when the shell exits, the terminal is
  detached, or the client closes. It throws a `RunnerError` only when the attachment
  cannot continue, such as `CONTROL_IN_USE` after another client took control
  during a disconnection or `TERMINAL_NOT_FOUND` after the runner restarted.

The client names every project, session, and terminal it creates with a fresh UUID,
so it can refer to one before the runner answers. A taken ID rejects with `CONFLICT`;
for terminals that includes exited records the runner still retains. A project
created without `cwd` opens in the home directory of the user running the runner.
`sessions.save({ sessionId, state })` replaces a session's `state`, a string the
runner stores with the session without reading it, such as a UI layout. Sessions
report `null` until the first save. A state holds at most `maxClientStateLength`
(196,608) characters, and over WebSocket the whole call must also fit in one
`maxWebSocketMessageBytes` (256 KiB) message; both limits are exported from
`@novadeck/protocol`. Once the runner starts shutting down it refuses saves with
`RUNTIME_CLOSING`, so shells ending on the way out cannot overwrite the last state; it
saves nothing of its terminals either, after one last save while they still run.

`runner.terminals.watch()` follows every terminal on the runner, across sessions:

```ts
for await (const change of runner.terminals.watch()) {
  if (change.type === "reset") startOver() // a fresh sequence follows
  if (change.type === "changed") show(change.terminal) // includes exit and process
  if (change.type === "removed") forget(change.terminalId)
  if (change.type === "synced") pruneUnreported() // gone unless reported since `reset`
}
```

Each subscription, the first and every one after a reconnection or a retried
refusal, yields `reset`, then `changed` for each terminal, then `synced`, then
changes as they happen: creation, size, exit, and the foreground process, sampled
about once a second. `removed` reports a closed terminal or an evicted exited
record. A consumer clears its set of reported terminals on `reset` and, at `synced`,
forgets every terminal outside it, such as one that ended with a restarted runner.
`reset` comes from the client; the runner's own stream starts at the first `changed`.
The runner keeps at most the latest unread summary per terminal for each watcher, so a
slow consumer skips intermediate states instead of growing a backlog. A refused
subscription, such as `RESOURCE_LIMIT` while the connection has too many calls in
flight, is retried after a delay growing from 200 ms to 3 s. Iteration ends only
when the client closes or on `return()`. A terminal summary's `process`
is its foreground process, such as the shell or a program running in it: its `name`,
and `argv`, the process group leader's command line, on Linux (`null` elsewhere and
before the first sample). It is `null` once the terminal exits and on Windows, where
no foreground process is known. `agent` names the agent (`claude`, `codex` or `agy`) that
reported a session in the shell since its last prompt, so a client can name the
program where `process` cannot; it is `null` otherwise. `cwd` is the directory the
shell last reported at a prompt, or where it started.

Calls made while reconnecting reject with `DISCONNECTED`; input and creation are
never retried automatically. Each client sends a random client ID in its handshake,
so when it reconnects after a link only it saw fail, the runner releases the stale
connection immediately instead of after missed heartbeats, and the attachment
reclaims control. Opening a connection and completing its handshake time out after
ten seconds (`timeout`). `connectRunner` accepts a `signal` to cancel the first
connection; it does not retry that one, so a UI can report a wrong URL or token.
A MessagePort transport detects a closed runner through the port's `close` event,
which Electron and Node.js provide. `attach(id, { mode: "observe" })` follows a terminal
without controlling it; its `write`, `resize`, and `close` reject with
`CONTROL_REQUIRED`.

### Serving a runner

`@novadeck/runner` separates the runner from how clients reach it:

```ts
import { createRunner, servePort, serveWebSocket } from "@novadeck/runner"

const runner = createRunner({ database })

// Deployed: token-authenticated WebSockets at /api/rpc on an HTTP server.
serveWebSocket(runner, { token, origins }).attach(httpServer)

// Bundled: one trusted client per MessagePort, such as an Electron renderer's port
// to a utility process. Holding the port is the credential.
const dispose = servePort(runner, port)
```

The CLI (`pnpm --filter @novadeck/runner start`) and `startServer` from
`@novadeck/runner/server` compose the WebSocket form with the HTTP status
endpoint.

### Desktop app

The Electron host runs the runner in a utility process, so shells live outside the
main process, and stores metadata in `workspace.sqlite` under Electron's user-data
directory. `desktop()` asks the preload bridge for a port with
`window.novadeck.requestRunner(id)`. The main process accepts that request only from
the main frame of its own windows, opens a `MessageChannelMain`, and gives one end to
the runner and the other to the page as a window message carrying the same ID
(`@novadeck/protocol/bridge` defines the contract). Every connection, including a
reconnection, asks for a fresh port. `window.novadeck.pickDirectory()` opens a folder
picker attached to the page's window, with the same sender checks, and resolves the
chosen path or `null` when cancelled. If the runner process dies, the host starts a
new one on the next request; shells end with it, and metadata remains. Quitting the
app, or closing a window, first asks the pages involved to finish their saves, through
the callback each registered with `window.novadeck.beforeQuit(save)`. It waits up to
1.5 s for the answers, and not for a page that crashed or went away; only then does
the window close or the app end the runner's shells and exit. A system shutdown quits
the same way on Linux and macOS (Electron's `powerMonitor` `shutdown`, which holds the
shutdown back meanwhile). On Windows a window's `query-session-end` saves its page and
has the runner save every terminal while the shells still run, and `session-end`
quits. The runner writes its shell integration to a `shell` folder beside
`workspace.sqlite`, in the app's user-data directory.

### Wire contract

`@novadeck/protocol` contains runtime-validated Zod schemas, the oRPC contract, and
inferred TypeScript types. The runner implements that contract; it does not expose
arbitrary event-name handlers. oRPC is pinned to 1.15.4: its installed API uses
`eventIterator` and the server's `ws` and `message-port` adapters. The client keeps
oRPC's standard wire protocol over a small channel adapter that settles pending
calls when a socket or port closes. `@novadeck/protocol/wire` exposes the raw
`WireClient` for protocol tests. Applications use `connectRunner`.

Every connection starts with `runner.handshake({ protocolVersion, token })`, which
returns `runnerId` and the protocol version. WebSocket connections
require the token in the handshake, never in a URL, and time out after ten seconds
without it. MessagePort connections omit it. Each `terminals.attach` stream begins
with an unsequenced `attached` marker confirming the granted mode, followed by
sequenced terminal events.

`terminals.list({ sessionId })` discovers live and retained exited terminals, and
`terminals.watch()` streams them all as they change. Each watch belongs to its
connection and ends with it. Creation uses the project's directory unless `cwd` is
supplied. Directories must exist and be absolute. The server chooses the shell;
clients send terminal input, not executable configuration. `write` accepts control
characters, including Ctrl-C (`\u0003`). A successful write means accepted input,
not command completion.

## Stream and lifetime rules

- Creation grants the creating connection control. Only that connection can
  write or resize. Another connection can attach with `mode: "observe"`.
  There is one attachment per terminal per connection. Cancelling a controlling
  attachment or disconnecting releases control, but leaves the shell running.
- Events carry `terminalId` and an increasing `sequence`. Initial attachment emits
  a serialized screen snapshot with dimensions and `exit`, null while the shell
  runs. Output, resize, and exit events follow in order. A snapshot replaces the old
  screen; it is not appended. ACK snapshots too, including sequence zero.
- An `exited` event, like an exited terminal's summary and snapshot, carries `exit`:
  the shell's exit `code`, the `signal` name that ended it (such as `SIGKILL`; null
  for a normal exit and on Windows), and `ranMs`, how long it ran, so a client can
  tell a shell that failed at startup from one that ended later. It is null while
  the terminal runs.
- Reconnect with a new socket/client and handshake. Attach using `afterSequence`
  from the last fully applied event. Available history is replayed; an expired
  cursor falls back to a fresh snapshot. A future cursor is rejected. Scope saved
  cursors to both runner identity and terminal ID. `connectRunner` does this for
  its attachments; raw wire clients must do it themselves.
- Default limits are 32 connections, 32 calls in flight per WebSocket connection
  (1,024 for the trusted MessagePort connection: the desktop app keeps ACKs, input,
  resizes and state saves in flight across many terminals at once),
  `maxWebSocketMessageBytes` (256 KiB) per incoming WebSocket message, 16,384
  characters per input call, 1 MiB replay per terminal, 4 MiB queued or
  unacknowledged events per attachment, and a 256 KiB ACK window. The desktop
  runner starts any number of terminals; a standalone runner (`startServer` and the
  CLI) allows 32 at once. Either keeps at most 32 exited, unattached records and
  evicts the oldest beyond that, or sooner when a capped runner needs room. Headless
  screens keep 1,000 scrollback lines. Replay is bounded recent history; the saved
  transcript is separate and capped at 256 KiB per terminal.
- Initial snapshots have a separate 32 MiB allowance. Older scrollback is omitted
  if needed to fit that budget; the visible screen is never silently truncated.
  A pathological visible screen that still exceeds it fails with
  `SNAPSHOT_TOO_LARGE`, not a retryable slow-viewer error. Recovery then requires
  reducing the screen contents outside that failed attachment or restarting the
  terminal. Snapshot chunking is not implemented in this version.
- A viewer exceeding its budget receives `SLOW_CONSUMER` and must attach again.
  The process keeps running. Dead connections are detected by 30-second ping/pong
  heartbeats, normally within two intervals. Slow viewers do not block the runner
  from draining output or accepting another connection's input.
- Runner shutdown ends owned PTYs. Backend restarts preserve project and session
  metadata, including saved session state, and what restores each terminal (see
  [Shell integration and restoring terminals](#shell-integration-and-restoring-terminals)),
  but not processes, live terminal records, or replay cursors. There is no persistent
  process supervisor.
- `terminals.close({ terminalId })`, or `runner.terminals.close(id)` without an
  attachment, succeeds for the controlling connection or when no connection holds
  control, and rejects with `CONTROL_IN_USE` otherwise. Once the shell has exited, the
  runner forgets the terminal: `list` omits it, watchers receive `removed`, and later
  calls report `TERMINAL_NOT_FOUND`. Attached viewers still receive `exited` first. A
  shell that exits on its own keeps its record until eviction.
- `terminals.restart({ terminalId, cols, rows, resume? })`, or
  `runner.terminals.restart(id, { cols, rows, resume })`, starts a fresh shell in a
  retained exited terminal: the same ID and session, in the shell's last reported
  directory (or where it started, once that is gone), with a new screen that shows the
  earlier one above a separator while transcripts are on. With `resume`, the fresh
  shell resumes that agent's session instead, as for `create`, and then the earlier
  screen is not shown. The
  same control rule as closing applies, and the caller then holds control. The
  summary's `run` counts shells, 1 at creation and one more per restart, so a client
  can discard a late report about an earlier run. Watchers receive `changed`;
  viewers attach again and get the new screen as a snapshot, even with a cursor from
  the previous run. A running terminal rejects with `CONFLICT`, and a shell that
  cannot start rejects with `SPAWN_FAILED`, leaving the terminal exited.
- Closing sends a hangup to the owned shell, escalating if the shell ignores it.
  It is not a process-tree kill guarantee: daemonized jobs and descendants that
  ignore hangup may continue, as with an ordinary terminal emulator. Use an OS
  service/cgroup or a future supervisor if all descendant cleanup is required.

## Shell integration and restoring terminals

A runner given a shell folder (`RunnerOptions.shell`; the CLI and the desktop app use
one beside `workspace.sqlite`) writes these files into it on start, each only when it
changed. Only connecting an agent (below) installs anything elsewhere:

- `bash/`, `zsh/`, `fish/` and `powershell/` scripts, and for cmd a `PROMPT`, that load
  the user's own startup files first and then report the directory at each prompt with
  OSC 7 (`file://host/path`, percent-encoded) or OSC 9;9 (the path). The runner parses
  both in its headless screen. A report naming another machine, as from a shell over
  SSH, is not the shell's prompt.
- `plugins/claude` and `plugins/codex`, a local marketplace holding the `novadeck`
  plugin for each, and `plugins/agy/novadeck`, the plugin for Antigravity. Each holds
  one hook: Claude Code's and Codex's `SessionStart`, Antigravity's `PreInvocation`. Its
  command does nothing where `NOVADECK_HOOK` is unset, that is outside NovaDeck's
  shells, and otherwise runs `"$NOVADECK_HOOK" <agent>` (see `hookCommand` for the
  exact, frozen strings: Codex and Antigravity trust a hook by its definition). On
  Windows, Claude Code's hook runs in PowerShell and the others in cmd.
- `bin/codex` (`codex.cmd`), which shells get first on `PATH`, with `NOVADECK_BIN`,
  while Codex is connected: it runs the next `codex` on `PATH` with `--no-daemon`, since
  interactive Codex otherwise runs sessions and their hooks in a shared background
  server without the terminal's environment. It leaves `codex agents`, `--remote` and
  runs outside NovaDeck's shells unchanged. The integration puts `NOVADECK_BIN` back in
  front after the user's startup files.
- `hook` (`hook.cmd`), a launcher that runs `hook.mjs` on the runner's own runtime
  (Electron with `ELECTRON_RUN_AS_NODE=1`, or Node), so the hook needs no bash or
  python3. It reads the agent's payload (`session_id`, or Antigravity's
  `conversationId`), drops Claude Code subagents (`agent_id`), Claude Code inside Cursor
  (`cursor_version`, `CURSOR_VERSION`) and a Codex started by another Codex
  (`CODEX_THREAD_ID` other than the session), prints nothing but the `{}` Antigravity
  expects, and reports within two seconds or gives up.

Each shell the runner starts gets `NOVADECK_TERMINAL_ID`, and with the integration
`NOVADECK_HOOK`, and `NOVADECK_REPORT` and `NOVADECK_REPORT_TOKEN`:
a Unix socket in a private temporary directory, or a named pipe on Windows, and a random
token for that shell. The endpoint takes one JSON line,
`{ terminalId, token, agent, sessionId, source, seq }`, and nothing else: it records the
agent's session for the terminal whose token matches, keeping the report with the
largest `seq` (the hook's start time) per agent, so `/clear`, a fork, or another agent
run in between never replaces a later session with an earlier one. Processes that only
inherited a shell's environment report too, so the runner ignores a report while the
shell itself holds the foreground (Linux and macOS tell; as from a tmux server or an
editor started there and running elsewhere), on Windows one made before a line was
entered since the last prompt, and a new `startup` session while another agent session
holds the foreground (an agent run by that agent). A session switch such as `/clear`
reports its own source and is kept, as is a new conversation of the same agent reported
without a source (Antigravity).

The runner saves, per terminal, in a `terminals` table next to the sessions: its
session, last directory, latest session per agent, when it last showed a prompt, and
its transcript (the serialized screen and scrollback, without the alternate screen,
capped at 256 KiB), keeping the 128 most recently saved. The directory and agent
sessions are saved as they change, the rest every five seconds when changed, when a
shell exits, and on `persist()` and `close()`, which save before any shell ends.
Closing a terminal forgets it, including one from an earlier runner (`terminals.close`
still rejects with `TERMINAL_NOT_FOUND` then).

- `terminals.create({ …, restore: true, resume? })` continues the saved terminal of
  that ID in the same session: in its last directory when that still exists, with its
  agent sessions, showing its transcript above a separator before the shell's output.
  `resume` names the agent (`claude`, `codex` or `agy`) that ran there. While it is
  connected, the runner builds the command that resumes the session it last reported
  in this terminal (`claude --resume <id>`, `codex resume <id>`,
  `agy --conversation <id>`) and the fresh shell runs it once as it starts, and then no
  transcript is shown. The runner writes the command to a file of its own, readable
  by the user only, and gives its path to the shell in `NOVADECK_RESUME`. The
  integration unsets the variable, reads and removes the file, and runs the command:
  bash, zsh and fish at the first prompt, after the user's startup files and prompt
  hooks, reporting that prompt once the agent exits; PowerShell after its profile.
  cmd gets the command with `/k`. Nothing is typed, so it never lands in the history
  or in a running program. Input the client writes before the shell took the command,
  other than the terminal's own replies such as focus reports, removes the file and so
  cancels the resume; the shell gets that input instead. The runner resumes nothing, and shows the transcript, for an agent not
  connected (disconnecting also forgets every session it reported), a terminal where
  the agent reported no session, a session another terminal is running or resumed and
  has not closed, and a shell without the integration.
- `agents.list()` answers, for `claude`, `codex` and `agy`, whether the agent is
  installed where the runner runs (its home: `CLAUDE_CONFIG_DIR` or `~/.claude`,
  `CODEX_HOME` or `~/.codex`, `~/.gemini/antigravity-cli`) and whether NovaDeck's plugin
  is installed into it, read from the agent's own configuration.
  `agents.set({ agent, connected })` installs or removes the plugin with the agent's
  own commands (`claude plugin marketplace add` + `plugin install`, `codex plugin
marketplace add` + `plugin add`, `agy plugin install`, and their removals). They run
  directly, with `PATH`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` as the user's login shell
  has them (read with `$SHELL -ilc 'echo …; env'`, in the background so listing never
  waits), falling back to `~/.claude/local/claude` for Claude Code's local install; on
  Windows they run through cmd. It answers where the agent stands after, or rejects with
  `AGENT_SETUP_FAILED` saying why.
- `agents.detail({ terminalId })` streams what the agent in a terminal does, beyond its
  summary: a snapshot on subscribing, then another on each change (a reader that falls
  behind gets only the newest, and never one equal to the last it read). A snapshot names
  the agent and its session, its activity and telemetry as in the summary, its actors
  (the root first, then each subagent with its kind; a subagent's parent is null, as no
  harness says which agent started a nested one; a subagent seen only through its requests is listed without a kind), each request waiting on the person
  (its kind, tool, the actor asking, what it asks about: a command, a path, a question
  and its answers, or a plan's file), and how much of each feature the agent's harness
  tells (`unsupported`, `partial`, `complete`). Actors and requests have runner-issued
  refs, never a harness's own ids; the summary's subagents use the same refs. Without an
  agent bound, only `terminalId` is set. The stream follows the terminal from agent to
  agent and ends when the terminal is closed; an unknown one is `TERMINAL_NOT_FOUND`.
  The client's `agents.detail(terminalId)` resubscribes across reconnections and ends
  once the terminal is gone.
- `agents.transcript({ terminalId, actor })` streams an actor's conversation, by the ref
  `agents.detail` names it by, as its harness recorded it: batches of up to 256 items
  from the start of the record, then each one appended, and `reset` when the record was
  rewritten (the items follow again from the start). An item is the person's or the
  agent's text, a tool call with its input as text, or a tool's result, numbered from
  the record's start, with when it was written; `call` pairs a result with its call by a
  runner-issued ref. Text past 16 KiB is cut short and marked `truncated`, and reasoning
  never appears. It reads Claude Code's session transcript and its per-subagent ones,
  and Codex's rollouts (a subagent's found on its parent's day or up to a week later),
  without the context either harness writes in the person's place, their developer or
  meta records, or the messages Codex's agents send each other; Antigravity's is not
  read. The runner reads no further ahead than it has sent, but a remote client's own
  pace is not tracked: a large record on a slow link fills the socket's buffer like any
  other output.
  An actor the terminal's session does not have, or without a transcript NovaDeck reads,
  is `NOT_FOUND`; the stream ends when the terminal's agent leaves that session. The
  client's `agents.transcript(terminalId, actor)` resubscribes across reconnections,
  yielding `reset` before the items follow again, and ends without one when the actor
  is gone.
- `agents.detail` snapshots also list each actor's latest plan (`plans`: its ref, the
  actor's ref, whether it is a file or presented text, and the file's name). Claude Code's
  plans are the Markdown files plan mode writes in a `plans` folder, and what
  `ExitPlanMode` presents: the file Claude Code names, wherever its plans folder is set,
  or the plan's text, each presentation its own plan. Codex's and Antigravity's are not
  read yet.
  `agents.plan({ terminalId, plan })` streams one: its text as it stands (cut short past
  256 KiB, marked `truncated`) with when its file last changed, then again on each
  change. Only a plain Markdown file that one of those names is ever read. A plan no longer an
  actor's latest is `NOT_FOUND`; the stream ends once another replaces it or the agent
  leaves its session. The client's `agents.plan(terminalId, plan)` follows it across
  reconnections.
- `settings.get()` and `settings.set({ transcripts?, welcomed? })` read and change
  whether transcripts are kept (unless turned off; turning them off forgets every saved
  transcript) and whether the person has seen the first-run choice of agents.

Typed errors include `UNAUTHORIZED`, `INCOMPATIBLE_PROTOCOL`, `CONFLICT`,
`INVALID_DIRECTORY`, `TERMINAL_NOT_FOUND`, `CONTROL_REQUIRED`, `CONTROL_IN_USE`,
`INVALID_CURSOR`, `RESOURCE_LIMIT` (too many calls in flight; retry later),
`TERMINAL_LIMIT` (the runner's terminal cap is reached), and `SLOW_CONSUMER`. The
schemas and contract in
`application/protocol/src/` are the authoritative API definition.
