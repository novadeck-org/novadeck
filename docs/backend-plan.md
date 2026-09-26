# Terminal backend plan

Build a personal, self-hosted terminal runner shared by Electron and the web UI.
The runner owns shell processes; clients connect, send input, and render output.
This is a proposed direction. The API examples describe the intended shape, with
exact schemas and implementation choices left for the first working slice.

The first backend-only slice is now implemented: shared contracts, authenticated
WebSocket RPC, real PTYs, replay, consumption ACKs, and SQLite projects/sessions.
The UI-facing `connectRunner` client wraps this wire API: attachments acknowledge,
resume, and resynchronize on their own, over WebSocket or a host MessagePort.
See [backend API](backend-api.md) for its setup and current contract. UI wiring,
Electron process integration, and deployment packaging remain separate work.

## Stack and boundaries

Keep TypeScript, Node.js, and Hono. Add oRPC with Zod contracts over WebSockets,
`node-pty` for shell processes, SQLite for workspace metadata, and xterm.js for
terminal rendering. Use headless xterm and serialization to restore screen state
after reconnecting.

| Part                                  | Responsibility                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `application/ui`                      | Workspace views, xterm rendering, and a typed runner client.                                 |
| `application/runner`                  | Authentication, oRPC procedures, PTY ownership, output retention, and persistence.           |
| `application/host`                    | Electron windows, desktop integration, and starting or connecting to a local runner process. |
| Proposed `@novadeck/protocol` package | Shared Zod schemas, procedure contracts, stream events, and typed errors.                    |

