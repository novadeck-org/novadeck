# Backend API

This describes the runner behind the [terminal plan](backend-plan.md) and how the UI
uses it. The Electron host runs the runner and hands its window a port to it; the UI
connects through that port, or in a browser over a WebSocket, with the runner adapter
in `application/ui/src/backend/runner/`.

## Run and test

Use the repository's Node.js 26 and pnpm versions, and Rust (rustup), which builds the
relay. `node-pty` is a native dependency;
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
folder beside it, with its own copy of the relay agents start for Novadeck's MCP server and hooks.
The build compiles the relay, on Linux linked statically, so the binary runs on any
distribution, x64 or ARM64; set `NOVADECK_RELAY` to use another build. Without it, shells and hooks still work, and
agents there start without Novadeck's tools.
Programmatic `startServer` from `@novadeck/runner/server` and `createRunner` use
an in-memory database when no path is supplied. `@novadeck/runner/http` stays free
of native terminal code, so the Electron main process can serve the status endpoint
without it.

For a VPS, terminate TLS at a trusted reverse proxy and forward WebSocket upgrades.
Agents run beside the runner on the server, and their relays reach it over a private
local socket, so a UI elsewhere needs nothing more than the WebSocket.
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

// Bundled in the Novadeck desktop app: a port from the host to its runner process.
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
`projects.remove({ projectId })` closes every terminal of the project's sessions,
running or kept only as saved, whichever connection controls them, so watchers see
each `removed`; then it deletes the project, its sessions and what the runner kept of
their terminals, their companion items and undocked windows (`companions.watch` reports
each `itemRemoved` and `windowRemoved`, and their `content` streams end), and its agents'
messages. Its folder on disk stays. Terminals being
created in the project as it begins finish first and close with the rest; while it
goes, `projects.list` leaves it out, creating a session or terminal in it rejects
with `NOT_FOUND`, and restarting one of its terminals with `TERMINAL_NOT_FOUND`. A
second call while it goes shares the first, and one after it, like one for a project
the runner never had, rejects with `NOT_FOUND`. A runner that shuts down before the
removal is done rejects it with `RUNTIME_CLOSING` and keeps the project, for a client to
remove again from the next runner.
`sessions.save({ sessionId, state })` replaces a session's `state`, a string the
runner stores with the session without reading it, such as a UI layout. It holds only
how a client shows the session's terminals, by id: the terminals themselves, their
titles, directories and what they ran, are the runner's own records. Sessions
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
changes as they happen: creation, title, size, exit, and the foreground process,
sampled about once a second. Every terminal the runner keeps is reported, including one
it keeps only as saved, as after it restarted, with `started: false` and no shell until
a client restores it; an exited record it lets go is reported again that way. `removed`
reports a closed terminal only. A consumer clears its set of reported terminals on
`reset` and, at `synced`, forgets every terminal outside it.
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
shell last reported at a prompt, or where it started. `title` is, in this order: the
name the person gave the terminal with `create` or `terminals.rename({ terminalId,
title })`; the one an agent gave it last (`describe`, or `open_terminal`'s `title`);
the person's first prompt of its agent's root session, shortened; or the runner's
default for its session ("Terminal 01", "Terminal 02", …, never given twice).
`titleSource` says which: `{ kind: "person" }`, `{ kind: "agent", by: "t2" }`,
`{ kind: "fallback" }` or `{ kind: "default" }`. A terminal the client creates for an
agent's request (`terminals.requests`) passes that request's `requestId` to
`terminals.create`, and takes the title the agent asked for as the agent's.
`terminals.resetTitle({ terminalId })` takes the person's name away, so it is automatic
again (see [Agent messaging](agent-messaging.md#self-description)). `handle` is its
handle for agents' messages, `t3`, numbered from the same counter, so "Terminal 03" is
`t3`; every terminal takes a number, even one created with its own title, and keeps
its handle across renames. `command` is what it was opened to run, and
`lastProgram` the program it last had in its foreground, which a fresh shell resumes
where that is an agent.

`runner.terminals.upload(terminalId, { name, data })` saves a file pasted into a
terminal on the runner's machine and resolves with its absolute path there, for the UI
to paste into the terminal. The desktop app, whose runner is on its own machine, pastes
a file copied in a file manager by its own path instead, through the host's
`pathForFile`, and uploads only what has none, or a Windows name it can't paste safely. The runner keeps each file in a folder of its own under its
`uploads` option (beside the database for the standalone and desktop runners, a fresh
temporary folder otherwise), readable by its owner only, and removes uploads older than
a week as the next one starts. The client sends the file base64 in parts that each fit
a WebSocket message: on the wire, `terminals.upload({ terminalId, name, data })` starts
it and answers `{ path }`, and `terminals.upload({ terminalId, path, data })` adds the
next part within a minute. A file past `maxUploadBytes` (32 MiB) is
`UPLOAD_TOO_LARGE`, a `path` the runner isn't receiving `NOT_FOUND`, and an unknown
terminal `TERMINAL_NOT_FOUND`.

Agents in a project's terminals message each other (see
[Agent messaging](agent-messaging.md)); the runner API lets a client see and steer it:

```ts
const messages = await runner.messages.list(terminalId)
// { terminalId, handle, delivery, paused, threads: [{ id, peer, hops, allowed, held, messages }] }
await runner.messages.pause(true) // or false to resume
await runner.messages.release(threadId) // a thread held after too many hops
for await (const listing of runner.messages.watch(terminalId)) show(listing) // as it changes
```

`messages.list(terminalId)` gives a running or exited terminal's handle, its delivery
state (`unbound`, `fresh`, `working`, `settled`, `ringing`, `drafting` or `unknown`), whether
messaging is paused, and its threads, newest first, each with the other terminal's
handle, its hops so far and the hops it is allowed before the person must release it,
whether it is held, and its messages, oldest first: id, hop, sender and recipient
handles and agents, text, when sent, state (`queued`, `leased`, `delivered`, `held` or
`gone`), why it is held (`paused` or `release`), and when delivered. A terminal the
runner doesn't hold is `TERMINAL_NOT_FOUND`. `messages.pause(paused)` pauses messaging
across the whole runner, every project and session, keeping the switch across
restarts: waiting messages are held, and wait in order again once resumed.
`messages.release(threadId)` lets a held thread's messages wait to be delivered and
allows it 12 more hops; an unknown thread is `NOT_FOUND`. Each refuses with
`RUNTIME_CLOSING` once the runner is stopping. `messages.watch(terminalId)` streams what
`list` says, then again on each change to the terminal's threads, messages or delivery
state, and on each pause or resume, a burst of changes within one tick as one listing;
a reader that falls behind gets only the newest listing, never one equal to the last it
read. A watch's listing may come before or after the `pause` or `release` call that
changed it answers. It ends when the terminal is closed or let
go; an unknown one is `TERMINAL_NOT_FOUND`. The client's `messages.watch(terminalId)`
resubscribes across reconnections and ends once the terminal is gone.

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

`terminals.list({ sessionId })` lists every terminal of the session, oldest first:
live, retained exited, and kept only as saved; `terminals.watch()` streams them all as
they change. Each watch belongs to its
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
  shell that exits on its own keeps its record until eviction, and the terminal itself
  until it is closed. A terminal kept only as saved closes the same way.
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
  command does nothing where `NOVADECK_HOOK` is unset, that is outside Novadeck's
  shells, and otherwise runs `"$NOVADECK_HOOK" <agent>` (see `hookCommand` for the
  exact, frozen strings: Codex and Antigravity trust a hook by its definition). On
  Windows, Claude Code's hook runs in PowerShell and the others in cmd.
- `bin/codex` (`codex.cmd`), which shells get first on `PATH`, with `NOVADECK_BIN`,
  while Codex is connected: it runs the next `codex` on `PATH` with `--no-daemon`, since
  interactive Codex otherwise runs sessions and their hooks in a shared background
  server without the terminal's environment. It leaves `codex agents`, `--remote` and
  runs outside Novadeck's shells unchanged. The integration puts `NOVADECK_BIN` back in
  front after the user's startup files.
- `hook` (`hook.cmd`), a launcher that starts Novadeck's relay (`novadeck-relay`, a
  small native program copied in beside it; see `application/relay`), so the hook needs
  no bash, python3 or JavaScript runtime and starts in about a millisecond. The relay
  sends the agent's payload, unread, with when it started and the processes it runs
  under, and prints what the runner answers. The runner reads the payload (`session_id`, or Antigravity's
  `conversationId`), drops Claude Code subagents (`agent_id`), Claude Code inside Cursor
  (`cursor_version`, `CURSOR_VERSION`) and a Codex started by another Codex
  (`CODEX_THREAD_ID` other than the session), prints nothing but the `{}` Antigravity
  expects, and reports within two seconds or gives up.

Each shell the runner starts gets `NOVADECK_TERMINAL_ID`, and with the integration
`NOVADECK_HOOK` (and on Linux and macOS `NOVADECK_MCP`, the runner's own MCP launcher),
and `NOVADECK_REPORT` and `NOVADECK_REPORT_TOKEN`:
a Unix socket in a private temporary directory, or a named pipe on Windows, and a random
token for that shell. Agents' hooks and Novadeck's MCP server reach it through the
relay, as the [relay protocol](#relay-protocol) below describes. From each hook's report
the runner records the agent's session for the terminal whose token matches, keeping the
report with the largest `seq` (the hook's start time) per agent, so `/clear`, a fork, or another agent
run in between never replaces a later session with an earlier one. Processes that only
inherited a shell's environment report too, so the runner ignores a report while the
shell itself holds the foreground (Linux and macOS tell; as from a tmux server or an
editor started there and running elsewhere), on Windows one made before a line was
entered since the last prompt, and a new `startup` session while another agent session
holds the foreground (an agent run by that agent). A session switch such as `/clear`
reports its own source and is kept, as is a new conversation of the same agent reported
without a source (Antigravity).

### Relay protocol

The relay (`application/relay`) and the runner's endpoint (`shell/reports.ts`) speak
JSON, one message per line, over `NOVADECK_REPORT`. The endpoint speaks only this
protocol. A relay's first line starts `{"relay":<version>,`, currently 2, and names what
the connection carries; the endpoint ends a connection whose first line is anything else,
or a version it doesn't speak, without an answer, and logs that once.

**Versions.** An agent's plugin starts the relay of whichever install connected it last,
on Windows or outside Novadeck's terminals (on Linux and macOS a terminal's agents start
its own runner's relay, through `NOVADECK_MCP`), as the desktop app and a standalone
runner can share a machine, so a runner can meet an older or newer relay than its own. When the protocol changes incompatibly, the version
goes up, and the runner keeps taking the one before for a release (`relayVersions`).
That holds from version 2, the relay's first: the scripts agents ran before it, on
Novadeck's own runtime, aren't served, so an agent connected by an install from before
the relay gets Novadeck's tools once it is connected again.
`novadeck-relay --version` names a copy's crate version and protocol.

**MCP session**, started by the `mcp` launcher (on Windows, by the plugin itself) as
`novadeck-relay mcp <plugin version> <MCP versions, newest first>`:

1. The relay sends `{"relay":2,"kind":"mcp","terminalId":…,"token":…}`.
2. The runner takes the session with `{"relay":2,"ok":true}`, in the relay's version.
   Until then the relay reads nothing of the agent's, so when the runner refuses it, or
   doesn't take it within 8 s, as a busy runner may not, within the 10 s an agent gives a
   server to start, or can't be reached, the relay answers the whole session itself, with
   no tools, and says why on stderr, which agents keep in their logs.
3. Then it carries the agent's JSON-RPC lines to the runner unchanged, and the runner's
   answers back, each as soon as it is ready. The runner serves the MCP server itself
   (`shell/mcp.ts`), and checks the token on every tool call. A token that can't be a
   runner's gets the handshake with no tools.
4. When the agent closes its input, the relay sends `{"relay":"eof"}` on a line of its
   own, rather than half-closing, which Windows' pipes can't. The runner answers what is
   under way, then closes, and the relay exits.

A line over 1 MiB is answered with error `-32600`, carrying the id that closes the line
or else the first its start names, and skipped; the session goes on. Outside Novadeck's
terminals the relay answers by itself: `initialize`, `ping`, an empty `tools/list`, and
`-32602` for any tool.

**Hook**, run by the `hook` launcher as `novadeck-relay hook --config <relay.json> <agent>
[event]`. `relay.json`, which the runner writes beside the relay, holds what the relay
knows of the agents: the events that ask, by agent; the variables it forwards; and what
each agent prints without Novadeck, by event and for any other (`*`), from each harness's
`messaging.silent`. Options come before the agent, as `--name value`, and every option
takes a value: a relay passes over the options it doesn't know, so a later launcher's
work with it, and an option without a value would be read as the agent.

1. The relay reads the agent's payload, up to 1,000,000 bytes, and sends
   `{"relay":2,"kind":"hook","terminalId","token","agent","event","seq","deadline","ancestors","env","payload"}`.
   - `seq` is when the hook started, and `deadline` when it gives up, in epoch
     milliseconds with a fraction.
   - `ancestors` is up to eight `{ pid, name }`, nearest first. They come from `/proc`
     on Linux and the kernel on macOS, named by the path each was started by; Windows
     sends none.
   - `env` holds the variables `relay.json` names, by name, as the hook found them:
     `CLAUDE_PID`, `CURSOR_VERSION` and `CODEX_THREAD_ID`.
   - `payload` is the agent's JSON as text, unread. The runner prunes it.
2. The runner answers one line, `{"stdout": string | null, "leaseId": string | null}`: a
   report at once, an ask by the relay's deadline (at most four seconds after `seq`),
   leaving half a second to print and acknowledge.
3. The relay prints `stdout`, or else what `relay.json` says the agent needs without
   Novadeck (Antigravity's `{"decision":"ask"}` before a tool, `{}` otherwise). When a
   lease came and printing succeeded, it sends `{"ack":"<leaseId>"}` on the same
   connection.

A hook gives up two seconds after it starts when it reports, four when it asks, and five
for Claude Code's status line. For the status line, the relay also runs the person's own
command, as their Claude Code settings name it, beside the report, and prints it. Without
the relay, the hook launcher prints what `relay.json` would, as it is written from the
same tables.

The runner saves, per terminal, in a `terminals` table next to the sessions: its
session, last directory, latest session per agent, when it last showed a prompt, and
its transcript (the serialized screen and scrollback, without the alternate screen,
capped at 256 KiB), its title, the command it was opened with and the program it last
had in its foreground, until it is closed. The directory, agent sessions and title are
saved as they change, the rest every five seconds when changed, when a shell exits, and
on `persist()` and `close()`, which save before any shell ends. Closing a terminal
forgets it, including one from an earlier runner.

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
  `CODEX_HOME` or `~/.codex`, `~/.gemini/antigravity-cli`) and whether Novadeck's plugin
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
  from the start of the record in the order the harness wrote them (Antigravity may
  write a tool's result before its call; `call` pairs them), then each one appended,
  and `reset` when the record was
  rewritten (the items follow again from the start). An item is the person's or the
  agent's text, a tool call with its input as text, or a tool's result, numbered from
  the record's start, with when it was written; `call` pairs a result with its call by a
  runner-issued ref. Text past 16 KiB is cut short and marked `truncated`, and reasoning
  never appears. It reads Claude Code's session transcript and its per-subagent ones,
  and Codex's rollouts (a subagent's found on its parent's day or up to a week later),
  without the context either harness writes in the person's place, their developer or
  meta records, and Antigravity's (the step log its hooks name: the person's request
  without the context wrapped around it, the agent's words, each tool call and its
  result, never its reasoning or system steps). A Codex agent's transcript also holds
  the messages other agents sent it, as role `agent` with `author` naming the sender's
  path (`/root`, `/root/<name>`). The runner reads no further ahead than it has sent, but a remote client's own
  pace is not tracked: a large record on a slow link fills the socket's buffer like any
  other output.
  An actor the terminal's session does not have, or without a transcript Novadeck reads,
  is `NOT_FOUND`; the stream ends when the terminal's agent leaves that session. The
  client's `agents.transcript(terminalId, actor)` resubscribes across reconnections,
  yielding `reset` before the items follow again, and ends without one when the actor
  is gone.
- `companions.*` keeps what agents show and the person attaches beside terminals: items,
  each a pointer to a file, a page or a plan, never a copy of it, held by exactly one
  terminal's bar or one undocked window. Items and windows live in the runner's database,
  so they survive restarts; an item goes when it is closed, with the terminal whose bar
  holds it, or with its session, and a window goes with its item. Nothing caps how many
  there are. An item has a runner-issued id, its `kind` (`image`, `file`, `page`,
  `plan`), a name and a one-line `detail`, its `path` or `url`, the `lines` it points at,
  `held` for a file that may hold secrets, `by` (`agent` or `person`), `from` (the
  terminal and handle it was shown in), `version` (counts its shows), `asked` (the latest
  show asked to open it), `shownAt`, and for a plan its agent, its actor's role and
  whether it is a file or text.
  - `companions.list({ sessionId })` answers a session's `items` and `windows`; an unknown
    session is `NOT_FOUND`.
  - `companions.watch()` streams every item and window across sessions, `synced`, then
    each change: `item`, `itemRemoved`, `window`, `windowRemoved`. What comes before
    `synced` is a set, applied whole at `synced`, as `terminals.watch` does. After it,
    each change is the latest state of its item or window, coalesced in place for a slow
    reader, in the order they first changed since the reader caught up. So a reference (an
    item's holder window, a window's item, an item's terminal) may name one not yet
    reported, or one whose removal follows; they agree once the stream is idle. A client
    keeps both sides and resolves them as the rest arrives, never dropping one for it.
    The client's `companions.watch()` yields `reset` before each fresh sequence, as
    `terminals.watch()` does.
  - `companions.content({ itemId, reveal? })` streams what an item points at, read from
    disk now and again each time it changes, until the item is deleted; an unknown item
    is `NOT_FOUND`. It is `ready`, with a `stamp` that changes with it, or `unavailable`
    with a reason and the file's size where known: `missing`, `unreadable`, `not-a-file`,
    `too-large` (an image over 8 MiB), `binary` (a NUL byte in its first 8 KiB), `held`
    (a file that may hold secrets, unless `reveal`), or `gone` (a plan no longer there).
    An image is a data URL; a page its address, which the desktop app loads live. A text
    file is the lines around those pointed at, read to the last of them and up to 4 MiB
    more to count the rest: `total` once it reached the file's end, else `truncated`;
    lines past the end are pulled back to it and marked `clamped`. A plan is its text, cut
    short past 256 KiB. Every read resolves symlinks again, refuses anything but a plain
    file and never blocks on a pipe, and a file that now resolves to one that may hold
    secrets is held.
  - `companions.attach({ terminalId, path, lines?, title? })` puts a file the person
    picked on a terminal's bar, by a path absolute or from the terminal's directory:
    `TERMINAL_NOT_FOUND`, or `INVALID_FILE` saying why for a missing path, a folder, a
    pipe or a device. Binary files are accepted.
  - `companions.move({ itemId, terminalId })` moves an item onto a bar of its session,
    from a bar or a window, which goes with it; an item that bar held under the same
    pointer is replaced. `NOT_FOUND`, `TERMINAL_NOT_FOUND`, or `CONFLICT` for another
    session's terminal. `companions.undock({ itemId, windowId })` moves it into a new
    window the client names (`CONFLICT` for a taken id). `companions.close({ itemId })`
    deletes it and its window. `companions.renameWindow({ windowId, title })` and
    `companions.resetWindowTitle({ windowId })` give a window the person's title or its
    item's name again.

  An agent shows things with Novadeck's MCP `show` tool, which puts each on its own
  terminal's bar; showing the same file or page there again updates it, with a later
  version, while one moved elsewhere is never touched. `showing` lists what its bar holds.
  Plans come from the agents' own records: Claude Code's are the Markdown files plan mode
  writes in a `plans` folder, and what `ExitPlanMode` presents (the file Claude Code
  names, or the plan's text); Codex's is the plan its Plan Mode proposes, as text;
  Antigravity's is the Markdown artifact it writes asking for review
  (`implementation_plan.md`). Each agent session's latest plan per actor is an item on
  the bar of the terminal it runs in, updated as it changes; a plan presented as text
  points at the transcript or rollout that records it, and is read back from there with
  the harness's own decoders, so it outlives its terminal. Only a plain Markdown file one
  of those names as a plan is ever read. When another agent session binds the terminal,
  the plans its bar mirrored of the earlier one go; moved ones stay.

- `settings.get()` and `settings.set({ transcripts?, welcomed? })` read and change
  whether transcripts are kept (unless turned off; turning them off forgets every saved
  transcript) and whether the person has seen the first-run choice of agents.

Typed errors include `UNAUTHORIZED`, `INCOMPATIBLE_PROTOCOL`, `CONFLICT`,
`INVALID_DIRECTORY`, `INVALID_FILE`, `NOT_FOUND`, `TERMINAL_NOT_FOUND`, `CONTROL_REQUIRED`, `CONTROL_IN_USE`,
`INVALID_CURSOR`, `UPLOAD_TOO_LARGE`, `RESOURCE_LIMIT` (too many calls in flight; retry later),
`TERMINAL_LIMIT` (the runner's terminal cap is reached), and `SLOW_CONSUMER`. The
schemas and contract in
`application/protocol/src/` are the authoritative API definition.
