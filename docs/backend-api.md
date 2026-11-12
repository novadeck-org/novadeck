# Backend API

This describes the runner behind the [terminal plan](backend-plan.md) and how the UI
uses it. The Electron host runs the runner and hands its window a port to it; the UI
connects through that port, or in a browser over a WebSocket, with the runner adapter
in `frontend/runner-adapter/src/`.

## Run and test

Use the repository's Node.js 26 and pnpm versions, and Rust (rustup), which builds the
relay. `node-pty` is a native dependency;
installation can require Python and a C/C++ toolchain for your platform.
`node-pty` is pinned exactly to `1.2.0-beta.14` for its native cleanup fixes and
correct macOS spawn-helper permissions. One local patch
(`libraries/terminal/patches/node-pty@1.2.0-beta.14.patch`) adds an error listener to its Windows input
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
release workflow runs `pnpm --filter @novadeck/desktop smoke` against each unpacked
package. It checks that the Windows package ships `conpty.dll` and `OpenConsole.exe`
and has no source-built node-pty, runs a real shell through the packaged runner, and on
Windows confirms that `OpenConsole.exe` hosts it.

From the repository root:

```sh
pnpm install
pnpm exec turbo run build --filter=@novadeck/runner
cp backend/runner/example.env backend/runner/.env
```

Generate a credential with the command in `example.env`, then set `NOVADECK_TOKEN`
in the ignored `.env` file. Leave `HOST=127.0.0.1` for local testing: the runner refuses any HOST that isn't loopback
(`localhost`, `127.x.x.x`, `::1`) unless `NOVADECK_ALLOW_REMOTE_HOST=1` is also set. A project created without a folder uses the home folder, so plan saves are
bounded only by the home folder there. Run:

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
import { connectRunner, desktop } from "@novadeck/runner-client"
import { messagePort, websocket } from "@novadeck/wire/client"

// Deployed separately: a token-authenticated WebSocket (use wss:// remotely).
const runner = await connectRunner(websocket("ws://127.0.0.1:8787/api/rpc", { token }))

// Bundled in the Novadeck desktop app: a port from the host to its runner process.
const runner = await connectRunner(desktop())