Keep the protocol package independent of Electron, React, and server implementation
code. Define input and output schemas explicitly, including streamed events.
[oRPC contracts](https://orpc.dev/docs/contract/procedure) provide the shared API;
its [WebSocket adapter](https://orpc.dev/docs/adapters/websocket) carries calls and
streams. Hono remains the HTTP host for authentication and health endpoints.

Run one backend process per machine under its owner's OS account. Electron uses
loopback HTTP/WebSockets; a separately hosted browser UI uses HTTPS/WSS to reach
the VPS runner. Both use the same contracts. A VPS runner controls shells on
that VPS; managing another machine later requires a connection to that machine.

## Proposed API

Use named procedures for commands and an async stream for terminal events.
Workspace sessions group terminals; they are distinct from shell processes and
network connections.

```ts
// Check compatibility before attaching or changing anything.
const runner = await client.runner.handshake({ protocolVersion: 1, token })
// Returns runner identity, negotiated protocol version, and capabilities.

const projects = await client.projects.list()
const sessions = await client.sessions.list({ projectId })
const terminals = await client.terminals.list({ sessionId })

const terminal = await client.terminals.create({
  sessionId,
  cwd,
  cols: 120,
  rows: 30,
})

await client.terminals.write({ terminalId: terminal.id, data })
await client.terminals.resize({ terminalId: terminal.id, cols, rows })
await client.terminals.close({ terminalId: terminal.id })
```

`write` sends terminal input, including control characters. It does not interpret
each message as a complete shell command. `close` explicitly terminates the shell;
hiding a terminal or changing views only changes its presentation.

Attach independently of input handling:

```ts
const events = await client.terminals.attach(
  { terminalId, afterSequence },
  { signal: controller.signal },
)

for await (const event of events) {
  // Apply the typed event to the terminal renderer and connection state.
  await client.terminals.ack({ terminalId, sequence: event.sequence })
}
```

An illustrative event contract:

```ts
type TerminalEvent = {
  terminalId: string
  sequence: number
} & (
  | {
      type: "snapshot"
      data: string
      cols: number
      rows: number
      status: "running" | "exited"
      exitCode: number | null
    }
  | { type: "output"; data: string }
  | { type: "resized"; cols: number; rows: number }
  | { type: "exited"; exitCode: number | null }
)
```

Derive this union from the shared Zod schemas. A snapshot contains serialized terminal
screen state; output contains subsequent terminal data. Batch output into chunks
instead of sending a procedure call per character. Procedures return typed errors
such as `TERMINAL_NOT_FOUND`, `TERMINAL_EXITED`, and `INCOMPATIBLE_PROTOCOL`.

Workspace creation, renaming, and layout persistence can follow the same contract
pattern as those features move out of mock state. Store connection profiles in
the client so one UI build can select "This computer" or "My VPS".

## Lifetime and delivery rules

- A terminal has a stable ID for its execution lifetime. UI unmounts, view changes,
  and connection loss leave its process running. Cancelling `attach` only releases
  that subscription.
- Initial attachment returns a snapshot followed by live events. Reattachment
  resumes after the last applied sequence when history is available; otherwise it
  returns a new snapshot. Establish the snapshot/replay checkpoint and live stream
  without gaps or duplicate application. Never reuse a cursor for a different
  runner or terminal execution.
- Keep draining PTY output when no client is attached. Bound retained history and
  each client's pending output. Add consumption acknowledgements and flow control;
  a slow or disconnected viewer must not cause unbounded memory growth.
- Serialize writes per terminal. Do not automatically retry keyboard input after
  an uncertain delivery. Retrying creation or input requires explicit request
  identities and deduplication. A successful write means input was accepted, not
  that a shell command completed.
- Give one attachment control of input and terminal dimensions at a time; other
  attachments can observe. This avoids two windows fighting over shell size.
- Check protocol compatibility on connection. Shared types do not guarantee that
  an older Electron build can communicate with a newer backend.

oRPC supplies validated streams and cancellation hooks. Replay storage, terminal
ownership, flow control, and retry policy remain runner responsibilities.
[oRPC streaming](https://orpc.dev/docs/async-iterator-object) and
[xterm flow control](https://xtermjs.org/docs/guides/flowcontrol/) are the relevant
implementation references.

## Persistence and deployment

SQLite stores projects, workspace sessions, terminal configuration, and saved
layouts. Live PTY handles and connections belong to the running backend. Retain
screen state and bounded output history in memory initially; saved metadata does
not imply that a shell survived a runner restart.

Run the local runner outside Electron's main process. Start with an
Electron-managed child process and a standalone VPS service. Guarantee recovery
from UI reloads and network interruptions while the runner remains alive.
Keeping local terminals alive after quitting Electron requires an independently
managed background runner. Surviving runner upgrades or crashes requires a
separate persistent PTY supervisor; leave that as a later capability.

Local access uses loopback binding and a capability supplied through the preload
bridge. Remote access requires authentication, HTTPS/WSS, and origin checks.
Authorize each terminal operation, bound message sizes and terminal counts, and
keep terminal contents out of ordinary request logs. CORS is configuration, not
authentication. Shells run with the runner owner's permissions.

## Implementation order

Current gate: implement and test the backend API without connecting either UI.
The following sequence remains the broader integration roadmap.

1. Establish the shared contracts and client, compatibility handshake, authenticated
   access, and runner process boundary. Prove packaged `node-pty` operation on
   Linux, macOS, and Windows early.
2. Implement one real terminal through `create`, `attach`, `write`, `resize`, and
   `close`. Render it with xterm in both Electron and a browser. Preserve the
   existing Focus/Grid/Canvas behavior.
3. Add screen restoration, replay checkpoints, bounded buffering, and flow control.
   Verify refresh, disconnect/reconnect, layout switching, full-screen applications,
   and responsive Ctrl-C under heavy output.
4. Persist workspace metadata, add connection profiles, and finish deployment setup.
   Verify a static frontend against a separately deployed VPS
   runner, including rejection of unauthorized operations and incompatible clients.

The first milestone is one terminal that works through both clients, survives UI
disconnects, restores its screen, resizes correctly, and remains responsive under
load. Keep advanced supervision, multi-host orchestration, and shared-user hosting
outside that milestone.
