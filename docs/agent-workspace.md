# Agent operations in NovaDeck

Design proposal paired with [harness adapters](harness-adapters.md). NovaDeck is
an agent-aware terminal workspace: agents can observe their work, communicate,
create other terminals, and deliberately invoke workspace features through a
local MCP server. The UI and MCP use shared application operations; harness
adapters provide native integration behavior. Messaging between agents has its own
design, [Agent messaging](agent-messaging.md).

The concrete product scenarios are session resume; truthful activity and attention;
native subagent trees with live transcripts; usage, quotas/reset times and context;
Claude starting an independent Codex terminal; and an agent presenting a plan
document, or an image, file or page, in its terminal's companion pane, explicitly or
from verified native planning events. Where this document says a modal opens, the
companion pane opens to that plan or artifact; see [Companion pane](#companion-pane).

## Responsibilities

| Layer                  | Owns                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Harness adapters       | Native installation, launch/resume, observation, telemetry and supported controls             |
| Shared domain services | Bindings, actor graph, attention, transcript history/streams, scoped telemetry                |
| Application services   | Workspace operations, caller authorization, operations, messaging, artifacts and presentation |
| Local MCP              | Typed tool inputs/results and authenticated caller context                                    |
| Runner API             | Typed UI commands, snapshots, bounded subscriptions and acknowledgments                       |
| UI                     | Modal rendering, navigation, focus, user responses and delivery acknowledgment                |

These are logical modules inside the existing runner and UI, not additional
processes. Both entry points invoke the same application operation after obtaining
their caller context. No adapter imports React or chooses a component. No MCP
handler bypasses shared authorization by calling the terminal manager directly.
An application operation is named and typed, not `invoke(name, arbitraryArgs)`.

The current code has only broad authenticated runner access and terminal APIs.
UI overlays live in `application/ui/src/app/WorkspaceOverlays.tsx`; routes live
in `app/routing.ts`. The desktop bridge provides a runner port and platform
functions, not a general UI command channel. Extend the typed runner protocol
for presentation so Electron and remote browser clients share the same behavior.

## Caller and operation contracts

Connection credentials identify a NovaDeck principal, terminal run and actor
when verified. Native subagents inheriting their parent's MCP credentials remain
that principal unless there is separate verified attribution. Actor metadata from
an arbitrary tool argument does not establish authority. A restarted/resumed
terminal needs a fresh binding; old credentials cannot control its replacement.

Separate terminal-run authentication from live-actor attribution. The run token
proves only the terminal-run principal; a verified actor association is an
additional revocable grant with a binding/authority epoch. Every operation checks
both its principal scope and the current grant required for that operation.
Returning to the shell prompt, switching the native session, exiting or disabling
an integration revokes the old actor grant, even if the shell and MCP connection
remain alive. Never automatically relabel that connection as the next actor.

A new live association needs a fresh explicit handshake/rebind and evidence for
the new binding. If inherited credentials cannot prove a distinct actor, retain
the terminal-run principal and unknown actor attribution; do not grant actor-specific
control on that basis. Providers lacking an association mechanism expose that limit.
This is application authorization, not isolation from processes sharing the OS account.

Historical operation retrieval may remain authorized to the original principal
under its retention policy after a grant is revoked. That does not authorize new
effects against a replacement actor. Before dispatching a queued effect, revalidate
its original grant; stale effects cancel/fail explicitly. Effects already applied
retain their results under their original caller identity and are not reassigned
to the replacement session. A transport reconnect alone cannot renew revoked grants.

Shared operations authorize the principal, action and target. Distinguish observe,
send, spawn, present, interrupt and close, plus separate account-telemetry access.
UI control ownership and agent operations coordinate explicitly. Creator links
record provenance but do not automatically grant permission to every descendant.

Mutating operations have caller-scoped idempotency keys, an operation ID, a typed
state and a retrievable result. Repeating the same key and input returns the same
operation; different input with that key conflicts. Persist accepted operation
identity before an effect so reconnecting callers can reconcile a lost response.
If a crash occurs between effect and result, mark the result indeterminate and
reconcile by allocated resource ID; do not blindly repeat the effect. Keep the
idempotency retention horizon explicit in the contract.

The following signatures sketch application services, not the full wire schema:

```ts
type AgentWorkspace = {
  spawn(caller: Caller, input: SpawnRequest): Promise<SpawnOperation>
  present(caller: Caller, input: PresentRequest): Promise<PresentationOperation>
  reportPlan(caller: Caller, input: PlanReport): Promise<PlanSnapshot>
  operation(caller: Caller, id: string): Promise<OperationSnapshot>
}

// What is implemented keeps only pointers: a companion item points at a workspace file,
// a page or a plan slot and is read when it loads (see Companion pane). An `artifact`
// source holding bytes of its own is not built.
type DocumentSource =
  | { kind: "workspace-file"; path: string }
  | { kind: "artifact"; artifactId: string; revision: string }

type PresentRequest = {
  title?: string
  idempotencyKey: string
  interaction: { kind: "read-only" }
} & (
  | { kind: "document"; source: DocumentSource }
  | { kind: "plan-preview"; planId: string }
  | { kind: "plan-review"; planId: string; revision: string }
)

type PlanReport = { idempotencyKey: string } & (
  | { kind: "mode"; mode: "planning" | "execution" | "unknown" }
  | { kind: "register"; clientPlanKey: string; source: DocumentSource }
  | { kind: "update"; planId: string; expectedRevision: string; source: DocumentSource }
  | { kind: "review"; planId: string; revision: string }
  | { kind: "end"; planId: string; reason: "completed" | "abandoned" }
)
```

The initial presentation contract is read-only. A later interactive review adds
a typed interaction union and response schema; it never treats closing a viewer
as approval. Application review and a harness's native permission decision are
different request kinds and cannot resolve one another implicitly.

## Walkthrough: Claude presents plan.md

1. Claude writes the plan through its normal filesystem tools, then explicitly
   calls `documents.present` with kind `document`, a workspace-relative path and idempotency key.
   A file write by itself produces no presentation request.
2. MCP obtains the principal from its authenticated connection. The application
   operation resolves the caller's authorized project/workspace on the runner.
3. The artifact service resolves and authorizes the path, opens a bounded regular
   Markdown/text file, and captures immutable bytes with a revision/content hash.
   Path resolution and reading must enforce the same boundary, including symlink
   targets, so a check/open race cannot read outside the allowed scope. Reject
   unsupported files, oversized files and inaccessible sources explicitly.
4. The presentation service records a request referencing that exact artifact
   revision and its initiating principal, project and terminal. The returned
   operation ID lets the caller query delivery later.
5. The UI receives a typed request referencing authorized artifact content. A
   browser does not try to open a filesystem path on the runner. Fetching content
   rechecks UI authorization; artifact IDs alone are not bearer credentials.
6. The UI opens the document in the terminal's companion pane, or waits in its
   taskbar when the request isn't marked as asked for, and acknowledges rendering.
   An acknowledged opening means rendered, not read or approved. Failure and
   dismissal are separate outcomes. A plan opens editable; see
   [Companion pane](#companion-pane).
7. The caller can query the operation.

Markdown content is untrusted display data. Disable script execution and raw
active HTML; do not fetch embedded remote resources automatically. Relative
attachments, if supported, use authorized artifact references. The renderer does
not execute commands or open local files merely because document links ask it to.

In a `document` or `plan-review` view, displayed bytes remain the captured revision
even if the agent edits the source. A `plan-preview` intentionally follows versioned
captures as described below. Any future review response binds to the revision
actually displayed, not the current path contents.

## Automatic planning and live previews

Both native observation and explicit MCP reporting feed the same plan service.
They do not have separate modal implementations. The plan service owns canonical
plan identity, artifact revisions, generation/lifecycle and source provenance;
the presentation service owns requests, viewer claims and rendered receipts.

The inputs are distinct facts:

| Fact                                 | Meaning                                                                  | Presentation policy                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Planning mode entered                | This actor is in an explicit planning workflow                           | Show Planning status; do not open an empty modal                                       |
| Identified plan content available    | A plan has displayable content with an accepted actor/source association | Open one live draft preview if automatic previews are enabled and the plan is eligible |
| Draft revision captured              | More recent content for that same plan                                   | Update the existing preview; do not create another modal                               |
| Plan ready for review                | A review boundary identifies a particular content revision               | Pin that revision for review; never equate it with approval                            |
| Planning mode exited                 | The workflow mode changed                                                | Stop showing Planning; do not invent review readiness or plan completion               |
| Plan ended/abandoned                 | The plan lifecycle explicitly ended                                      | Stop following updates; retain read-only history per retention policy                  |
| Source lost or actor binding revoked | Current draft state is no longer known                                   | Mark preview stale and stop old-source updates; no false completion                    |

`plans.report`, proposed here and not built (every harness's plans come from native
sources today), is an authenticated, typed MCP operation for reporting these facts
and their explicit plan/source correlations. It can register a plan and return its
canonical ID, submit a new captured revision, or request review of a known revision.
The caller is assigned from its connection, not an arbitrary actor argument.
Native sources can drive this entire flow without the model making an MCP call.
Where native signals are missing, the model's MCP report supplies an explicitly
labeled alternative. Merely writing a file never counts as either input.

Recommended defaults: automatic previews are enabled for verified root-plan
associations in the user's workspace, subject to the normal eligible-viewer policy.
Users can disable automatic previews per workspace and still use an explicit
`present` request. Native child plans appear in the plan/attention list; they do
not each steal focus automatically. A child plan can be opened explicitly or under
a deliberate user-configured child-plan policy. Observations with unresolved actor
or file scope stay candidates and cannot trigger filesystem reads or presentation.

An identified draft can open even when a source has no planning-mode signal.
Conversely, a source that only reports planning mode can show status but cannot
invent a document. Do not infer review readiness from leaving planning mode, a
stop hook, or an interval of unchanged file content.

### One plan across native and MCP reports

Deduplicate through canonical plan identity, not just MCP idempotency keys. Prefer
an explicit canonical/native plan correlation; otherwise associate only when the
same accepted actor and planning generation name the same authorized artifact/file
identity with continuity evidence. Equal text or equal display names are insufficient.
Keep ambiguous associations unresolved rather than creating a second automatic modal.

Maintain source epoch/revision evidence and an accepted plan revision. Duplicate
reports are idempotent; older source events cannot replace a newer draft. Conflicting
sources without an ordering rule make the affected view stale/uncertain. A late
event for an ended generation cannot revive it. Re-entering planning without evidence
of continuing the same plan starts a new generation; never reuse an ended plan merely
because its path matches. Session switches invalidate live associations until reverified.

An explicit `documents.present` for content already associated with the current
plan resolves through this same policy. If that plan is already open, return/update
its existing request. If it was dismissed, return `dismissed` with the plan ID;
it does not force another opening. User-initiated reopening in the UI is explicit.
If no plan association is established, ordinary document presentation keeps its
snapshot semantics without guessing that it is a plan.

### Preview, dismissal and review

The automatic-open key is canonical plan ID, not each purpose, content revision
or source report. Preview/review are versioned modes of the same plan presentation,
not competing modal requests. One live preview follows immutable revision
captures. The renderer acknowledges which revision it displayed; if it falls behind,
it can fetch the latest snapshot and show an update indication. Capture/read failures
preserve the last rendered revision with a stale/error indicator, never blank it or
claim that its content is current. File replacement/partial writes require bounded
retry or a source reconciliation path; unchanged bytes alone do not prove a finished plan.

Dismissal records suppression for that canonical plan across revisions, sources,
reconnections and viewer transfers. A later update or review-ready event adds a
non-modal indicator/inbox item but does not reopen it. Explicit UI reopening clears
that suppression for a new delivery attempt. A genuinely new plan has its own key.
Pending requests are updated in place while no eligible viewer is connected.

For an open preview, review readiness switches the same presentation to the exact
review revision and stops following drafts. The UI must acknowledge rendering that
revision before a future response can be accepted. Later edits create a newer draft
indicator; they cannot silently change the pinned review bytes. An explicit review
of a new revision supersedes any unresolved old review response authority, even if
the new revision is still awaiting display. Already resolved review records remain
historical. Dismissed previews stay dismissed when review readiness arrives.

Plan requests reuse the existing single-viewer claim, pending-inbox, cancellation,
expiry and authorized-content rules. No UI means pending, not opened. Multiple UIs
cannot race into duplicate modal claims. Expired/cancelled automatic requests stay
suppressed for that generation; late draft updates cannot recreate them. Resuming
a plan after application restart restores history and suppression, not live source
authority; reconciliation is required before automatic updates or a new opening.

## Companion pane

The UI presents what an agent shows in its terminal's companion pane: a taskbar along
the terminal's bottom with an icon for each plan and each other item, and a pane beside
the terminal (inside its window in Focus and Grid, attached to its node in Canvas).
Nothing opens on its own unless the user asked for it; everything else waits in the
taskbar, marked new.

What is shown is a companion item: a pointer to a file, a page or a plan, never a copy,
held by exactly one terminal's bar or one undocked window. The runner keeps items and
windows (`companions.*`, see [Backend API](backend-api.md)), so they survive restarts.
Moving an item to another bar or undocking it changes its holder; closing it deletes
it, except that a plan or the Messages closed on their own terminal's bar only hide
there, which the UI keeps as presentation. There is no cap and no eviction: an item
that can't be shown stays and says why. Items and windows reach the workspace store
through the backend's seed and actions, as terminals do; the person's moves are
workspace actions the backend makes so. The pane loads content through the backend
port's optional `companions` capability (`application/ui/src/model/companion.ts`):

| `companions`                             | What it carries                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `follow(target, itemId, { reveal }, on)` | What an item holds now, then again as it changes: ready with a stamp, or why not  |
| `save(target, itemId, text, basedOn)`    | The user's edit written to the plan file, unless it changed since stamp `basedOn` |
| `attach?(key, path)`                     | A file the person picked, put on a terminal's bar; absent where the backend can't |

### Plans are edited in their file

Unlike the read-only `document` presentation, a plan opens editable. The user's
edits, and the notes they leave (`<!-- novadeck: … -->` comments), are written into
the plan file itself: the file is the channel back to the agent, which re-reads it
(NovaDeck's skill tells it to) and removes each note it applies. Closing the pane
never approves anything; approval stays in the agent's own prompt.

Every plan text carries a `stamp`. The UI saves an edit with the stamp it was made
on, once typing pauses and at once when focus leaves the plan. The backend writes only
if the file is still at that stamp; otherwise it returns the plan as it now stands, and
the UI merges the edit into it line by line, as it merges an agent's rewrite, and saves
again. The last stamp both sides agreed on is the merge base, so an agent's rewrite
that already contains the user's edits merges cleanly. A rewrite reported while a save
is under way waits for that save's answer, since it may have been written over it. A
stamp must change whenever the text does, so derive it from the content (a hash), not
a timestamp: two writes in one tick would otherwise share one. A backend following the
file may report the UI's own save back; it must carry the stamp the save answered
with, and the UI takes it as its own. The runner can't write plans yet, so its plans
are read-only; the content-preview demo writes them. A save that
fails, or goes unanswered for 20 seconds, is tried again, less often each time, and the
plan shows it isn't saved yet until it is, or until there's nothing left to save. The
file keeps its line breaks when it uses one kind throughout; a mixed file saves as LF.

### The runner's items

The runner keeps items in its database and reads their content from disk as it loads,
with every safety check again at that time:

- **Plans** come from native observation: each agent session's latest plan per actor
  (root and subagents) is an item on the bar of the terminal it runs in, updated in
  place as the agent rewrites it, with a later version only when the observation is
  newer, so a replay after a restart marks nothing new. A plan file is pointed at
  directly. A plan presented as text, Codex's and Claude Code's without a file, points
  at the transcript or rollout that records it and is decoded from there with the
  harness's own decoders (`Harness.plans`, see [harness adapters](harness-adapters.md)),
  so a moved one keeps working after its terminal closes and after a restart; while
  that terminal still runs the session, its live activity is read first. No plan text
  is copied into the database. When another agent session binds the terminal, the
  plans its own bar mirrored of the earlier one go; moved ones stay.
- **Other items** come from NovaDeck's MCP server, which ships inside the agent plugin
  NovaDeck already installs: `.mcp.json` for Claude Code, `mcpServers` in Codex's
  plugin manifest (with `env_vars` naming the terminal's variables, since Codex starts
  MCP servers without the terminal's environment), `mcp_config.json` for Antigravity.
  Its first tool, `show`, takes a path and optional lines, or a page's `url`, plus a
  title and `open`, which the agent sets when the user asked to see it (`asked`). The server finds its terminal
  from `NOVADECK_TERMINAL_ID`, `NOVADECK_REPORT` and `NOVADECK_REPORT_TOKEN`. Like
  the hooks, it is installed for every session, but outside NovaDeck's terminals it
  lists no tools, so the agent never sees `show`, and a call anyway does nothing.
  There its launcher answers itself (sh, or Windows Script Host's JScript on Windows,
  which agents reach through `cmd.exe`) without starting NovaDeck's runtime, which a packaged NovaDeck
  can unpack into a folder that goes when it quits. In a terminal it forwards the call
  over the terminal's report endpoint, where the runner checks the token and puts the
  item on the agent's own bar: any file the person can read, as a viewer would, or an
  http(s) page. Showing a file puts it on their screen and sends it nowhere, and the
  agent could read it anyway. `show` refuses only what can't be an item: a missing
  path, a folder, a pipe or a device, and a page address that isn't http(s), carries a
  user name or password, or is too long. Binary files are accepted and load as
  `binary`; an image over 8 MB is accepted and loads as too large to preview, which the
  answer says. Showing the same file or page again updates the item on the agent's own
  bar; one moved elsewhere is never touched. A file that often holds secrets (`.env`,
  keys, credentials, agents' and tools' logins, shell history) is held: it never opens
  by itself, even when the agent says the person asked; the pane never falls back to
  it, its taskbar peek shows no preview, and it goes by its own name, not the agent's
  title. So none appears unasked while they share their screen. A file that resolves
  to such a file only later is held when it loads. The server's `showing` tool lists
  what the agent's bar holds now, with where each item points and who put it there.
  The UI follows each item with `companions.content`, never by path.
- **New terminals** come from the same server's second tool, `open_terminal`, listed
  only inside NovaDeck's terminals like `show`. It opens a terminal beside the agent's,
  in `cwd` (absolute, or from the terminal's directory, which is the default), named
  `title`, and can start `command` at the new shell's first prompt, one line as the
  person would type it, such as `claude` or `npm run dev`; `focus` brings it into view
  only when the person asked to see it. The runner checks the token, reads the request
  strictly, checks the folder, and lets a terminal's agents open five a minute, a
  terminal opened on request sharing the budget of the one that began the chain, and
  all agents twenty a minute across the runner, so terminals opening terminals can't
  multiply. The UI
  owns layout, so the runner hands the request to the client that subscribed last to
  `terminals.requests`, which adds the terminal as its "+" would, in the asking
  terminal's session and beside it, creates it through `terminals.create` with
  `command` and the request's `requestId`, from which the runner names it as the agent
  asked, as that agent's title, never the person's, and replies with
  `terminals.answerRequest`: the new terminal, or why not.
  Without a client, or past the deadline, the agent hears so. The command runs once
  through the same file the shell integration resumes agents from, so it leaves no
  history entry; a shell without the integration, or with configured arguments, can't
  run one, and the terminal does not open rather than start a plain shell.
- **Closing terminals** comes from the same server's `close_terminal`, listed only
  inside NovaDeck's terminals like the others. An agent closes another terminal of its
  project and session, an agent's or a plain shell, by its exact handle, as `send`
  names its recipient; any other `to` is refused with the terminals there described, as
  `send` refuses one, and so is its own terminal, with a pointer to its harness's own
  exit. Its description tells agents to close only a terminal they are done with or
  the person asked about, as closing ends whatever runs there. The runner checks the
  token, reads the request strictly, and closes it as the person's close does: it ends
  the shell, removes the terminal and forgets it, even while a window controls it, so
  the UI drops it from the layout on `terminals.watch`'s `removed`, as for a close in
  another window. Messages still waiting for it are `gone`, their senders told as
  always; the answer names the agent that ran there and counts them. A terminal's
  agents close five a minute, a terminal opened on request sharing the budget of the
  one that began the chain, and all agents twenty a minute across the runner, each
  budget apart from the one for opening, so a runaway loop can't empty the workspace.
  A chain's times, for opening and closing alike, outlive the terminal that began it
  until they pass out of the minute, so its terminals can't start afresh by closing
  it. A terminal already closing is refused as such, at no cost, and a close the
  runner's own shutdown overtakes answers that it failed, the terminal kept as
  shutdown keeps every terminal.
- **Messages** between agents come from the same server's `send` and `agents` tools,
  listed only inside NovaDeck's terminals like the others: an agent messages another
  terminal of its project and session by its handle, such as `t3`, which `open_terminal` also
  answers with, and the message reaches that agent through its own hooks. The runner
  keeps the mailbox with the workspace and lists, pauses and releases it through
  `messages.list`, `messages.pause` and `messages.release`. Its `describe` tool names
  the agent's own terminal and says what it works on. See
  [Agent messaging](agent-messaging.md).
- **Pages** are any http(s) address; an address with a user name or password is
  refused. The desktop app loads them live in the pane, in Electron's `<webview>`,
  which lays out with the pane, keeps NovaDeck's menus and cards above it, and lets a
  later highlight mode reach into the page. Whatever the element asks for, the host
  gives each one no preload or Node, a sandbox, and the `novadeck-pages` session, in
  memory, where every permission and download is refused and no file loads. Its own
  links and redirects go only to http(s) addresses. A window it opens goes to the
  person's browser only right after they clicked or typed in it, one each, so a page
  can't open tabs on its own; a frame from another site in the page can take that one
  window, as Electron doesn't say which frame opened it
  (`application/host/src/main/pages.ts`). Where the host can't, as the web version, a
  page is a link to open in the browser.
- **Saving** would be a new authorized plan-write operation with the stamp check above,
  scoped like `present`: the caller may write only the plan the terminal's agent keeps.
  The runner doesn't offer it yet.

## Presentation routing and results

Recommended defaults for this proposal:

- Prefer the eligible connected UI client controlling the requesting terminal,
  when it is viewing the relevant workspace and can accept the request.
- Otherwise retain a bounded, expiring request in an authorized presentation
  inbox. The operation reports `pending-viewer`; it does not claim a modal opened.
- An explicit viewer target is honored only after eligibility checks. There is
  no broadcast modal and no automatic project switch to steal the user's focus.
- A UI with an active incompatible modal can defer to its inbox. Eligible users
  can intentionally claim a pending request and open it.

A presentation has a request revision, delivery state and an optional viewer
claim. Useful states are pending-viewer, claimed, opened, dismissed, failed,
cancelled and expired. User-visible state only advances when the corresponding
actor supplies evidence. The UI sends request/revision/claim identifiers with
acknowledgments. The service applies state changes atomically, rejecting stale
claims; two viewers cannot both win the same exclusive presentation claim.

Claims have bounded leases. Disconnection before opening releases/expires the
claim for another viewer. Once opened, keep the receipt even if the client later
disconnects; do not automatically reopen it elsewhere. Explicit reopening can
create a new delivery attempt under the same request, without erasing history.
Duplicates on reconnect do not create another modal in that client. Cancellation
and expiry invalidate claims and any outstanding future response authority.

For a future interactive request, accept at most one terminal response using the
request revision and active claim, then publish it to the operation.
An MCP call can wait only within a bounded deadline and otherwise return pending.
Deadline expiry is not an implicit negative answer.

Request/operation retention is coordinated. Companion items keep no bytes of their
own: each points at a file, page or plan and is read when it loads, so content that is
deleted or changes produces an explicit unavailable result (`missing`, `gone`) or the
current version, never a stale copy. Project documents are never retained by NovaDeck.

## Walkthrough: Claude starts Codex

The MCP caller names the harness and a validated task/launch request. Shared
orchestration authorizes it and allocates a terminal and operation ID. The adapter
provides the fresh-session launch plan; the terminal manager performs the launch
with the integration-revision and claim rules in the adapter design.
Task text must use the adapter's verified data-delivery/argument path described
there. Never send a task through the restricted resume command's space-join path.

Record a creator edge from Claude to the new terminal/root actor. Codex is its
own root session, not a native Claude subagent. Terminal-created, harness-launched,
native-session-bound and MCP-connected are separate observations. Readiness to
receive an initial task depends on the selected supported delivery mechanism;
it does not follow solely from PTY creation. A startup failure returns the existing
operation and failed terminal identity rather than spawning another one on retry.

The initial task is a message: the new agent starts with NovaDeck's doorbell as its
command-line prompt, and its prompt-time hook delivers the task, wrapped as from its
opener, once; see [Starting a task](agent-messaging.md#starting-a-task), which also
covers a harness without a command-line prompt.

## Architecture acceptance scenarios

The design is ready to guide implementation when these paths have one owner at
each boundary and an explicit result on failure:

| Scenario                                                            | Required outcome                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Root spawns native child; transcript arrives before parent metadata | Bounded unresolved actor association; no foreground takeover; history/live reconciliation               |
| Child requests permission while root works                          | Child-scoped pending request contributes to user attention without erasing root activity                |
| Harness asks a question then user answers in terminal               | Correlated question resolves; a stale UI answer is rejected                                             |
| Root and child report usage; account limit resets                   | No duplicate totals; independently scoped windows and context; refresh instead of assumed replenishment |
| Claude creates Codex; MCP response is lost                          | Same operation/resource on retry, separate creator edge, no duplicate initial task                      |
| Claude presents a plan; runner is remote                            | Authorized captured content reaches UI through runner API, not local file access                        |
| Plan presented with no UI or multiple viewers                       | Pending inbox or one atomic eligible claim; no false opened result                                      |
| File changes while the modal is open                                | Displayed revision stays stable; any response names that revision                                       |
| UI disconnects after rendering                                      | Opening receipt survives; no automatic duplicate modal elsewhere                                        |

Planning-specific acceptance cases:

Native plans may live in harness storage outside the workspace. They use the
adapter's authorized native-reader and scoped capture port described in the
adapter design; MCP workspace-file access is not broadened.

| Scenario                                                       | Required outcome                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Native harness enters planning with no content                 | Planning status only; no empty modal                                                                    |
| Native plan becomes available without an MCP call              | Verified plan association drives the shared automatic-preview policy                                    |
| Source exposes content but no planning-mode event              | Preview can open without inventing a mode                                                               |
| Native plan is stored outside the workspace                    | Verified native association permits bounded immutable capture; arbitrary reported paths remain rejected |
| Native planning/source signals unavailable                     | Explicit MCP plan reporting works; unavailable native coverage stays visible                            |
| Ordinary Markdown write or text mentioning planning            | No inferred plan and no automatic modal                                                                 |
| Native and MCP reports identify the same plan                  | One canonical plan, revision stream and presentation request                                            |
| Correlation between reports is ambiguous                       | Unresolved candidate; no duplicate automatic opening                                                    |
| Draft changes repeatedly                                       | Existing preview updates and acknowledges revisions; modal is not recreated                             |
| User dismisses the draft, then updates/review readiness arrive | Suppression persists; non-modal indication only                                                         |
| User explicitly reopens it                                     | New delivery attempt for the same plan, with retained history                                           |
| Review arrives before its referenced artifact revision         | Wait for matching capture; do not pin a different draft                                                 |
| Review source has no revision and cannot capture coherently    | Show limited coverage; require an explicit captured revision before review                              |
| Draft changes after review is displayed                        | Review stays pinned; newer draft is indicated separately                                                |
| New review supersedes an unanswered old review                 | Old response authority revoked; new revision requires rendering acknowledgment                          |
| Child creates a plan                                           | Attributed child plan listed; default policy does not steal focus                                       |
| File read fails or source disappears                           | Last content retained with stale/error state; no false completion                                       |
| No UI is eligible while revisions arrive                       | One pending request tracks latest preview; pinned review stays exact                                    |
| Session switches, source reconnects, or delayed events arrive  | Binding/generation revalidated; ended/cancelled plans cannot revive                                     |
| Automatic previews disabled                                    | Observation/status continue; explicit presentation remains available                                    |

The defaults above are architectural recommendations, distinct from the user's
required capabilities. Provider signal availability and platform file-access
mechanisms still need implementation probes and tests; this design does not
claim that native hooks alone supply every path.