// Any other host that hands the page a MessagePort to a runner.
const runner = await connectRunner(messagePort(port))
```

`connectRunner` resolves after the first handshake and rejects with a
`WireError` from `@novadeck/wire` (for example `UNAUTHORIZED` or `INCOMPATIBLE_PROTOCOL`). After that
it reconnects on its own, through `connect` from `@novadeck/wire/client`. `runner.status` holds the
current state (`connected` in an `epoch`, the runner's id; `reconnecting`; or `closed`), and
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
  detached, or the client closes. It throws a `WireError` only when the attachment
  cannot continue, such as `CONTROL_IN_USE` after another client took control
  during a disconnection or `TERMINAL_NOT_FOUND` after the runner restarted.

The client names every project, session, and terminal it creates with a fresh UUID,
so it can refer to one before the runner answers. A taken ID rejects with `CONFLICT`;
for terminals that includes exited records the runner still retains. A project
created without `cwd` opens in the home directory of the user running the runner.
`projects.remove({ projectId })` closes every terminal of the project's sessions,
running or kept only as saved, whichever connection controls them, so watchers see
each `removed`; then it deletes the project, its sessions and what the runner kept of
their terminals, their companion items and windows (`companions.watch` reports
each `itemRemoved` and `windowRemoved`, and their `content` streams end), and its agents'
messages. Its folder on disk stays. Terminals being
created in the project as it begins finish first and close with the rest; while it
goes, `projects.list` leaves it out, creating a session or terminal in it rejects
with `NOT_FOUND`, and restarting one of its terminals with `TERMINAL_NOT_FOUND`. A
second call while it goes shares the first, and one after it, like one for a project
the runner never had, rejects with `NOT_FOUND`. A runner that shuts down before the
removal is done rejects it with `CLOSING` and keeps the project, for a client to
remove again from the next runner.
`sessions.list` gives a project's sessions in the order the person arranged them,
sessions never arranged after those that were, in the order they were created; a session
created with `sessions.create` comes first.
`sessions.arrange({ projectId, order })` keeps that arrangement: `order` is session ids,
first to last. Ids the project doesn't have, and repeats, are ignored, sessions `order`
leaves out follow in the order they had, and a session being removed is left out. An
unknown project rejects with `NOT_FOUND`.
`sessions.remove({ sessionId })` closes every terminal of the session, running or kept
only as saved, whichever connection controls them, so watchers see each `removed`; unlike
a project's removal, each stays in the project's History, to restore into any session of
the project (`terminals.create` with `closed`). Then it deletes the session and what the
runner kept of it: its terminals' saved records and handles, and its companion items and
windows (`companions.watch` reports each `itemRemoved` and `windowRemoved`). Terminals
being created in the session as it begins finish first and close with the rest; while it
goes, `sessions.list` leaves it out and creating a terminal in it rejects with
`NOT_FOUND`. A second call while it goes shares the first; one after it, like one for a
session the runner never had, rejects with `NOT_FOUND`; the project's last remaining
session rejects with `CONFLICT`, as a project always has one. A runner that shuts down
before the removal is done rejects it with `CLOSING` and keeps the session.
`projects.list` gives the projects in the order the person arranged them, each with
`pinned`; `projects.arrange({ order, pinned })` keeps that arrangement: `order` is project
ids, first to last, and `pinned` the ones pinned, at most nine, the first in `order` (one
`order` doesn't name isn't pinned).
Unknown ids are ignored, projects `order` leaves out follow in the order they were added
(with no pin), and a project being removed is left out. Other clients see the change when
they next list the projects.
`projects.folder({ projectId, folder })` lists one folder of the project's directory,
`folder` being its path from the project's root with `/` between names (`""` for the
root). Entries come sorted, folders first, then by name ignoring case and a leading dot
(`.github` sits among the g's), never `.git`, each with `ignored` as git reports it
(nothing is ignored outside a repository). At most 2000 are listed, the first in that
order, and `truncated` says there were more. A missing project is `NOT_FOUND`; a folder that is
missing, not a folder, or outside the project's directory is `INVALID_DIRECTORY`.
`sessions.save({ sessionId, state, visitedAt })` replaces a session's `state`, a string the
runner stores with the session without reading it, such as a UI layout, and `visitedAt`,
when the person last visited it (null: never). Sessions list both; the latest visit picks a
project's current session, and the latest of all the project that opens. It holds only
how a client shows the session's terminals, by id: the terminals themselves, their
titles, directories and what they ran, are the runner's own records. Sessions
report `null` until the first save. A state holds at most `maxClientStateLength`
(196,608) characters, and over WebSocket the whole call must also fit in one
`maxWebSocketMessageBytes` (256 KiB) message; both limits are exported from
`@novadeck/protocol`. Once the runner starts shutting down it refuses saves with
`CLOSING`, so shells ending on the way out cannot overwrite the last state; it
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
title })`; the one the agent that opened it gave through `open_terminal`'s or
`open_agent`'s `title`; the latest title murmur, the opt-in local model, wrote for it; the
one the terminal's own agent gave through `describe`; or the runner's default: the program
it was opened to run (`claude`), else "Terminal", never derived from its handle.
`titleSource` says which: `{ kind: "person" }`, `{ kind: "murmur" }`,
`{ kind: "agent", by: "fox" }` (the opener's handle, or the terminal's own for its agent's
title) or `{ kind: "default" }`. The summary its agent gave through `describe` is not on
the wire: only `agents()` lists it. A terminal the client creates for an
agent's request (`terminals.requests`) passes that request's `requestId` to
`terminals.create`, and takes the title the agent asked for as the agent's.
`terminals.resetTitle({ terminalId })` takes the person's name away, so it is automatic
again (see [Agent messaging](agent-messaging.md#naming)). `terminals.busy()` answers `{ busy, unknown }`: the ids of the terminals, in every session, whose shell holds work a restart would end, and those it could not read, which a client must not take for idle. With no agent that is a program in the foreground, an unfinished line, a background or suspended job. With an agent, whose own process is its session and resumes, it is only work beside or under it: for a bound agent, by the rule that keeps an idle agent from resting (a process under it that it didn't come up with, such as a Codex background terminal or a tool's server, a job of the shell's beside it, the agent suspended); for one not yet bound, the shell's jobs beside it. A process re-parented away from the agent (a double fork) is seen by neither. On Linux and macOS the call reads the system's processes a fixed number of times for all terminals, not once each (Windows reads each shell's tree through the relay), and nothing samples it, so a client asks while someone looks at the answer (every few seconds while a restart's card is open) and when it is about to act on it. Calls that overlap share one read; `terminals.busy({ fresh: true })` waits for a read that starts after the call, so an answer that began before it is never taken for the present. `handle` is its
handle for agents' messages, a word such as `moth` that its session gives it (people read
it as `@moth`); every terminal takes one, even one created with its own title, and keeps
it across renames. A session never gives a word twice, even once its terminal closes;
once all are given, they come again with a letter from the end of the alphabet (`mothz`). Terminals list in the order they
were created. `command` is what it was opened to run, and
`lastProgram` the program it last had in its foreground, which a fresh shell resumes
where that is an agent. Windows doesn't tell a terminal's foreground program, so there it
is the agent whose session last bound the terminal, until the shell has shown its prompt
for a second (`processPollMs`), as a sample would tell elsewhere.

`reported` is the agent's `done` report that still stands, `{ subject, at }`, or null: the
latest `done` of the session bound in the terminal, read or not (from the report log, so
not ended by the Inbox's day), unless the person's
prompt or a message delivered to the agent came after it. It follows the Inbox and those
inputs as they change, so a client's done mark needs no Inbox row, and looking at the
terminal never ends it. After a runner restart it is the resumed session's until a binding
has ended; Codex and Antigravity bind only at their first prompt, so until then it comes
from that saved session. The agents listing's "reported done" follows the same rule.

`runner.terminals.move({ terminalId, to, handles?, lead? })` moves a terminal to another session
of the same project without restarting it: a running one, or one kept only as saved (a
sleeping agent). `to` is `{ sessionId }`. A lead takes its whole team,
at every depth, in one step, so none is ever led by a handle that went; a teammate moved on its
own leaves its lead, and the answer's `left` is that lead's handle (null if it had none). The
answer is `{ sessionId, moved, left }`, `moved` listing the terminal asked for and then its team
as `{ terminalId, handle, was }`. Each keeps its handle unless the target session gave it
already, as a restore from History does (a terminal there has it or is led under it, or the
session gave it to another): it then draws that session's next, and its workers' `ledBy` follow.
`handles` (by terminal id) and `lead` undo an earlier move: a handle is taken back where no
terminal of the session holds it or is led under it, and the terminal rejoins the lead with
that handle if one is there, without asking. `terminals.watch` tells each moved terminal as a
`changed` with its new `sessionId`; its Inbox rows and its companion bar's items go with it,
and each running agent hears of it as a notice, with any new handles and the lead it left (a
sleeping agent isn't woken for it). A terminal that is closing, stopping to rest, being woken,
whose agent has a terminal on its way (`open_agent`), whose lead's brief to it hasn't arrived
yet, or that an approval the person hasn't answered names (as the asker or the target) is a
`CONFLICT`, as are the terminal's own session, a session of another project and a session being
removed; an unknown terminal is `TERMINAL_NOT_FOUND` and an unknown session `NOT_FOUND`.
`Moves.apply` (`backend/runner/src/terminals/moves.ts`) lists everything that follows a
terminal, in the order it must, and what deliberately doesn't (messages, which are addressed by
terminal id; briefs, opens and approvals, which refuse the move); a feature that keeps a
terminal's session or handle belongs on that list.

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

The MCP `ask`, `tell` and `done` tools add questions and updates to the Inbox. In a Novadeck
terminal the server's `instructions` say when each serves: `ask` doesn't stop the work, as
most decisions aren't blocking, and its question is also put in the reply; `tell` is for
milestones; `done` is the agent's own short report when the task it was given is finished,
not when it answers a question or finishes a step. With a lead, the agent uses them all the
same and also sends its lead the same. Claude Code reads the instructions up
front, before it loads a tool's description; the prompt-time notice every harness gets says the
same for Antigravity, which reads none. A client follows
all active entries across projects and sessions, answers an ask, or marks tells and done
reports read:

```ts
for await (const entries of runner.inbox.watch()) showInbox(entries)
const entries = await runner.inbox.list()
await runner.inbox.answer(askId, { type: "reply", option: null, text: "Use green" })
await runner.inbox.answer(actionAskId, { type: "done" })
await runner.inbox.read(updateIds)
```

An entry includes its id, terminal, project and workspace session ids, exact agent
session, handle, creation time and `content`: `{ kind: "ask", ask }` or
`{ kind: "tell", subject, body }` or `{ kind: "done", subject, body }` (a tell's fields, and
the report an agent called `done` with). An ask's shape is text, up to three options, or an
action for the person to run. Secret shapes are unavailable. `answer` rejects stale or
already answered asks with `CONFLICT`, invalid answers with `ANSWER_FAILED`, and a
full message queue with `RESOURCE_LIMIT`. Resolving the ask and storing its answer are atomic;
answers arrive later through ordinary message delivery. `read` affects tells and done reports only and takes
at most 1,000 ids per call. A done report, like a tell, outlives its agent and turns into
Messages history once read, and goes with the usual day. The report that still stands
(`TerminalSummary.reported`) is read from the report log, which keeps an agent session's
latest reports for as long as its terminal is open or History keeps it. `watch` resubscribes with a fresh listing on reconnect.

The MCP `feedback` tool drafts feedback about Novadeck for the app's feedback card. Drafts
are no Inbox entries: the runner holds them in memory only, one per terminal (a new call
replaces it), past the agent session and the terminal, until the project is removed or the
runner restarts. `feedback.watch()` follows the waiting drafts, oldest first (id, terminal,
project, session, agent, handle, time, kind, text, `asked`). The client calls
`feedback.settle({ id, outcome })` (`"sent"` or `"discarded"`) once it sent one or the person
discarded it; the runner sends nothing and the agent isn't told; an id it doesn't hold is
`NOT_FOUND`. `feedback.ask({ terminalId, hint })` relays the person's request for a draft to
the agent in a terminal as a message from them; the draft that follows, once it reached the
agent, has `asked: true`. An unknown terminal is `TERMINAL_NOT_FOUND`, one with no agent
session bound `NOT_FOUND`, one whose earlier request still waits `CONFLICT`. See
[Agent messaging](agent-messaging.md), "Feedback drafts".

Agents in a project's terminals message each other (see
[Agent messaging](agent-messaging.md)); the runner API lets a client see and steer it:

```ts
const messages = await runner.messages.list(terminalId)
// { terminalId, handle, delivery, paused, threads: [{ id, peer, hops, idle, held, heldFor, stopped, messages }] }
await runner.messages.pause(true) // or false to resume
await runner.messages.release(threadId) // a thread held as a loop
await runner.messages.stop(threadId) // end a thread: nothing more of it is delivered
for await (const listing of runner.messages.watch(terminalId)) show(listing) // as it changes
```

`messages.list(terminalId)` gives a running or exited terminal's handle, its delivery
state (`unbound`, `fresh`, `working`, `settled`, `ringing`, `drafting` or `unknown`), whether
messaging is paused, and its threads, newest first, each with its `peer`, the other party
(a terminal's agent, `{ kind: "agent", handle, agent }`, or the person, `{ kind: "person" }`),
its hops so far, its idle messages in a row (sent while neither end worked, see
[Guards](agent-messaging.md#guards)), whether it is held and why (`heldFor`: `"loop"`, or
null when not held or for a hold carried over from the twelve-hop rule), whether the person stopped it, and its messages, oldest first: id, hop, its `from` and `to`
parties (a recipient agent's `agent` is never null), text, when sent, state (`queued`, `leased`, `delivered`, `held` or
`gone`), why it is held (`paused` or `release`), and when delivered. Inbox history
adds optional `inbox: "ask" | "tell" | "done" | "answer"`; the person in it is `{ kind: "person" }`.
Ask, tell and done traces also have `inboxState`: `open`, `answered`, `read`, `withdrawn`,
`gone` (the asking session ended, or did not come back within two minutes of a runner restart), or `undelivered` (the person's reply went gone before
reaching the agent). A reply already delivered stays delivered when the session ends.
Trace outcomes are separate from delivery state, so a withdrawn question (by its agent, or by Novadeck when the person wrote to that agent in its terminal) remains an
already-received history entry.
Ask and tell entries are delivered history; answers show their real delivery state.
These person threads have no loop hold, release or stop control, and list `idle: 0`,
`held: false` and `heldFor: null`. A terminal the
runner doesn't hold is `TERMINAL_NOT_FOUND`. `messages.pause(paused)` pauses messaging
across the whole runner, every project and session, keeping the switch across
restarts: waiting agent-to-agent messages are held, and wait in order again once resumed.
Person replies to Inbox asks bypass the pause and have their own fifty-reply waiting
capacity, independent of the fifty waiting peer messages. The person's note allows up
to 4096 characters and must also fit the 8192-byte encoded delivery budget; a size error
asks the person to shorten the reply and leaves the ask answerable.
`messages.release(threadId)` ends a thread's hold, and the pair's other threads' (`held`
false, `heldFor` null), lets their held messages wait to be delivered and starts their idle
counts afresh (a release of a thread with no hold, `held_from` null, leaves its count), and a stopped thread no longer stopped; an unknown thread is
`NOT_FOUND`. `messages.stop(threadId)` stops a thread, ending any hold: its messages not yet
delivered or leased are `gone`, their senders told (once, through the MCP tools' answers) that the
person stopped it, and a send that would continue it, in either direction, is refused
until 10 minutes after the later of the stop and the thread's last message (a refused send
does not extend them) or the person releases it, the listing's `stopped` holding only
meanwhile; a leased message is left to finish, the recipient is told nothing,
stopping a stopped thread does nothing, and an unknown thread is `NOT_FOUND`. Each refuses with
`CLOSING` once the runner is stopping. `messages.watch(terminalId)` streams what
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
without controlling it; its `write` and `resize` reject with `CONTROL_REQUIRED`.

### Serving a runner

`@novadeck/runner` separates the runner from how clients reach it: the runner holds its
clients' sessions (`runner.sessions`), and the wire's transports serve them:

```ts
import { maxWebSocketMessageBytes } from "@novadeck/protocol"
import { createRunner } from "@novadeck/runner"
import { servePort, serveWebSocket } from "@novadeck/wire/server"

const runner = createRunner({ database })

// Deployed: token-authenticated WebSockets at /api/rpc on an HTTP server.
const sockets = serveWebSocket(runner.sessions, {
  path: "/api/rpc",
  token,
  origins,
  maxPayloadBytes: maxWebSocketMessageBytes,
  sendBudgetBytes: runner.snapshotBytes + 8 * 1024 * 1024,
})
httpServer.on("upgrade", sockets.upgrade)

// Bundled: one trusted client per MessagePort, such as an Electron renderer's port
// to a utility process. Holding the port is the credential.
const dispose = servePort(runner.sessions, port)
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
chosen path or `null` when cancelled. `showNotice(notice)` shows a desktop notification for
a terminal, `closeNotice(id)` takes away the one still showing for it, and
`setBadge({ count, image })` puts the Inbox count on the app's icon (macOS dock text,
Linux launcher count, and on Windows a taskbar overlay drawn from `image`, a small PNG
data URL); all three are checked on both sides and dropped when invalid.
`onWindowFocus(listener)` tells the page whether its window has the system's focus (at once, then on
each change, as a boolean): the page's own `document.hasFocus()` misses focus inside a
`<webview>` and the window losing focus to another app while it is there. The page asks on
`novadeck:window-focus-request` each time it listens, so a page that loaded again learns the
current state, and only the app's own page is answered. If the runner process dies, the host starts a
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
arbitrary event-name handlers. oRPC is pinned to 1.16.1, once, in the pnpm catalog in
`pnpm-workspace.yaml`: its installed API uses `eventIterator` and the server's `ws`
and `message-port` adapters. The connection itself is the `@novadeck/wire` library
(`libraries/wire`): it keeps oRPC's standard wire protocol over a small channel
adapter that settles pending calls when a socket or port closes, and its
`createWireClient` gives the raw `WireClient` for protocol tests. The contract spreads
wire's own error codes (`wireErrors`) beside the runner's. Applications use
`connectRunner`.

Every connection starts with the wire's handshake, `wire.handshake({ protocolVersion,
token, clientId })`, which returns the runner's `epoch` (its lifetime: terminal cursors
are valid only within one) and the protocol version. WebSocket connections
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
  attachment, closes the terminal from any connection, whoever controls it. The
  runner forgets it as the close begins: `list` omits it, watchers receive `removed`,
  what restores it is deleted from the session, and nothing saves it again, so a runner that
  stops before the shell has exited does not bring it back. It then ends the shell; attached
  viewers still receive `exited`, and later calls report `TERMINAL_NOT_FOUND`. A close reaches
  a runner that is shutting down too; only a stopped one refuses it, with `CLOSING`.
  A close is no longer final: unless nothing ever ran in the terminal (no line entered, no
  agent session) or its project is being removed, the runner first keeps a row of it in
  History for 7 days, built from the terminal in memory (an agent's sessions without their
  turns; a plain terminal's last screen, masked and sealed like any transcript, which the
  runner's shutdown waits for). Every route does: the person's, an agent's (the row names its
  handle in `closedBy`), and a terminal kept only as saved. A shell that exits on its own
  keeps its record until eviction, and the terminal itself until it is closed. The runner
  refuses to create a terminal closed in its lifetime again under the same id, restoring or
  not, even one a `create` was restoring as it closed, with `TERMINAL_NOT_FOUND`: a client
  takes that as the terminal closed elsewhere. Bringing it back is a `create` with
  `closed` and a new id (see `history.*`).
- `terminals.restart({ terminalId, cols, rows, resume? })`, or
  `runner.terminals.restart(id, { cols, rows, resume })`, starts a fresh shell in a
  retained exited terminal: the same ID and session, in the shell's last reported
  directory (or where it started, once that is gone), with a new screen that shows the
  earlier one above a separator while transcripts are on. With `resume`, the fresh
  shell resumes that agent's session instead, as for `create`, and then the earlier
  screen is not shown. The
  caller needs control unless no connection holds it, and then holds control. The
  summary's `run` counts shells, 1 at creation and one more per restart, so a client
  can discard a late report about an earlier run. Watchers receive `changed`;
  viewers attach again and get the new screen as a snapshot, even with a cursor from
  the previous run. A running terminal rejects with `CONFLICT`, and a shell that
  cannot start rejects with `SPAWN_FAILED`, leaving the terminal exited.
- Closing sends a hangup to the owned shell, escalating if the shell ignores it.
  Where the terminal's bound agent holds the foreground, what the agent started is
  read first and waited for, 3 s for a close and 2 s for a shutdown, then gets
  SIGTERM, and SIGKILL half a second on. Otherwise it is not a process-tree kill
  guarantee: daemonized jobs and descendants that ignore hangup may continue, as with
  an ordinary terminal emulator, and so may a daemon an agent left in a group of its
  own. Use an OS service/cgroup or a future supervisor if all descendant cleanup is
  required.

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
- On Windows, where cmd's AutoRun prints: `agy-cmd/cmd.exe`, Novadeck's `cmd.exe` pass-through
  (`novadeck-cmd.exe`, built with the relay and checked byte for byte against the shipped one), and
  `bin/agy.cmd`, which shells get first on `PATH` while Antigravity is connected: it puts `agy-cmd`
  first on `PATH` for Antigravity alone, so its `cmd /c` hooks run the real cmd with `/d` and the
  AutoRun's output stays out of their answers. See [agent messaging](agent-messaging.md).
- `hook` (`hook.cmd`), a launcher that starts Novadeck's relay (`novadeck-relay`, a
  small native program copied in beside it; see `backend/relay`), so the hook needs
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

The relay (`backend/relay`) and the runner's endpoint (`shell/reports.ts`) speak
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
   - `ancestors` is up to eight `{ pid, name, startedAt }`, nearest first, `startedAt`
     in epoch milliseconds and left out where unknown. They come from `/proc` on Linux
     and the kernel on macOS, named by the path each was started by, and on Windows from
     a process snapshot, named by their program without `.exe`, where the walk stops at
     a recorded parent that started after its child, another process given an ended
     parent's pid. The runner names the agent's process from them, and on Windows, where
     a hook's shell starts slowly, when the agent fired the hook (`firedAt`): when the
     ancestor just below the agent started, the shell the hook runs in, seconds before
     `seq`. Elsewhere `seq` tells, and the ancestor below the agent may be a long-lived
     process of its own, as under a wrapper script that doesn't `exec` it.
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
   A lease may name only a notice and no messages; it is acknowledged the same way.

A hook gives up two seconds after it starts when it reports, four when it asks, and five
for Claude Code's status line. For the status line, the relay also runs the person's own
command, as their Claude Code settings name it, beside the report, and prints it: in
`/bin/sh`, or on Windows in Git Bash, as Claude Code runs it, in a job object that ends
everything it started at the deadline. Without
the relay, the hook launcher prints what `relay.json` would, as it is written from the
same tables.

On Windows the runner also runs the relay for what it would otherwise start PowerShell
or taskkill for:

- `novadeck-relay environment` prints the registry's environment variables,
  unexpanded: a line for each text value of the machine's and then the user's
  `Environment` key, `machine` or `user`, its name and its value, each in base64 of
  its UTF-8. A new terminal's PATH is built from them, as Windows builds a new
  console's. Where the relay can't run, Windows PowerShell prints the same lines.
- `novadeck-relay tree <pid>...` prints, a JSON line per pid,
  `{"root":<pid>,"processes":[{"pid","startedAt"},...]}`: the process and every one
  under it, counting a process as a child only if it started no earlier than its
  recorded parent.
- `novadeck-relay end <pid>:<startedAt>...` ends each of those processes still running
  that started then, and no other given its pid since.

`works.watch` reports a work per tracked worktree, keyed by its root (`{ root, terminalId | null,
projectId, working, branch, base, firstSeenAt, added, removed, files, conflicts, … }`; `removed`
carries the root, and a conflict with another work names its root and owner). `works.look({ root })`
marks it read, `works.show({ root, terminalId? })` shows it as a changes item on its owner's bar
(`terminalId` names the bar for a work with no owner), and `works.close({ root, force? })` closes the
worktree as the person asks, through the worktrees service: it answers `{ closed: true, kept?, keptHead?, branchDeleted }`, or, without `force`
and with the worktree holding uncommitted files or commits main lacks (squash- and rebase-merged
work does not count), `{ closed: false, holds }` for the person to confirm before `force`. It
refuses with `CONFLICT` and the reason while its owner's agent is working in it (checked afresh in
the service's queue), when git status can't be read or the worktree has submodules (even with
`force`), and answers `NOT_FOUND` for a root that is no work. These work with the Experimental switch off.

The runner keeps who owns each git worktree its agents work in in a `worktrees` table (schema 14):
the worktree's real path (the key), its repository's git common dir, branch, the commit it started
from, its project (which cascades), its owner terminal (plain text: a live terminal or one in History,
null once orphaned), whether it was adopted and whether Novadeck made its branch. The agents' `open_worktree`,
`take_worktree`, `close_worktree` and `give_worktree` tools are the only way ownership changes; they
reach the runner as the relay's `openWorktree`, `takeWorktree`, `closeWorktree` and `giveWorktree`
calls, and a listing of the tools asks it `worktrees` (whether Preferences has them on). At start the
runner checks every row against the disk and the terminals (see agent-workspace.md, "Worktrees"). A
`take` approval on `terminals.approvals` asks the person to let one agent take a worktree another
terminal owns.

The runner saves, per terminal, in a `terminals` table next to the sessions: its
session, last directory, latest session per agent, when it last showed a prompt, and
its transcript (the serialized screen and scrollback, without the alternate screen,
capped at 256 KiB), its title, the command it was opened with and the program it last
had in its foreground, until it is closed. The directory, agent sessions and title are
saved as they change, the rest every five seconds when changed, when a shell exits, and
on `persist()` and `close()`, which save before any shell ends. The transcript is saved
separately, after the runner masks what looks like a secret in it (known token prefixes,
values named like secrets, keys, long key-like runs; anything else may still be saved).
Only a terminal whose screen changed is queued, at most every 30 seconds; one whose shell
exits or restarts goes first in the queue. One transcript is masked at a time, for the
whole runner. `persist()` and `close()` also give the changed screens one pass of about a
second, written until that second is over (as the runner closes, its records close only after it); a transcript
unfinished then keeps its last saved copy. A transcript that cannot be masked is not
saved, and the copy saved before stays. A result that arrives after its terminal was
closed, or transcripts were turned off, is dropped. The masked text is sealed just before
it is written: AES-256-GCM with a random nonce and the terminal's id as associated data,
saved as `v1.` and the base64 of nonce, tag and ciphertext, which holds the time the
transcript was saved (8 bytes) and then its text; a restored transcript's "saved" line
shows that time. The key is the 32 bytes the host gives the runner (`transcriptKey`; the
desktop app unwraps it from the system keychain: Keychain, DPAPI, or the Secret Service,
which KWallet may offer too). No screen is taken before the key has come; where there is
none (no keyring, a refused unlock, the standalone runner) transcripts are neither saved nor shown for that run, the `transcripts` setting is kept
and the sealed copies saved before stay. At every start, before and without the key, the
store forgets every transcript not shaped as a sealed one (`v1.`, then at least the nonce,
tag and time in base64, and nothing else); a database set aside as
`workspace.sqlite.earlier-<time>` is not touched. A restored terminal's transcript is
opened before its shell starts, waiting for the key at most `transcriptKeyMs` (a few
seconds) from the run's first restore, and is shown only if it opens for that terminal. A
terminal whose copy went unopened because the key came later keeps that copy as it is for
the run: its transcript is not saved again until the next start. See
[transcript-redaction.md](transcript-redaction.md). Closing a terminal forgets it, including
one from an earlier runner.

- `terminals.create({ …, restore: true, resume? })` continues the saved terminal of
  that ID in the same session: in its last directory when that still exists, with its
  agent sessions, showing its transcript above a separator before the shell's output. On
  Windows both go up into the scrollback, as ConPTY places its cursor at rows counted
  from the top of a screen it takes as its own and would draw over them.
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
  and its answers, or a plan's file, when its hook started it as `askedAt`, in epoch
  milliseconds on the runner's clock, its `dialog`, below, and `detached: true` where it asks
  without holding the agent, as Codex's async questions do, its prompt free: those are listed
  after the requests that hold it), and how much of each
  feature the agent's harness
  tells (`unsupported`, `partial`, `complete`). Actors and requests have runner-issued
  refs, never a harness's own ids; the summary's subagents use the same refs. Its `prompts`
  are the receipts of the prompts given through `agents.prompt` in the bound session (see
  "Prompt receipts" below), and its `box` what the agent's input box holds (see "A box that
  isn't empty" below). Without an agent bound, only `terminalId` is set, with the receipts of
  prompts given an agent at its own prompt before its session binds, and its `box`. The stream follows the terminal from agent to
  agent and ends when the terminal is closed; an unknown one is `TERMINAL_NOT_FOUND`.
  The client's `agents.detail(terminalId)` resubscribes across reconnections and ends
  once the terminal is gone.
- `agents.slice({ terminalId })` streams the rows of the terminal's screen that stand for
  something of its harness's own at its input, so the chat can show them live in place of a
  dialog: a snapshot `{ slice }`, then another on each change, `slice` null while nothing
  shows. A slice (`liveSlice`) is self-contained: `columns`, `rows` of style runs (`text`,
  `width` in columns, `fg` and `bg` as a palette index or `#rrggbb`, null for the default, and
  `bold`, `dim`, `italic`, `underline`, `inverse`), the `cursor` in its rows and columns or
  null, `reason` and `secret`. `reason` says only what the readers tell: `menu`, the box holds
  the harness's own key (`/`, `@`, Codex's `$`) and something was drawn for it; `view`, the box is gone, covered
  (`BoxProfile.overlay`);
  `dialog`, a request that holds the agent whose `dialog` is `raw`. Nothing reads what the rows mean, so it holds
  for whatever a harness draws. A request whose dialog is read, or not yet, shows none: that
  dialog is the chat's to draw. The harness's box rows are left out of a menu: the chat's
  input holds that text.
  Where a thing starts is found against the last screen seen at rest (`readSlice` in
  `harnesses/core/src/slices.ts`): above the box, the rows are walked from the top while they
  match the resting rows in order, as what is above stays or moves up whole, and the first
  that doesn't is its top, and a menu there ends one row short of the box, so a row that
  changed further up is no menu; under it, from the closing rule to the last row drawn, and
  no more rows than the footer at rest is no menu. The side comes from the harness
  (`SliceProfile.side`). Fail-safe: a menu above the box with no screen at rest of this size
  shows nothing; past `sliceLimits` there is no slice, as rows cut short would be the wrong
  rows; a view with no such screen is the whole screen, which holds the view. A view shows
  only once it has stayed 120 ms, as a redraw between two frames has no box either. Mid-turn a
  row that changed above a menu (Codex's `Working (2s)`, streamed text) can land at the
  slice's top: it can't be told from a menu that grew without reading it. A request that
  holds the agent keeps its dialog in the chat; a detached one leaves its prompt free, and
  menus go on showing.
  `secret` marks rows a harness's reader knows as a secret prompt (Claude Code's `Paste code
  here`): they are shown, as the terminal's own stream shows them to the same person, but
  nothing keeps a copy. A slice's rows go to its readers and nowhere else: never to a log, a
  trace, telemetry or a saved state. The screen is looked at only while someone reads,
  at most every 50 ms; a terminal nobody watches costs nothing. It is a stream of its own, not
  part of `agents.detail`, because it changes on every key. It follows the terminal from
  agent to agent, covers an agent shown at its prompt before a session binds (Antigravity
  and Codex bind at a first prompt), and ends when the terminal is closed; an unknown one is
  `TERMINAL_NOT_FOUND`.
