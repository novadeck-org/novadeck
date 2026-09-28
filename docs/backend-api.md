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
at `~/.local/share/novadeck/workspace.sqlite` unless `NOVADECK_DATABASE` is set.
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
`RUNTIME_CLOSING`, so shells ending on the way out cannot overwrite the last state.

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
no foreground process is known.

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
the window close or the app end the runner's shells and exit.

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
  screens keep 1,000 scrollback lines. These are bounded recent history, not a
  durable transcript.
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
- Runner shutdown ends owned PTYs. Backend restarts preserve only project and
  session metadata, including saved session state, not processes, terminal records,
  screens, or replay cursors. There is no persistent process supervisor or terminal
  configuration persistence in this slice.
- `terminals.close({ terminalId })`, or `runner.terminals.close(id)` without an
  attachment, succeeds for the controlling connection or when no connection holds
  control, and rejects with `CONTROL_IN_USE` otherwise. Once the shell has exited, the
  runner forgets the terminal: `list` omits it, watchers receive `removed`, and later
  calls report `TERMINAL_NOT_FOUND`. Attached viewers still receive `exited` first. A
  shell that exits on its own keeps its record until eviction.
- `terminals.restart({ terminalId, cols, rows })`, or
  `runner.terminals.restart(id, { cols, rows })`, starts a fresh shell in a retained
  exited terminal: the same ID, session, and directory, with a new screen. The
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

Typed errors include `UNAUTHORIZED`, `INCOMPATIBLE_PROTOCOL`, `CONFLICT`,
`INVALID_DIRECTORY`, `TERMINAL_NOT_FOUND`, `CONTROL_REQUIRED`, `CONTROL_IN_USE`,
`INVALID_CURSOR`, `RESOURCE_LIMIT` (too many calls in flight; retry later),
`TERMINAL_LIMIT` (the runner's terminal cap is reached), and `SLOW_CONSUMER`. The
schemas and contract in
`application/protocol/src/` are the authoritative API definition.
