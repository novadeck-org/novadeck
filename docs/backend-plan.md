# Terminal backend plan

Build a personal, self-hosted terminal runner shared by Electron and the web UI.
The runner owns shell processes; clients connect, send input, and render output.
This plan set the direction; the API examples below follow the current contract,
and the [backend API](backend-api.md) documents its exact schemas.

The runner and its UI integration are now implemented: shared contracts,
authenticated WebSocket RPC, real PTYs, replay, consumption ACKs, and SQLite
projects and sessions. The UI-facing `connectRunner` client wraps this wire API:
attachments acknowledge, resume, and resynchronize on their own, over WebSocket or
a host MessagePort. The desktop app runs the runner in an Electron utility process,
and the UI uses it through that port. See [backend API](backend-api.md) for its
setup and current contract. Remote deployment and connection profiles remain
separate work.

## Stack and boundaries

Keep TypeScript, Node.js, and Hono. Add oRPC with Zod contracts over WebSockets,
`node-pty` for shell processes, SQLite for workspace metadata, and xterm.js for
terminal rendering. Use headless xterm and serialization to restore screen state
after reconnecting.

| Part                   | Responsibility                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `application/ui`       | Workspace views, xterm rendering, and a typed runner client.                                 |
| `application/runner`   | Authentication, oRPC procedures, PTY ownership, output retention, and persistence.           |
| `application/host`     | Electron windows, desktop integration, and starting or connecting to a local runner process. |
| `application/protocol` | Shared Zod schemas, procedure contracts, stream events, typed errors, and the client.        |

Keep the protocol package independent of Electron, React, and server implementation
code. Define input and output schemas explicitly, including streamed events.
[oRPC contracts](https://orpc.dev/docs/contract/procedure) provide the shared API;
its [WebSocket adapter](https://orpc.dev/docs/adapters/websocket) carries calls and
streams. Hono remains the HTTP host for authentication and health endpoints.

Run one backend process per machine under its owner's OS account. Electron hands
its page a MessagePort to its own runner process; a separately hosted browser UI
uses HTTPS/WSS to reach the VPS runner. Both use the same contracts. A VPS runner
controls shells on that VPS; managing another machine later requires a connection
to that machine.

## API

Use named procedures for commands and an async stream for terminal events.
Workspace sessions group terminals; they are distinct from shell processes and
network connections.

```ts
// Check compatibility before attaching or changing anything.
const runner = await client.runner.handshake({ protocolVersion: 1, token })
// Returns runner identity and the negotiated protocol version.

const projects = await client.projects.list()
const sessions = await client.sessions.list({ projectId })
const terminals = await client.terminals.list({ sessionId })

// Clients name what they create, so a retried creation cannot make a duplicate.
const terminal = await client.terminals.create({
  id: crypto.randomUUID(),
  sessionId,
  cwd,
  cols: 120,
  rows: 30,
})

await client.terminals.write({ terminalId: terminal.id, data })
await client.terminals.resize({ terminalId: terminal.id, cols, rows })
await client.terminals.close({ terminalId: terminal.id })
await client.terminals.restart({ terminalId: terminal.id, cols, rows })
```

`write` sends terminal input, including control characters. It does not interpret
each message as a complete shell command. `close` explicitly terminates the shell
and removes the terminal; hiding a terminal or changing views only changes its
presentation. `restart` starts a fresh shell in a terminal whose shell has exited.
`terminals.watch()` streams every terminal's summary and later changes, so a UI
learns about exits and foreground processes without attaching to each one.

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

The event contract:

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
      exit: TerminalExit | null // null while the shell runs
    }
  | { type: "output"; data: string }
  | { type: "resized"; cols: number; rows: number }
  | { type: "exited"; exit: TerminalExit }
)

type TerminalExit = { code: number | null; signal: string | null; ranMs: number }
```

Derive this union from the shared Zod schemas. A snapshot contains serialized terminal
screen state; output contains subsequent terminal data. Batch output into chunks
instead of sending a procedure call per character. Procedures return typed errors
such as `TERMINAL_NOT_FOUND`, `TERMINAL_EXITED`, and `INCOMPATIBLE_PROTOCOL`.

Projects and sessions are created and renamed through the same contract pattern, and
removing a project closes its terminals before it forgets the project and its sessions.
Each session also stores an opaque client state, such as the UI layout, which the
runner saves without reading. Store connection profiles in the client so one UI
build can select "This computer" or "My VPS".

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
  an uncertain delivery; retrying input would require request identities and
  deduplication. Creation already carries a client-chosen ID, so a retry is
  rejected as a `CONFLICT` instead of starting a second shell. A successful write
  means input was accepted, not that a shell command completed.
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

SQLite stores projects and workspace sessions, including each session's saved
client state. Terminal configuration is not persisted. Live PTY handles and
connections belong to the running backend. Retain
screen state and bounded output history in memory initially; saved metadata does
not imply that a shell survived a runner restart.

Run the local runner outside Electron's main process: the desktop app uses an
Electron utility process, and a VPS runs a standalone service. Guarantee recovery
from UI reloads and network interruptions while the runner remains alive.
Keeping local terminals alive after quitting Electron requires an independently
managed background runner. Surviving runner upgrades or crashes requires a
separate persistent PTY supervisor; leave that as a later capability.

Local access uses a MessagePort handed to the page through the preload bridge;
holding the port is the credential. Remote access requires authentication,
HTTPS/WSS, and origin checks. Authorize each terminal operation, bound message
sizes, calls in flight, and retained terminal records, cap terminal counts on a
shared runner, and keep terminal contents out of ordinary request logs. CORS is configuration, not
authentication. Shells run with the runner owner's permissions.

## Implementation order

Steps 1 to 3 are implemented, and the UI now runs on the runner in Electron and in
a browser during development. Step 4's workspace metadata is in place; connection
profiles and deployment setup remain.

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