- `agents.keys({ terminalId, keys })` writes keys to the terminal's agent as the person's, for
  what shows in `agents.slice`: a chat holds no control of the terminal, so `terminals.write`
  isn't its way in. They wait out what holds the terminal's input, as a prompt's paste, as the
  person's do. A terminal with no agent is a `CONFLICT`, and so is one with a request that holds
  the agent and whose dialog the chat can answer; a dialog no adapter read takes keys.
  The chat's rule for them: when the draft calls up a menu (`opensMenu` in
  `contract/protocol/src/harnesses.ts`: a leading `/`, a last word starting `@`, on Codex `$` too)
  over an empty box, the draft goes as keys and what is typed goes after it, as a diff of the
  draft (what was added, Backspaces for what went, Ctrl-U and the line again for an edit in
  between), so a paste or an IME goes too. That lasts while the text calls up a menu and fits
  one row of the box, as one Ctrl-U clears one row: once it doesn't, as a message goes on past a
  mention, the box is cleared and the words are the chat's again, a long `/` command's refused. Enter goes as a key. Tab, Up, Down and Esc go only while a slice shows, one per
  press: on an empty box Codex's Esc arms "edit previous" and then opens its transcript,
  mid-turn a further Esc stops the turn, Up recalls an earlier prompt and Tab queues. After Tab
  or Enter the text is the harness's, which may complete, run or keep it (Antigravity's Enter
  completes and a second runs): the draft mirrors `agents.detail`'s `box`, and goes once that
  reads empty. Enter goes on its own, at least 150 ms behind the keys before it, as Codex reads
  an Enter right behind text as part of a paste. A view or an unread dialog takes the keys
  itself while it shows, a paste included, but for what the app keeps (Ctrl+Shift, a modified
  key, Ctrl+C over a selection). Stop clears the box first, as a menu takes the Esc it would
  press. A draft the keys can't answer (a mention of a key its harness has no menu for, a line
  break, a control character, a box that holds text, a request's dialog the chat answers) stays
  under `PROMPT_REFUSED`'s rule. While keys pass or a menu shows, `One input`'s take leaves the
  box alone. Leaving the chat with a menu up
  leaves its text in the terminal's box and the draft goes; coming back to a menu goes on from
  the box. A command the person runs so has no receipt and hardly a record ("What a harness
  draws at its input" in docs/harness-coverage.md): the chat echoes what they typed as their
  words, unless an Enter left the text in the box, with the last of the view it opened under it,
  never a `secret` one, for as long as it lives.
- `agents.transcript({ terminalId, actor })` streams an actor's conversation, by the ref
  `agents.detail` names it by, as its harness recorded it: batches of up to 256 items
  from the start of the record in the order the harness wrote them (Antigravity may
  write a tool's result before its call; `call` pairs them), then each one appended,
  and `reset` when the record was
  rewritten (the items follow again from the start). An item is the person's or the
  agent's text, a tool call with its input as text, or a tool's result, numbered from
  the record's start, with when it was written; `call` pairs a result with its call by a
  runner-issued ref. Text past 16 KiB is cut short and marked `truncated`, and reasoning
  never appears. `outcome` says what came of a tool call, as its harness's decoder read it
  from the record, before any cut, and null where the harness says nothing: `failed`
  (true, false, or null where unknown), `exit`, `running` (it goes on past this result, a
  command in the background, whose `failed` stays null), `size` (a count and its unit) and
  `change` (lines `added` and `removed`, and the first 40 diff lines, with a number where
  the harness records one). A call's item holds what its input says, `change` alone, its
  result's the rest; the chat's core joins them by `call`, keeps an input's `change` only once
  the result says `failed: false`, and holds what is marked `opening` (read from the words a
  result opens with) only for a call of kind `run`, `read` or `write`.
  `scripted` marks a call Codex made inside a script of the agent's (code mode), recorded as
  an event of its own after the script's call, in order, with nothing naming the script. It reads Claude Code's session transcript and its per-subagent ones,
  and Codex's rollouts (a subagent's found on its parent's day or up to a week later),
  without the context either harness writes in the person's place, their developer or
  meta records, and Antigravity's (the step log its hooks name: the person's request
  without the context wrapped around it, the agent's words, each tool call and its
  result, never its reasoning or its other system steps). A Codex agent's transcript also holds
  the messages other agents sent it, as role `agent` with `author` naming the sender's
  path (`/root`, `/root/<name>`), which the chat shows as its subagents' reports. A call that
  starts a subagent (Claude Code's Task/Agent, Antigravity's `invoke_subagent`; not Codex's
  `spawn_agent`, whose reports come as those messages) has `run.subagent: true`, and the chat
  draws it apart from the commands, with its result as the report. One started in the
  background answers at once with a launch note, whose `outcome.running` is true; its report
  comes later as a second result of the same `call`: Claude Code's task notice (a user record
  or, while a turn runs, a queued attachment), Antigravity's system message that the subagent
  went idle (or failed: `failed` true, as for one killed by `manage_subagents`). The chat
  takes the last result that doesn't say `running` as the report. Nothing is recorded for a
  background subagent when its session exits. A user item marked `interrupted` is where the person
  interrupted the turn: Claude Code's and Codex's records hold their own, and for
  Antigravity, whose record holds none, the runner adds one where an Escape that stood
  came: after the turn's last steps, before the person's next prompt written after the key.
  An item of role `note` is what its harness recorded between turns (`note`): the mode it says
  it's in, each time it says so, a plan approved, or a compaction, whose summary is its `text`.
  What each harness says is in [Harness coverage](harness-coverage.md#what-each-says-between-turns).
  A user item with `ring` is the line Novadeck's doorbell typed, as all three harnesses record
  it: its nonce, and `replies` where it carries the person's Inbox replies. Only a text that is
  exactly such a line has one, so a person's words with a line stuck in them stay theirs, and
  `text` stays as recorded. It comes from the record, so it holds for a session read later.
  The messages themselves come by hook and are no items: a client tells what a ring brought from
  `messages.watch`, by `deliveredAt`, from up to 2 s before the ring's `at` to the same before the
  next prompt's, which is every message of that turn, a tool call's too. Where none match, it
  says nothing of how many there were, as `messages.watch` lists only what the runner keeps.
  It keeps them with the terminal, by the transcript's latest step at the key, so they
  keep their place after a runner restart. Each line's shapes go through its harness's
  lists (`transcripts.shapes`, `harnesses/core/src/shapes.ts`): an
  unknown one inside the conversation (a block of a Claude Code user or assistant message or a
  prompt the person queued mid-turn, a Codex response item, an Antigravity MODEL or USER_EXPLICIT step) leaves a `note` item of type `gap` where it stands, its text the line as written, or none where that line holds the agent's reasoning too, which stays private, and the chat marks the spot;
  other unknown shapes, metadata a harness release adds often, send nothing. The runner
  logs `transcript.unknown` once per unknown shape and harness version per runner
  (metadata up to 16 a version, a conversational shape always), with the harness, its version, the shape's key (a tag's name left out) and
  whether it is inside the conversation, never the line. The runner reads no further ahead than it has sent, but a remote client's own
  pace is not tracked: a large record on a slow link fills the socket's buffer like any
  other output.
  An actor the terminal's session does not have, or without a transcript Novadeck reads,
  is `NOT_FOUND`; the stream ends when the terminal's agent leaves that session. The
  client's `agents.transcript(terminalId, actor)` resubscribes across reconnections,
  yielding `reset` before the items follow again, and ends without one when the actor
  is gone.
  A user item whose prompt carried images lists them as `images`, in the order of the
  `[Image #N]` places in its text: for each, `offset` (where the line that holds it ends in
  the record, in bytes), `index` (which of that line's images it is) and `mime` where the
  record says one. They carry no bytes and no path. All three harnesses list them, each from
  its own record: Claude Code's `image` blocks of a user message or of a prompt queued into a
  running turn (inline base64; the `isMeta` record that follows with the file's path is not
  read), Codex's `input_image` parts (inline `data:` URLs, between the tags that name the
  file), and Antigravity's `media` (from 1.4.9, listing the copy saved under the
  conversation's `.user_uploaded`). An Antigravity of 1.4.3 and before keeps the path in the
  words and lists no image, and an image the record holds some other way (a URL) is none.
