# Backend API

This is the first backend-only implementation of the [terminal plan](backend-plan.md).
The Electron host runs the runner and hands its window a port to it; the UI itself
still uses sample data and does not connect yet.

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
Beta.14 retains the older [delayed-worker startup deadlock risk](https://github.com/microsoft/node-pty/pull/943),
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
SIGTERM test. Packaged Electron builds and remote TLS deployment remain verification
gates before integration.

Without a token, the runner exposes only the existing HTTP status behavior.
With a token, the RPC WebSocket endpoint is `/api/rpc`. The CLI persists metadata
at `~/.local/share/novadeck/workspace.sqlite` unless `NOVADECK_DATABASE` is set.
Programmatic `startServer` from `@novadeck/runner/server` and `createRunner` use
an in-memory database when no path is supplied. `@novadeck/runner/http` stays free of
native terminal code, so the Electron main process can serve the status endpoint without it.

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
const project = await runner.projects.create({ name: "My project", cwd: "/work/project" })
const session = await runner.sessions.create({ projectId: project.id, name: "Development" })
const { id } = await runner.terminals.create({ sessionId: session.id, cols: 120, rows: 30 })

const terminal = await runner.terminals.attach(id)
for await (const event of terminal) render(event) // snapshot, output, resized, exited

// Independent of reading, typically from keyboard and layout handlers:
await terminal.write("pwd\r")
await terminal.resize({ cols: 100, rows: 32 })
await terminal.close() // ends the shell; iteration then finishes after `exited`
await terminal.detach() // or `break` out of the loop; the shell keeps running
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
reconnection, asks for a fresh port. If the runner process dies, the host starts a
new one on the next request; shells end with it, and metadata remains. Quitting the
app ends the runner's shells before exiting.

### Wire contract

`@novadeck/protocol` contains runtime-validated Zod schemas, the oRPC contract, and
inferred TypeScript types. The runner implements that contract; it does not expose
arbitrary event-name handlers. oRPC is pinned to 1.15.4: its installed API uses
`eventIterator` and the server's `ws` and `message-port` adapters. The client keeps
oRPC's standard wire protocol over a small channel adapter that settles pending
calls when a socket or port closes. `@novadeck/protocol/wire` exposes the raw
`WireClient` for protocol tests. Applications use `connectRunner`.

Every connection starts with `runner.handshake({ protocolVersion, token })`, which
returns `runnerId`, the protocol version, and capabilities. WebSocket connections
require the token in the handshake, never in a URL, and time out after ten seconds
without it. MessagePort connections omit it. Each `terminals.attach` stream begins
with an unsequenced `attached` marker confirming the granted mode, followed by
sequenced terminal events.

`terminals.list({ sessionId })` discovers live and retained exited terminals.
Creation uses the project's directory unless `cwd` is supplied. Directories must
exist and be absolute. The server chooses the shell; clients send terminal input,
not executable configuration. `write` accepts control characters, including
Ctrl-C (`\u0003`). A successful write means accepted input, not command completion.

## Stream and lifetime rules

- Creation grants the creating connection control. Only that connection can
  write, resize, or close. Another connection can attach with `mode: "observe"`.
  There is one attachment per terminal per connection. Cancelling a controlling
  attachment or disconnecting releases control, but leaves the shell running.
- Events carry `terminalId` and an increasing `sequence`. Initial attachment emits
  a serialized screen snapshot with dimensions and running/exited state. Output,
  resize, and exit events follow in order. A snapshot replaces the old screen; it
  is not appended. ACK snapshots too, including sequence zero.
- Reconnect with a new socket/client and handshake. Attach using `afterSequence`
  from the last fully applied event. Available history is replayed; an expired
  cursor falls back to a fresh snapshot. A future cursor is rejected. Scope saved
  cursors to both runner identity and terminal ID. `connectRunner` does this for
  its attachments; raw wire clients must do it themselves.
- Default limits are 32 connections and 32 retained terminals, 64 KiB incoming
  WebSocket messages, 16,384 characters per input call, 1 MiB replay per terminal,
  4 MiB queued/unacknowledged events per attachment, and a 256 KiB ACK window.
  Old exited, unattached records are evicted when capacity is needed. Headless
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
- Runner shutdown ends owned PTYs. Backend restarts preserve only project/session
  metadata, not processes, terminal records, screens, or replay cursors. There is
  no persistent process supervisor, layout storage, or terminal configuration
  persistence in this slice.
- Closing sends a hangup to the owned shell, escalating if the shell ignores it.
  It is not a process-tree kill guarantee: daemonized jobs and descendants that
  ignore hangup may continue, as with an ordinary terminal emulator. Use an OS
  service/cgroup or a future supervisor if all descendant cleanup is required.

Typed errors include `UNAUTHORIZED`, `INCOMPATIBLE_PROTOCOL`, `INVALID_DIRECTORY`,
`TERMINAL_NOT_FOUND`, `CONTROL_REQUIRED`, `CONTROL_IN_USE`, `INVALID_CURSOR`,
`RESOURCE_LIMIT`, and `SLOW_CONSUMER`. The schemas and contract in
`application/protocol/src/` are the authoritative API definition.