- `agents.transcriptImage({ terminalId, offset, index })` answers a listed image as `{ state:
  "ready", mime, src }`, `src` a data URL of a PNG, JPEG, GIF or WebP of at most 8 MiB, or
  `{ state: "unavailable", reason }`: `gone` (the file is no longer there or isn't in the
  session's uploads), `too-large`, or `unreadable` (not one of those formats by its first
  bytes, not a plain file, or a file that may hold secrets, as `companions.content` reads
  them). The runner finds the picture again itself: it reads the one line of the bound
  session's own transcript that ends at `offset` (never anything the caller names), takes the
  `index`th image its harness reads in it, and for Antigravity's file serves it only if it
  lies, links resolved, under `brain/<session>/.user_uploaded`. The type is the bytes', not the
  record's. A terminal with no bound session, a record gone or rewritten, or a line with no such
  image is `NOT_FOUND`; an unknown terminal is `TERMINAL_NOT_FOUND`. The client's
  `agents.transcriptImage(terminalId, { offset, index })` makes the call.
- `agents.prompt({ terminalId, text, images?, at?, automatic?, along?, ref?, setAside? })` gives the terminal's agent a prompt as the person
  would paste and submit it (`automatic: true` marks a fixed line an Inbox button sends, such as "continue", not words the person wrote: the turn it starts withdraws no ask from the Inbox, see [Agent messaging](agent-messaging.md); a strict-schema field added with the protocol version unchanged, as the repo does while client and runner ship together; `text` is 1 to 16,384 characters; its line breaks, CRLF and a lone CR included, are taken as one line break each and stay
  line breaks in the box). It needs an agent bound, or one showing its own empty prompt
  before its first session binds (Codex before its first prompt), and no request waiting
  on the person, whose dialog would take the text: otherwise `CONFLICT`, as when the
  screen takes no bracketed paste. Text a TUI would read as more than a message is
  refused with `PROMPT_REFUSED` before anything is written, in every harness alike, by one
  rule in the protocol package (`promptRefusal`, judging the text trimmed, as a client sends
  it): a control character in the text as pasted, its ends included (C0 but line feed and
  tab, DEL, C1: an escape would end the paste early and type what follows as keys, a Ctrl-U
  clears the box; line breaks, CRLF and CR alike, and the tab pass); text of nothing but
  white space (an empty message); a leading `/` (a slash command: Codex's "Unrecognized
  command" leaves the draft, a known one runs); a leading `!` with nothing after it (a text
  that starts with `!` is a shell command, below); an `@name` at the very end (Codex's file
  picker stays open and its Enter picks a file; a trailing space or line break closes it,
  but the trimmed text is judged); a lone `$` or a `$name` starting with an ASCII letter or
  `_` at the very end, whatever follows in the name (Codex's skill picker, whose Enter turned
  `look at $skill` into `look at $skill-creator`, and also took `$pdf2`, `$s3-upload`,
  `$a.b` and `$ns:skill`; `$5`, `$1.50`, `$-` and `$é` are no skill), in a shell command too:
  Codex's pickers open in its shell mode (`echo @` took a file, `echo $` a skill). An `@`
  inside the text (`a@b.co`, `@README.md what is this`), and a leading `#`, `&` or `?`, go
  through as text in all three (probed). `promptRefusal` is the rule a client may use to
  warn first. CRLF and CR are line feeds, and the white space around the text is not sent.
  The words that follow an answer as a prompt are judged by the same rule before any key of
  the answer is pressed, with `!` still refused there: words after an answer are a message,
  never a shell command.

  The runner holds the person's keys and reads the agent's input box off its screen,
  through the harness's adapter (`harnesses/*/src/box.ts`, which knows how that harness draws it,
  which of its text is a faint suggestion, not the person's, and whether it is in its shell
  mode): where the box is not on the screen, or a view, menu or dialog covers it, the call is a
  `CONFLICT` that wrote nothing. It waits up to 3 s for the box to read empty and in its
  prompt mode (the TUI may be clearing the text of the prompt just sent before, or leaving
  its shell mode after a command's Enter). Whatever the box still holds then is seen to as
  "A box that isn't empty" says below. Otherwise it writes the text as one bracketed paste
  and presses Enter once the box holds exactly the text (whitespace aside: the TUI wraps and
  indents it) or, for text a TUI may collapse (several lines, or over 200 characters), only
  the placeholder it shows for it, on two reads running; the words already on the screen
  elsewhere, or a spinner redrawing it, are no matter. A message whose box went into its
  shell mode as it landed gets no Enter (`PROMPT_FAILED`). It checks again that no request
  waits on the person right after the box read empty, and once more once the paste landed:
  with a request waiting then, no Enter is pressed (`PROMPT_FAILED`, the paste a draft), as
  its dialog would take it. It resolves after that Enter. When none of that happens within
  5 s, the call fails with `PROMPT_FAILED`: no Enter is ever pressed after a failed check, so
  what landed stays in the box as a draft. The reader fails closed: the box is read through
  the adapter of the agent admitted, and a screen it is not found on (the agent exited, a
  dialog, a footer saying shell mode over a prompt marker) writes nothing. A text that shows
  whole in a box taller than the screen has no first row to read and would stay as a draft,
  so it is refused first with a `CONFLICT` (nothing written, the message saying to enlarge
  the terminal or shorten the text): its lines, wrapped at word boundaries at the screen's
  columns less the marker's two (tabs spread to multiples of eight columns), plus a row of
  margin, take more rows than the harness leaves for its box; a text the harness certainly
  collapses to a placeholder is not refused. The rows left and the thresholds are each
  harness's own, probed, in `docs/harness-coverage.md` and `harnesses/*/src/box.ts`. A box's own
  lines may be indented, tab and trailing spaces included, and hold blank lines; text is
  compared without its white space, and without the emoji a harness drew blank, unless the
  text is only emoji. The runner's headless terminal counts wide characters (emoji
  sequences, CJK) as a TUI's own do (`@novadeck/emulator/width`), so a redraw erases
  the rows the TUI means. The person's keys are held from before the box is looked at until
  the Enter is out, at most the wait for an empty box, a shell command's switch (up to 5 s), the paste's 5 s and a margin of 2 s.

  `setAside`, which only the person's own Send in a chat gives (an automatic prompt or a
  doorbell ring never does), is the refs of the questions the person saw waiting (1 to 8 of
  `agents.detail`'s `requests[].ref`, `setAsideRefs`). It sends over those questions (Claude
  Code's AskUserQuestion, Codex's request_user_input, Antigravity's ask_question) instead of
  refusing them `pending`: in the prompt's own turn of the terminal's input queue, so nothing
  comes between, they are set aside and the words go. A ref no longer waiting is no matter;
  any request waiting that it doesn't name is still `pending`, so a question that came after
  the person looked is never set aside unseen. Where the words will go as a prompt (`interrupts`), a text the
  box has no room for is refused (`too-tall`) before the question is touched; where they go
  as the question's answer (`skips`) the box isn't used, and the rare fallback below checks
  it only as it gives the prompt, the words coming back. How depends on what the
  harness's Escape does in its question dialog (`MessagingProfile.questionEscape`), never on
  its name, and goes through the answer driver's bookkeeping (the person's keys held, the
  dialog read off a settled screen first, a turn that just put it up given its settle time).
  Where Escape ends the turn there (`interrupts`: Claude Code, Codex), Escape is pressed once,
  the runner waits for the request to leave `pending` (its hook a moment behind the dialog, up
  to 10 s, then a `CONFLICT` `pending`), and the words follow as any prompt, images and all,
  with their receipt: the model's one call holds the dismissed tool and the words. Where it
  only skips the question on screen (`skips`: Antigravity), the words go as the answer to the
  question on screen through its Write-in, as `agents.answer`'s `chat`, the later questions
  skipped: one call, the words in the tool's result, so no prompt is typed and `tracked` is
  false; images there are a `CONFLICT` with reason `question-words-only`, pressing nothing.
  The words must be a message either way (`promptRefusal` without the shell form: a leading
  `!` is `PROMPT_REFUSED`). A request that is no question (an approval, a form, a plan),
  even named, or a question whose dialog isn't read (raw, or one that doesn't read now, as
  Codex's with its notes field open, which is left as it is), is still a `CONFLICT`
  `pending`, pressing nothing. What holds the agent is looked at again right before each key,
  as an approval may come while the runner waits for the screen to settle: one came, and
  nothing more is pressed (`pending`), as Escape would deny it. A question the person
  answered in the terminal as the Send began is gone, and the words go as a plain prompt.
  Escape pressed without the question going is `ANSWER_FAILED`, the dialog turning `raw`; the
  dialog gone but its hook not clearing within 10 s is the `CONFLICT` `pending` above, though
  the Escape went. Where Antigravity's Write-in fails after a key but before the words went in,
  and the request is gone (a key landed on an option, answering it), the words follow as a
  prompt, never lost and never twice. Measured with the fake model, a Send right after the question showed took about
  1.1 to 1.3 s in all three, most of it the wait for the turn that put the question up to
  settle (1 s from its start); later it is a few hundred milliseconds.

  `images` (1 to 8 paths, `maxPromptImages`) hands the agent pictures the chat holds, which
  `terminals.upload` saved on this runner: an image file (PNG, JPEG, GIF or WebP) in an upload's
  folder, or the call is `PROMPT_REFUSED` before any key, so a client can't have the runner
  paste any other path. `text` may then be empty, though not for Antigravity, whose Enter
  sends nothing for images alone (`PROMPT_REFUSED`). A shell command takes no images, and
  the box must be empty, whatever `along` says (a draft is the usual `CONFLICT`). The runner pastes
  each path as a bracketed paste of its own, all three harnesses reading a path pasted alone as an
  image file (Claude Code and Codex as `[Image #N]` at the start of the box, Antigravity as a
  `📎 N media attached` row above it), and waits, within 5 s each, for the box to show the
  image before the next goes in; then the text follows on the same line, led by a space, and
  Enter. The path is written as a shell reads it as one word (a backslash before each space and
  special character, a Windows path with a space in double quotes: probed on Linux with all three,
  where Codex and Antigravity leave a bare path with a space as text), as the uploads
  folder may hold spaces (`Application Support` on macOS, a Windows profile name). An image
  that never shows is `PROMPT_FAILED` with data `{ reason: "image-not-shown" }`, writing no Enter and taking back what landed by
  the harness's own keys (Ctrl-U in a box of placeholders; Antigravity's Escape, only at its idle
  prompt, as it stops a running turn otherwise). A prompt of images alone has a receipt like any other, settled by a record item of nothing but
  its images' placeholders (Claude Code and Codex; Antigravity takes none alone).
  Images attached in Antigravity already (pasted in its terminal and not sent) count as a draft:
  the usual `CONFLICT`, nothing typed.

  `at` (one offset into `text` per image, in UTF-16 units, none before the one ahead of it, none
  past the end: else the call is invalid, `placesFit`) puts each image where the person put it
  among the words, not all ahead of them. Absent, or with every offset 0, everything above stands
  unchanged. Otherwise the runner pastes in order the words before the first image, the image
  (waited for as above), the words up to the next, and so on, each run of words a paste of its
  own (an empty run is none; the text's edges are trimmed as for any prompt, an image that stood
  in the trimmed white space going to the edge; an image left of any words keeps the one space
  after it that images ahead of the words always had), then Enter. Claude Code and Codex put
  `[Image #N]` at the cursor, so the box, the model's turn and the record read `See this:
  [Image #1] and fix it` (Codex keeps a space of its own after a placeholder). Antigravity
  attaches the image but shows no placeholder at its place (probed 2026-11-09, 1.5.2), so the
  runner types `[Image #k]` itself after each image (`k` counting from 1 in this message),
  from the harness's own profile (`ProfileImages.typed`, `harnesses/agy`); the model and the
  record then read the same, and a prompt with its images all ahead of the words (`at` absent
  or all 0) types nothing. The refusals judge the whole text as before, and also each run of
  words before an image: one ending in an `@name` or `$name` that a space doesn't close (the
  image's path would be pasted into an open picker) is `PROMPT_REFUSED`. A run of words that a
  harness would show as a placeholder (Claude Code over three lines or about 900 characters,
  Codex over 1,024, Antigravity over 15 lines) can't be checked in the box, so the prompt goes as
  if `at` were absent: every image first, then the words, nothing typed for Antigravity, the
  receipt and a later Stop treating it as a leading one; only the placement is lost. The same goes for Codex on Windows, which reads a paste as keys, so a path pasted after words stays text there (CI, 2026-11-09, `BoxProfile.pastesAsKeys`): any prompt with `at` goes images first. A failure takes back what landed, the words ahead of an image too. The
  receipt settles on a record item that holds the prompt's words whatever the placeholders and
  their spacing are.

  When a Stop (`agents.interrupt`) or `agents.takeBox` takes a message with images out of the
  box, where Claude Code and Codex show `[Image #N]` placeholders ahead of the words, the
  placeholders are left out of `returned` (null for a message of images alone) and the files they
  came from are answered as `images`, the paths of the prompts' `images` the box held exactly,
  as the client named them (not their real paths), absent for none. The box is the chat's own
  only when its placeholders are as many as the images of the latest prompts waiting in it (a
  Stop's queued ones, which it moved there, or those back in it) and the words after them are
  exactly those prompts' words. A box that holds more, an image the person pasted in the terminal
  view or words they typed, is `BOX_NOT_CLEARED` for a Stop and untouched by `takeBox`, and no
  prompt of the chat is withdrawn for it. Antigravity loses a queued message's media as a Stop
  takes the words back, so there `images` names the files of the prompts whose words came back
  exactly.

  With images among the words (`at` on the prompt), the placeholders stand in the box where the
  images were put, and the box is the chat's own only when they stand in those places (counted in
  characters of the words before them, white space aside, so Codex's extra space is no
  difference), as many as the prompts carried, over exactly the prompts' words; a placeholder
  elsewhere, one more or fewer, or other words is not. Then `returned` is the prompts' own text
  (as sent: queued prompts joined by a line break), not the box's, and `at` says where each of
  `images` stood in it (absent when they all led, and for a box that is not the chat's own, whose
  `returned` is the box's words with the placeholders left out and no `images`). For Antigravity,
  the `[Image #k]` the runner typed is the same text in the same places; if it is not there,
  its words alone decide, and `at` is the one sent.

  A text whose trimmed form starts with `!` is a shell command (`shellCommand`, the rest
  after the `!`, trimmed), which Claude Code, Codex and Antigravity run in their shell mode
  (Claude Code then makes a model call with its output in context; Codex and Antigravity
  none): the transcript holds Claude Code's `<bash-input>` items, Codex's
  `<user_shell_command>` items, and nothing for Antigravity. The runner types the `!` as a
  key (Antigravity sends a pasted `!cmd` whole to the model as a prompt; only the key enters
  its shell mode), waits for the box to read in its shell mode and empty, on two reads
  running (the box's marker turns to `!`, and the harness's footer agrees: "! for shell
  mode", "Shell mode", "activated bash mode"), then checks again that no request waits, and
  pastes the command as above, its line breaks as returns (multi-line commands run in all
  three while shown in full), and presses Enter once the box, in its shell mode, holds
  exactly the command. A command the TUI collapses to a placeholder is taken as any
  collapsed text is only where its shell mode runs what the placeholder stands for
  (`BoxProfile.shell.expands`: Claude Code and Codex ran 1,500-character and 16-line
  commands so); Antigravity runs the placeholder's own text (`[Pasted text #1 +16 lines]:
  command not found`, from somewhere between 900 and 1,500 characters, or 8 and 16 lines),
  so there no Enter is pressed (`PROMPT_FAILED`, the command left unsent in its box). Given
  while the agent works: Claude Code and Antigravity queue the command and run it after the
  turn; Codex runs it at once, no model call. Where the `!` never switched the box in time
  (`PROMPT_FAILED`), or a request came before the command's paste (`CONFLICT`), a Backspace
  takes the `!` back out where the box reads in its shell mode and empty, which leaves the
  mode in all three, idle or mid-turn.

  Everything that puts keys in one terminal's agent box takes its turn in that terminal's
  input queue (`InputQueue` in `@novadeck/tui-input`), one entry at a time, in the order it came:
  prompts, answers (an answer and the words that follow it are one entry), interrupts and
  the messaging doorbell's rings. So a prompt given while an answer to a request goes
  there waits for it and the words that follow it, and a ring never comes between them;
  terminals' queues don't wait for each other. The agent and the pending request are
  looked at in the prompt's turn, not when it is called: only the text's shape
  (`PROMPT_REFUSED`) is refused at once, so a prompt given during an answer is not refused
  for the request that answer is for. The typing itself is `Prompts` and `Interrupts` of
  `@novadeck/tui-input`; the runner's `terminals/prompting.ts` gives them `promptRefusal` as the
  rule for the text and turns what they refuse into the errors named here. A prompt that meets a doorbell ring
  whose prompt is yet to confirm it waits for it, up to 10 s (`CONFLICT` after). Both keys go through the bookkeeping the
  person's own do (`Terminals.keyed`): what messaging and the doorbell see of the box and
  its Enter, the person's prompt attributed from the harness's transcript. A prompt given while the agent works behaves as typing it
  would: Claude Code and Antigravity queue it (their box shows "Press up to edit queued
  messages") and run it as its own turn once the turn ends; Codex shows it as "Messages to
  be submitted after next tool call", submitting it into the running turn then, or at its
  end when no tool follows, or, for one right behind the prompt starting the turn, under
  "Queued follow-up inputs", waiting for the turn to end. Each shows up as a separate user item in the transcript. The
  window's resizes are held until a second after the Enter; the next entry of the queue takes
  them over and keeps that deadline, so one that is refused at once lets none go earlier. The
  client's `agents.prompt(terminalId, text, { automatic?, ref? })` is that call.

  It resolves with `{ ref, tracked, returned }`: the ref of the prompt's receipt (the `ref`
  given, 16 letters, digits, `_` or `-`, which a client picks so its own copy of the prompt
  has the same key from the start; one the terminal's receipts already hold is a `CONFLICT`
  writing nothing; the runner's own without one), whether a receipt follows it, and the words
  it took out of the agent's box to go, for the client's draft, null for none.

  **A box that isn't empty** (`libraries/tui-input/src/box/leftover.ts`,
  `Prompts.room`) never sends the person to the terminal where the screen shows it needn't,
  for a call with `along`: the chat's own send while it shows, whose person can see the box.
  Without `along`
  a box that isn't empty is a `CONFLICT` writing nothing (`draft`, or `shell`): an Inbox line,
  fixed or typed, and the words that follow an answer, are sent where the box can't be seen.
  What the box holds is read through the adapter, and each step goes once and is read back;
  a step that doesn't confirm ends in the next one down, or a refusal with a reason, never
  the same keys again. Each fallback and refusal logs `chat.box` as a warning, with the
  harness and its version and no words, so a harness that changed shows up there. What the
  box holds is also in `agents.detail`'s `box`, so a client can show it before anything goes
  with it (`agentBox`): its `text`, `mode`, `tail` where the box may hold more than it shows, as tall as it gets or saying so, so that
  may be only the end of it, and `known`. It is null for an empty box, no box, an empty shell
  mode, or a line a ring left (below), read as the screen changes while a client reads the
  detail, throttled, and never for one nobody reads.
  - **Text goes along.** The cursor goes after the text first, as a paste lands at the
    cursor: Down to the box's last row, exactly so far, as Down past it recalls history, then
    End. Where it can't be seen there, or the box may be showing a tail it scrolled in, the call
    is a `CONFLICT` (`draft`) with nothing pasted. A cursor far past the text's end is none in
    the box at all (a menu that reads as one parks it there). In a box that may show a tail, a
    cursor on the end of the last row shown can't be told from the text's end, so a person who
    scrolled up inside so tall a draft gets the message at the cursor, both still sent. The paste leads with a blank line, which
    keeps the prompt's lines its own, so its receipt settles against the record's merged item,
    and closes a picker the text holds open, whose Enter would pick from it (Codex and
    Antigravity did). Where a paste is keys (`pastesAsKeys`, Codex on Windows, which reads the
    console's), a line break is an Enter unless it comes in what the program takes for a burst of
    typing: one leading the paste submitted the box and left the prompt behind. So a space sets
    the prompt apart there, the record told it shares a line, and a prompt of several lines
    with a first line under 16 characters is a `CONFLICT` (`draft`), written nowhere. Enter goes once the box holds the text and then the prompt, or the
    prompt's placeholder, or in a box as tall as it gets the prompt's tail, or in a box that
    says it is cut (Antigravity's `cut`) the end of what it held and then the prompt.
  - **What is Novadeck's goes back.** Where all the box holds is prompts whose receipts are
    `in-box` (`known`), unless it is a `tail`, it is erased first and handed back as `returned`, its receipts
    `withdrawn`. The keys are the adapter's `erase`: Ctrl-U from the last row up, Backspace
    between rows, which unlike Escape or Ctrl-C stops no running turn, on every harness.
    Where the box doesn't read empty after them it goes along as text; where what's left
    is no longer what the box held, it is a `CONFLICT` (`draft`) that carries what they took in
    its data as `returned`, as any failure after words came out does, `PROMPT_FAILED` too, for the
    client's draft. A Stop that couldn't take queued words out (`BOX_NOT_CLEARED`) marks their
    receipts `in-box` at once.
  - **Shell mode is left.** A box in its shell mode would run any text as a command. Empty, a
    Backspace leaves it; holding a command, the same keys as erasing and a Backspace, and the
    command goes back as `returned`, with its `!`. One that shows only as a placeholder or a
    tail can't go back, so it stays, and the call is a `CONFLICT` (`shell`).
  - **What stays refused**, writing nothing, until the person clears it (`agents.clearBox`, under
    "One input"): a box leading with `/` or `!`, which its program
    would run with the prompt as arguments (`command`); no box, or something over it (`no-box`);
    a shell command over text that isn't Novadeck's, which can't go along (`draft`); and a
    line a ring left, which is the doorbell's to finish (`ringing`, to try again, as the chat does
    by itself: its queue holds a message while a ring is under way and after this refusal, for up
    to a minute, and only then says so). A first line
    that a tail or a cut box doesn't show can't be read, so such a box goes along as text.

  **One input.** While a terminal shows as chat, its terminal inert beneath it, the person
  writes in one place: `agents.takeBox` hands what the agent's box holds to the client's draft,
  and `agents.putBox` hands a draft back as the terminal shows again (`Handovers`, in
  `libraries/tui-input`). Each takes its turn in the terminal's input queue, so neither races
  a ring or a prompt, and neither presses Enter.
  - `agents.takeBox({ terminalId })` resolves with `{ returned, images?, at? }`, the words as typed: rows
    the box wrapped joined again (a row the next one's first word wouldn't have fit on, and
    one filled by a single word mid-word), and a shell mode's command with its `!`. It takes only
    what reads whole: not a box that may show a tail, nor one holding a paste's placeholder or
    an image (`BoxProfile.stands`), and only once the box read the same twice, 300 ms apart,
    and any text of a prompt just sent had the time to clear. With the cursor after the
    text, the adapter's `erase` (or `shell.leave`) goes once, and must read empty; otherwise
    `returned` is null and the box stays as it is, or as the keys left it, showing in `box`,
    which send-along then takes care of. A box holding a command of the program's (a leading
    `/`) stays too: the chat could neither send that nor put it back. The client doesn't take
    a shell command beside a message in its draft, or a message beside a command. Any of it
    shows in `box`, and the client shows it, as what the next message goes out with. Keys that took some of it, or took late, still give what
    they took, which is in the box no longer, what's left there being taken after it. A ring's line is never taken, with words beside it or
    not, and an empty shell mode is left as it is. A prompt Novadeck knows comes back as given.
  - `agents.putBox({ terminalId, text })` resolves with `{ placed }`. It pastes the draft with
    no Enter, a leading `!` typed as a key first, so it lands in the box's shell mode on every
    harness (pasted, Antigravity takes it as text). `placed` is false, with nothing typed, where
    the box isn't empty, or the text has a shape `promptRefusal` refuses: a leading `/`, or a
    trailing `@name` or `$name`, whose picker would open there and take the next Enter, or a
    command long enough for a placeholder where the harness's shell mode would run that as
    text (Antigravity), or text whose first line break would be an Enter (above). It is false too where the words never showed, a `!` that was typed taken
    back out. The client keeps its draft unless it is true.

  - `agents.clearBox({ terminalId, seen })` resolves with `{ cleared }`. It is the person's own
    call, from a button on the box's note, for what the two above leave: a command, a placeholder,
    a tail, a shell mode's command. It empties the box of any of it, leaves the shell mode, and
    the words are gone for good. `seen` is the `text` of `box` they were shown: a box that reads
    otherwise is left, with nothing written. The adapter's `erase` (or `shell.leave`) goes once,
    with the cursor after the text, and the box is read once. On a tail the keys go for 256 rows
    in that one write, as what it hides can't be counted, and a longer text shows a tail again,
    for another click. `cleared` is false where it didn't read empty, or there was no box, and
    the box stays as it was or as the keys left it, as it does for a tail with the cursor moved
    up, whose end can't be told, or a box longer than `box.text` can show. Of a tail only what
    shows can be compared, with any row saying how much it hides, so one stays while a prompt
    waits on the record or is back in the box, as a Stop can put prompts back over it. Prompts
    whose words went, all of them or as far as the keys got, are withdrawn. A
    doorbell line beside the person's text goes with it, seen in the note, and the doorbell rings
    again once the box is empty.

  All of them hold the person's keys for as long as they take: 0.3 s, as long as what a prompt just sent
  may still show (3 s), and up to 2 s for each of two keys that don't confirm, within a safety
  cap of 16 s. A take waits up to 10 s for a ring under way first, outside the queue. There is
  no per-client guard: a second client on one runner, as two `dev:web` tabs, could take what the
  person types in the other's terminal view. The desktop app has one window, and a terminal
  shows in one place.

  Every refusal and every step logs `chat.box`, a warning for what it left undone, with the reason, the harness
  and its version, never the words.

  **Prompt receipts.** The runner follows each prompt until the agent's own record holds it,
  so the chat can show it until then and say when it never came, the same in every window
  and after a reload (`terminals/receipts.ts`). It reads the root's transcript from its
  start with the harness's own decoder, the one `agents.transcript` serves, so a prompt a
  decoder drops is missing here as it is in the chat. `tracked` is false for a shell command,
  on every harness (Codex records one only once it has run, however long that takes, with
  no turn to say it runs; Antigravity keeps no record of one), and where no agent shows in
  the terminal. A prompt given an agent at its own prompt before its first session binds,
  as Codex's and Antigravity's first prompt is (their session binds at that prompt's hook),
  is followed too: once the session binds, its record is read for it, an item recorded in
  the second the prompt was given or later being new to it (harnesses record whole seconds
  at the coarsest); a session that never binds makes it missing at the Enter plus the wait
  below. A receipt (`promptReceipt`, up to 8 per session in `agents.detail`, the oldest
  settled or withdrawn going first) is:
  - `pending` from the Enter (`sentAt`) until a user item the transcript gained after the
    prompt was given holds its words: both sides with line breaks as line feeds, doorbell
    and Inbox reply lines taken out; its lines
    a run of the item's lines, white space at each line's ends aside. One item settles
    several prompts, in the order they were given, as Antigravity joins prompts queued
    behind a turn into one input; a prompt not found doesn't hold back one after it;
  - `settled`, with `item`, that item's index in `agents.transcript` (counting the
    interruptions the runner joins to Antigravity's), and its `text` null;
  - `unrecorded` once the agent has been idle for the doorbell's confirmation wait
    (`confirmMs`: 5 s, plus the hook shell's slack on Windows) since the later of the Enter
    and its latest turn's end, and the transcript was read to its end after that, with
    the words not there. A turn that runs puts it off, so a prompt the harness takes into
    the running turn (Codex steers it, Claude Code takes it beside a tool's result) or runs
    as the next turn (Claude Code's and Antigravity's queue) has that turn to show. The
    runner logs `chat.unrecorded` once for it, with the harness and its version, never the
    words;
  - `in-box` instead, where the agent's box holds the words when that is decided, as an
    Escape in the terminal puts queued words back: not logged, as no decoder missed it;
  - `withdrawn` once an `agents.interrupt` handed the words back (`returned`), a pending
    receipt's or one back in the box.
    A transcript that holds the words within 10 minutes of a receipt turning `unrecorded` or
    `in-box` still settles it; past that it is read for it no more. A new session starts the
    receipts over; they are kept in memory only. `prompts` is optional in the schema, as a
    runner from before receipts sends none; a client reads its absence as none.

- A request's `dialog` in `agents.detail` is what its harness's adapter (`harnesses/<harness>/src/dialogs.ts`,
  the only code that knows how a harness draws its dialogs) read from the terminal's
  screen, so it can be answered (`agents.answer`): `choices` (a permission's or a plan's
  options, each with an id, its label and whether it takes the person's words: typed
  into the dialog's field, `field`, or sent as the agent's next prompt once chosen,
  `prompt`), `questions` (each with its options, whether several may be picked and
  whether it takes the person's words), or `raw`, the screen's text for the person to read
  and answer in the terminal, with a `reason`: `unrecognized` (the screen has settled and
  the adapter reads none of the requests waiting as its dialog, as after an update changed
  the TUI), `unsupported` (the request's harness has no adapter) or `failed` (an answer
  was pressed and the dialog didn't go as expected). It is null until the dialog shows.
  Each request also has `answered`: true once `agents.answer` succeeded for it, until the request
  leaves pending (its hooks or records settled it); false otherwise, also where the runner leaves it
  open for the same dialog showing again at once. An answer to an answered request is a `CONFLICT`.
  The runner looks at the screen again as it changes while a request waits, at most every
  100 ms, and sends a snapshot only when a dialog changed. A request whose dialog is
  not the one on screen (another's, as with parallel calls) stays null until it is. The
  raw text is the screen's rows without trailing blanks, from the bottom up while they fit
  in 4 KiB, a run of blank rows made one. A request the screen alone tells (Codex's
  "Implement this plan?" and Antigravity's plan for review, which fire no hook) is a
  request like any other: the adapter's `screenRequest` raises it while its screen shows,
  and it goes once the screen has been still for 500 ms without it, or the turn moves on,
  or it was answered.
- A `choices` or `questions` dialog carries an `id`, a fingerprint (a hash) of what the adapter
  read, and a `choices` dialog a `detail`: what the dialog shows of what it asks about (the
  command, the tool's arguments, the permission, the file), as the terminal draws it. An
  answer names the dialog it answers by that `id` (`dialog`), so the keys it takes are the
  ones the person saw.
- `agents.answer({ terminalId, request, answer })` answers a request through its dialog
  as the person would with its keys. `request` is its ref from `agents.detail`; `answer`
  names the dialog it answers by its `id` (`dialog`) and is one of:
  - `{ type: "choice", dialog, option, text? }`: an option of `choices` by its id, with
    words for an option that takes them;
  - `{ type: "questions", dialog, answers: [{ question, options, text? }] }`: per question,
    by ids, the options picked and/or the person's own words;
  - `{ type: "chat", dialog, text? }`: a `questions` dialog whose `chat` is not null set
    aside to talk it over, its words sent as the agent's next prompt (`prompt`) or typed
    into the dialog's field (`field`, where they are needed);
  - `{ type: "form", dialog, action: "accept", values }` (a value per field id, at most 16)
    or `{ type: "form", dialog, action: "decline" }` for an MCP server's form.

  It guarantees that nothing is pressed unless the dialog on screen, read once more right
  before the first key, is the one the answer names; that what the person typed meanwhile
  is dropped, never replayed after; that the runner never presses again for a request
  whose answer failed (its dialog turns `raw`, `failed`); and that the answer, with any
  words that follow it as the agent's next prompt (a `prompt` option's or a `chat`'s), takes
  one turn in the terminal's input queue, so nothing else is typed between them (see
  `agents.prompt`). Where the option chosen sends words as the agent's next prompt, they are
  given once the dialog took its key. Its keys go through the bookkeeping the person's own
  do, but messaging takes them as Novadeck's: they leave no draft in the agent's box, so
  the next message rings once the turn ends (docs/agent-messaging.md, "What counts").
  Errors:
  - `NOT_FOUND`: the agent has no such request.
  - `DIALOG_CHANGED`: the screen no longer reads with the answer's `dialog`; nothing is
    pressed or locked, and the next `agents.detail` has the new read.
  - `CONFLICT`: nothing pressed. The dialog isn't on screen, isn't recognised as the
    request's, or reads for another request too; the dialog can't take that answer; words
    hold control characters (other than tab and line breaks, CRLF and CR among them); the
    request was answered or turned raw already; the harness has no adapter; the waits
    outlast what the keys can be held for; or a doorbell ring awaiting confirmation
    outlasts 10 s (`ringing`, its only `reason`: see the errors below). A dialog that isn't
    on screen, or isn't recognised as the request's, turns the request's dialog `raw`,
    `unrecognized`, if one had shown; one dialog reading for more than one request makes
    each of them show `raw`, answerable through none. A failure before any key was pressed
    (the screen never showed what the first move needs, the request no longer waiting) is
    a `CONFLICT` too, and locks the request `raw`, `unrecognized` as well. After any lock
    the runner never presses for the request again. An answer to a request that shows
    `raw` without a lock (the screen reads as nothing now) is a `CONFLICT` that locks
    nothing.
  - `PROMPT_REFUSED`: words that follow as a prompt are ones `agents.prompt` refuses,
    judged before any key.
  - `ANSWER_FAILED`: keys were pressed and the dialog didn't go as expected, or the screen
    never showed what the next move needs; the request's dialog turns `raw`, `failed`.
  - `WORDS_NOT_SENT`: the dialog was answered, but the words that follow it did not reach
    the agent (they may sit in its input box as a draft).

  How the runner reads the dialog, presses its keys and confirms it went is in
  [Harness adapters, Answer driver](harness-adapters.md#answer-driver). The client's
  `agents.answer(terminalId, request, answer)` is that call.

- `agents.interrupt({ terminalId, setAside? })` presses Escape in the terminal's agent, which stops
  its turn in every harness, after up to 5 s where Claude Code's queued messages are still
  in their prompt hooks (the turn ends without a normal Stop: its activity is
  `unknown` until the next prompt, see `agent-messaging.md`, and the agent's `lastTurn`
  reads `interrupted`; `lastTurn` also tells a failed turn's `error` as its harness said it,
  the usage-limit window the turn ran into as `limit` (`minutes`, `resetsAt`; kept for that
  end only when its harness said the turn failed on a limit; its records within a minute of
  the end only tell when it resets, the window used up that resets last, else the most used), and the absolute paths its write and edit tools wrote as
  `files`, at most 16, first written first, each once, root and subagents, those told after
  the turn's Stop included). The harness has the last word: one that had the model's reply
  before it took the key finishes the turn all the same, and the turn's `lastTurn` then
  reads `completed` with that reply, as for any finished turn, once the harness has said
  so (at once for Antigravity's Stop or a record of the finish, else about 1.5 s after the
  key at most; see `agent-messaging.md`). `CONFLICT` (`no-agent`)
  without an agent bound or showing its own prompt, or (`pending`) with one that waits on
  the person's answer to a request. It presses the key only while the agent's activity
  is `working`; otherwise it resolves having sent nothing, as the turn is already over (a
  Stop clicked as the turn ends, or a second one), since Escape at an idle prompt does
  nothing the chat wants and two of them open Claude Code's rewind picker. It takes its
  turn in the terminal's input queue, so its Escape never cuts into a prompt's paste, an
  answer's keys or a ring's test paste; those of one terminal are each given a second
  after the one before to show its turn ended before the next looks at the activity, so a
  double Stop sends one Escape. It goes through the person's key bookkeeping too:
  the turn ends as an Escape of theirs ends it. The harness takes the key a moment later.
  Claude Code puts a prompt interrupted before any reply back in its box as a draft (Codex
  and Antigravity leave it echoed above their box, which stays empty; probed); the runner
  leaves the box as it was before the turn's prompt. Where the box read empty before the
  Escape, it looks up to 2 s at the box through the harness's adapter, and when the box
  holds exactly the turn's prompt as its hooks told it (Claude Code puts a long one back
  as its text, never as a placeholder; probed), or, in Claude Code's, a box as tall as its
  screen lets it be (the harness's `viewport`; none is taken for full on a screen too small
  to know it) whose text ends with the turn's prompt, as only the tail of a prompt taller
  than that shows, steady on two reads, it writes the adapter's clear keys, a double Escape for
  Claude Code (never pressed over an empty box, where it opens Claude Code's rewind
  picker, nor over text the person had typed or merged in, which is left). A harness
  without clear keys has nothing pressed.

  Messages the person queued behind the turn (a prompt given mid-turn) are not lost. It
  looks at the screen before the Escape for the harness's own sign of queued messages
  (`BoxProfile.queued`), and what comes of the Escape then is each harness's, probed
  (`harness-coverage.md`): Antigravity stops the turn and puts the queued messages back in
  its box, one to a line; Claude Code stops the turn and sends the queued messages as the
  next turn, which the runner stops with a second Escape, and Claude Code then puts them
  back in its box; Codex sends them as a steer, which a second Escape stops, and its box
  stays empty (what an Escape does to its "Queued follow-up inputs" is unprobed). Whatever the box then holds, steady, which was empty before the Escape, is
  the queued words: the runner writes the adapter's clear keys (Ctrl-U and Backspace per
  line for Antigravity, a double Escape for Claude Code), looks that the box reads empty,
  and gives the words as `returned`. The call resolves with `{ returned: string | null }`
  (`InterruptResult`): the words with line breaks as line feeds, for the chat to put back
  in the person's draft; `null` when there were none, and always for Codex. It fails
  closed: where the box holds text that can't be cleared and seen empty, that is only a
  placeholder standing for the words (clearing it would lose them), may hold more than it
  shows (messages queued in a box as tall as its viewport, or one that says it is cut), or
  can't be read, after the Escape stopped the turn, it rejects with `BOX_NOT_CLEARED` and
  leaves the box as it is, for the next prompt to see to where it can ("A box that isn't empty"), and otherwise for the terminal.
  `returned` leaves out Novadeck's own doorbell and reply lines. The call takes up to about half a
  second longer where nothing comes back, and a few seconds more with queued messages. The
  client's `agents.interrupt(terminalId)` is that call, and resolves with the result.

  `setAside`, only the person's own Stop in a chat, names the questions the person saw, as
  `agents.prompt`'s does, and stops over them instead of refusing them `pending`, in the
  Stop's own turn of the input queue:
  Escape is pressed in the question's dialog, once where it ends the turn (Claude Code,
  Codex), else once per question until the request is gone (Antigravity, whose Escape skips
  one question a press, the tool returning "User Skipped" and the turn going on). Where that
  Escape ended the turn, the Stop waits up to 1.5 s for the activity to say so (its hooks did
  within 0.1 s) and then presses nothing more, so no second Escape opens Claude Code's rewind
  picker; where the turn goes on, the Stop ends it as above. It resolves with nothing
  `returned`. The refusals are `agents.prompt`'s with `setAside`.

- `history.*` lists the terminals closed in the last 7 days, per project, which
  `terminals.create({ closed })` restores. A row has the id its terminal had, its project,
  title, summary, handle (null if none), `agent` (the program's icon; null for a plain
  terminal, whose last `program` stands in), `cwd`, `closedAt`, `closedBy` (the handle of
  the agent that closed it; null when the person did, or an agent closed its own terminal) and its `availability`: `ready`,
  `restoring`, `gone` (`conversation` or `folder`), `disconnected` (the agent) or `open` (the
  handle of the terminal the conversation is bound in). The runner keeps rows in
  `closed_terminals`; a plain terminal's saved output is the one heavy column, which neither
  call carries. A row is kept 7 days from `closedAt`: the runner deletes older ones as it
  starts and every hour after, through the store's `forget` (so `secure_delete` and the scrub
  apply), and watchers receive `removed`. A plain terminal's row reads `restoring` until its
  saved output is written. One conversation has one row: closing a terminal replaces an
  older row of the same agent session.
  - `history.list({ projectId })` answers the project's rows, newest first; a project with
    none, or one the runner doesn't have, answers none.
  - `history.watch()` streams every row across projects, `synced`, then `changed` (a close, or a
    change of availability) and `removed` (a restored or pruned row). The client's
    `history.watch()` yields `reset` before each fresh sequence, as `terminals.watch()` does.
  - `terminals.create({ id, sessionId, cols, rows, closed })` restores row `closed` as the
    new terminal `id`, with nothing else to say. An unknown row is `NOT_FOUND`; one that can't
    be restored now is `CONFLICT`.
  - `TerminalSummary` carries `restorable` (closing it can be undone) and `busy` (a program runs
    in its shell besides the prompt); an absent one reads as false.
  - `TerminalSummary.shellCommand` is `{ command, since }` while a command the person ran in
    their agent's own shell mode (`!sleep 15`) runs, and null otherwise: `command` is the box's
    text at the Enter, `since` that Enter in epoch milliseconds. No hook tells of it, so the
    runner finds its process under the terminal's shell; it is no turn, and `activity` is
    unchanged by it. It clears when the process ends, when the system can't tell for about
    five seconds, and when the agent leaves or the terminal exits, restarts or rests. The agents
    listing counts it as working. The field may be absent, which reads as null.

- `companions.*` keeps what agents show and the person attaches beside terminals: items,
  each a pointer to a file, a page or a plan, never a copy of it, held by exactly one
  terminal's bar, one undocked window, or the session's project window. Items and windows
  live in the runner's database, so they survive restarts; an item goes when it is closed,
  with the terminal whose bar holds it, or with its session, and a window goes with its
  item. Nothing caps how many there are. An item has a runner-issued id, its `kind`
  (`image`, `file`, `page`, `changes`, `plan`), a name and a one-line `detail`, its `path`
  or `url`, the `lines` it points at, `secret` for a file that may hold secrets, `by`
  (`agent` or `person`), `from` (the terminal and handle it was shown in; null in a
  project window), `version` (counts its shows), `openAsked` (the latest show asked to open
  it), `shownAt`, and for a plan its agent, its actor's role and whether it is a file or
  text.
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
  - `companions.content({ itemId, reveal? })`, `reveal` being a path, streams what an item points at, read from
    disk now and again each time it changes, until the item is deleted; an unknown item
    is `NOT_FOUND`. It is `ready`, with a `stamp` that changes with it, or `unavailable`
    with a reason and the file's size where known: `missing`, `unreadable`, `not-a-file`,
    `too-large` (an image over 8 MiB), `binary` (a NUL byte in its first 8 KiB), `secret`
    (a file that may hold secrets, unless `reveal` is the path the item points at: the
    person's yes is to a file, so an item re-pointed to another reads `secret` again and, pointed
    back, revealed again), or `gone` (a plan no longer there).
    An image is a data URL; a page its address, which the desktop app loads live, with
    `shown`, its item's version, which each show raises and which loads it afresh, and the
    `scroll` that show gave, a CSS selector to bring into view once it has loaded. A text
    file is the lines around those pointed at, read to the last of them and up to 4 MiB
    more to count the rest: `total` once it reached the file's end, else `truncated`;
    lines past the end are pulled back to it and marked `clamped`. A plan is its text, cut
    short past 256 KiB (`truncated`), with `writable` (a plan in a file that is not cut
    short, which `companions.save` can write) and `skill` (Novadeck's plugin is installed
    for its agent). A `changes` item is a checkout measured against its repository's main
    branch (`base` names it, `HEAD` where there is none): `root`, `base`, and `layers`, newest
    first, and `files`, the whole change's own list (what `changeRange` gives over every layer: the
    net against main, at most 300, in `truncated` too), and `read`, the paths of `files` the
    person read (`companions.changeRead`) that have not changed since. A layer is the work not committed yet (`id` `uncommitted`, `time` null: the
    working tree, untracked files included and ignored ones not) or a commit since the merge
    base with main (`id` its hash, its `subject` and `time`), with its `files` (`path`,
    `oldPath` for renames, `status`, `added` and `removed` counts ignoring whitespace,
    `reindented` for lines that only changed it, `binary`, `secret`) and its totals, and no
    diffs; at most 100 layers and 2,000 files in all, 300 to a layer, `truncated` where more
    were left out (or an untracked file past 1 MiB was). A binary file or one that may hold
    secrets (`secret`, judged by the new and the old name) is listed by name; names show
    invisible characters as U+FFFD. It is read with git about
    every 2 seconds while followed (less often after slow reads, keeping the last good
    content through a failed read or two), and `reveal` has no effect on it; a repository that is
    gone is `missing`, and a failing git `unreadable`. A checkout is read through a private
    index: the person's own is never written. Its snapshot is shared with the Changes panel
    (`works.watch`): one taken in the last 1.5 seconds serves both.
  - `companions.changeFile({ itemId, path, layers })` reads one file of a changes item for
    the layer ids selected: `{ run }`, one run for the range they span (the layers between
    the newest and the oldest selected are taken in; layers no longer there are left out, and a
    file the selection did not change has `run: null`). A run is the `layers` it covers, the `file` as they changed it, its
    `hunks` (context, add and remove lines, diffed from the oldest layer's parent to the
    newest layer, or from `HEAD` to the working tree for the uncommitted one) and the text of
    the file on each side (`before`, `after`; null where it doesn't exist, is binary, may hold
    secrets or passes 512 KiB). Past 4 MiB of diff text the run is `big`: no hunks, no sides.
    A name that is no valid text is `badName`: named, not read. An unknown item, or one that is
    no change, is `NOT_FOUND`.
  - `companions.changeRange({ itemId, layers })` lists the files the layers selected changed as
    one range, as git lists them from its start to its end (a file added and dropped inside it is
    not there, a renamed one is one row, counts are the range's own): `{ files, truncated }`. A
    range that reaches the oldest layer, or takes in a merge, starts at the merge base with main,
    so what main brought in is no part of it. A snapshot's objects are written to a folder of the
    runner's own, never to the person's object store, and a file that may hold secrets is never
    hashed.
  - `companions.changeRead({ itemId, path })` marks a file of a changes item read, by the path
    its content lists it under: the item's content names it in `read` until the file changes
    again, across restarts (the runner keeps it beside the Changes panel's memory). A file the
    change as a whole did not list when last read is not marked. An unknown item, or one that is
    no change, is `NOT_FOUND`.
  - `companions.save({ itemId, text, basedOn })` writes the person's edit to a plan kept in
    a file, atomically, keeping the file's permissions, unless the file's stamp is no longer
    `basedOn` (a text plan's stamp is a hash of its text; a file plan's is its size,
    modification time and inode): then nothing is written and it answers
    `{ saved: false, current: { stamp, text, truncated, skill } }`; else
    `{ saved: true, stamp }`. What can never be saved is `PLAN_UNWRITABLE`, whose data says
    why: `transcript` (the plan is in an agent's messages), `too-large` (a text or file over
    256 KiB), `gone` (the file is missing or no plain file), `folder` (the runner may not
    write in the plan's folder), `outside` (the file is in neither the project's folder nor
    the agent's own plans folder: `~/.claude/plans` for Claude Code, Antigravity's `brain`
    folder; Codex keeps its plans in its messages) or `not-a-plan`. Any other failure (a full disk, a file held
    open by another program) is an ordinary error that may pass; an unknown item is
    `NOT_FOUND`.
    Saves of one plan are handled one at a time.
  - `companions.attach({ terminalId, path, lines?, title? })` puts a file the person
    picked on a terminal's bar, by a path absolute or from the terminal's directory:
    `TERMINAL_NOT_FOUND`, or `INVALID_FILE` saying why for a missing path, a folder, a
    pipe or a device. Binary files are accepted.
  - `companions.openInProject({ sessionId, path, windowId })` opens a file the person
    picked in the session's project window, by a path absolute or from the project's
    folder, and answers the `item` and `window`. A session has one such window (`home` is
    `project`, as against `undocked`): it holds one file, and opening another points the
    same item at it, with a later `version` and the window named by it again. With no
    window yet, one is made under `windowId` with an item whose `from` is null.
    `NOT_FOUND` for an unknown session, `CONFLICT` for a taken `windowId`, or
    `INVALID_FILE` saying why. No agent's show lands in it, and closing it deletes it.
  - `companions.move({ itemId, terminalId })` moves an item onto a bar of its session,
    from a bar or a window, which goes with it; an item that bar held under the same
    pointer is replaced. `NOT_FOUND`, `TERMINAL_NOT_FOUND`, or `CONFLICT` for another
    session's terminal. `companions.undock({ itemId, windowId })` moves it into a new
    window the client names (`CONFLICT` for a taken id). A project window's item takes
    neither: `CONFLICT`. `companions.close({ itemId })` deletes it and its window.
    `companions.renameWindow({ windowId, title })` and
    `companions.resetWindowTitle({ windowId })` give a window the person's title or its
    item's name again (`NOT_FOUND` for an unknown window; `CONFLICT` for a project
    window, which its file names).
  - `companions.pageTrouble({ itemId, shown, troubles })` tells the runner what went
    wrong on a page item while it showed its show `shown` (its `version` then), as the
    desktop pane saw it: up to 20 `troubles`, each an `error` (text, source, line), a
    `request` (url, status, what; status 0 for no answer) or a `load` (text). The
    runner tells the agent that showed the page at the person's next prompt, once per show
    (see [Agent messaging](agent-messaging.md), "Nudges"). It answers nothing, and a valid
    call fails with nothing: an unknown item, a file, a person's item, a show other than the
    latest, or a page not served from this machine is let be.
  - `companions.looks()` streams agents' looks at a page item, made with the MCP `look`
    tool, to the client that subscribed last: `{ lookId, itemId, shown, url }`, `shown` being the
    item's latest show (its `version`) and `url` the address that show pointed at. The client answers each with
    `companions.answerLook`: a JPEG data URL (up to `maxLookPicture`, 4 MiB) with the
    page's `url` and `title` now, `taken` (`pane`: as the pane shows it; `fresh`: loaded
    anew at the pane's size), its `size` and the `troubles` seen; or `{ lookId, reason }`.
    The runner waits 20 s; an answer it no longer waits for, or sent from another client
    than the one the look went to, is `NOT_FOUND`. See [Agent
    messaging](agent-messaging.md), "Looking at a page".

  An agent shows things with Novadeck's MCP `show` tool, which puts each on its own
  terminal's bar; showing the same file or page again updates it, with a later version,
  there or wherever the person moved it (a page's content carries it as `shown`, and
  loads afresh for each). `showing` lists what its bar holds.
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

- `settings.get()` and
  `settings.set({ transcripts?, welcomed?, inboxOrder?, inboxSnoozed?, hibernateAfterMinutes?, worktrees? })`
  read and change whether transcripts are kept (unless turned off; turning them off forgets
  every saved transcript), whether the person has seen the first-run choice of agents, the
  Inbox rows that ask in the order the person dragged them into, and the rows they snoozed
  (each `<row id>@<when it began>`, at most 200 of each, and 200 characters), and after how
  many idle minutes an agent is stopped to rest as a sleeper (30 by default, at most a week,
  `null` for never; see "Idle agents rest" in agent-messaging.md), and whether agents may
  open git worktrees through Novadeck's tools (off until the person turns it on, in
  Preferences' Experimental tab). `get` also
  reports `transcriptsAvailable`: false once it is known there is no key to seal
  transcripts with, true when there is one and while it is still awaited (it waits about a
  second for it).

Typed errors include `UNAUTHORIZED`, `INCOMPATIBLE_PROTOCOL`, `CONFLICT`,
`INVALID_DIRECTORY`, `INVALID_FILE`, `PLAN_UNWRITABLE` (a plan can never be saved; its data says why), `NOT_FOUND`, `TERMINAL_NOT_FOUND`, `CONTROL_REQUIRED`, `CONTROL_IN_USE`,
`INVALID_CURSOR`, `UPLOAD_TOO_LARGE`, `RESOURCE_LIMIT` (too many calls in flight; retry later),
`TERMINAL_LIMIT` (the runner's terminal cap is reached), and `SLOW_CONSUMER`. A
`CONFLICT` about typing into an agent's terminal (`agents.prompt`, `agents.answer`,
`agents.interrupt`) carries `{ reason }` as its data (`conflictReason`) where one applies:
`agents.prompt` and `agents.interrupt` give one for every conflict about typing into the
terminal, and `agents.answer` only `ringing` (a doorbell ring that outlasts 10 s), its
other conflicts carrying none. `question-words-only` (a `setAside` prompt with images over a
question that takes the words as its answer, Antigravity's) is for the person to send the
words alone or answer first. `pending` (a request waits on the person), `ringing` or
`no-paste` clear by themselves or by answering, while `draft`, `shell`, `too-tall`,
`no-box` (the agent's input box is not found on its screen) and `no-agent` (no agent runs
in the terminal) are for the person to settle in the terminal. Other conflicts carry no
data, and a client takes a reason it doesn't know as none, so it words each one itself,
by what the person did (send, stop, answer), rather than showing the runner's message. The schemas and contract in
`contract/protocol/src/` are the authoritative API definition, with the wire's own error
codes (`wireErrors`) in `libraries/wire/src/errors.ts`.
