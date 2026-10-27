# Agent operations in Novadeck

Design proposal paired with [harness adapters](harness-adapters.md). Novadeck is
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
UI overlays live in `frontend/ui/src/app/WorkspaceOverlays.tsx`; routes live
in `app/routing.ts`. The desktop bridge provides a runner port and platform
functions, not a general UI command channel. Extend the typed runner protocol
for presentation so Electron and remote browser clients share the same behavior.

## Caller and operation contracts

Connection credentials identify a Novadeck principal, terminal run and actor
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

What belongs there is a deliverable: something made to be looked at (an image or
screenshot, a rendered page or dev server, a report, mockup, diagram or generated
document, the one file the user asked for, or whatever they ask to see), shown once it
is done, with `open` so it opens at once; without `open` for anything supporting, which
waits marked new. A page is one the agent serves or just deployed, such as a dev server
or a preview: a link to someone else's site often wants a sign-in in the pane and helps
little there, so it goes in the agent's reply unless the user asks to see it in the pane. A source file counts while it is the one
the user and the agent work on together; the files a change touches on the way do not,
and the user reads those in the diff. Every harness hears this two ways, as no plugin ships a skill: the `show` tool's
own description carries the rule, which every harness reads alike from `tools/list`,
and the runner's prompt-time hook adds Novadeck's artifacts notice, one paragraph, at
the first turn the person's prompt or the doorbell begins in each root session, and after a compaction
(`artifactsNotice` in `terminals/nudges.ts`; it rides with the summary nudge but a
`summarize` never clears it; see [Agent messaging](agent-messaging.md), "Nudges"), with
the Inbox notice beside it (`inboxNotice`): the person rarely watches the terminal, so
a question the agent's turn ends waiting on goes to the Inbox: through the harness's own
question tool where the agent would use one, which the Inbox shows as it is, else with
`ask`. A
worker another agent runs by briefs alone hears them at the person's first prompt there,
so until then its tool descriptions are what tell it. In Antigravity an injected message
lasts one model call, so there the notices are read once at the prompt and the tool
descriptions are what last; a lasting injection is a gap to probe.

What is shown is a companion item: a pointer to a file, a page or a plan, never a copy,
held by exactly one terminal's bar, one undocked window, or the session's project window,
which holds the one file the person opened from the Source tree and is re-pointed at the
next; no agent's show lands there, and it can't be moved to a bar or undocked. The runner
keeps items and windows (`companions.*`, see [Backend API](backend-api.md)), so they
survive restarts.
Moving an item to another bar or undocking it changes its holder; closing it deletes
it, except that a plan or the Messages closed on their own terminal's bar only hide
there, which the UI keeps as presentation. There is no cap and no eviction: an item
that can't be shown stays and says why. Items and windows reach the workspace store
through the backend's seed and actions, as terminals do; the person's moves are
workspace actions the backend makes so. The pane loads content through the backend
port's optional `companions` capability (`frontend/core/src/items.ts`):

| `companions`                             | What it carries                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `follow(target, itemId, { reveal }, on)` | What an item holds now, then again as it changes: ready with a stamp, or why not      |
| `save(target, itemId, text, basedOn)`    | The user's edit written to the plan file, unless it changed since stamp `basedOn`     |
| `openInProject?(target, path, windowId)` | A file the person opened from Source, in the project window; absent where it can't be |

A file that may hold secrets is `secret` until the person asks to see it, and `reveal` is the path
they asked for: the item re-pointed to another file reads `secret` again.

A change (the `changes` item kind) shows in the diff viewer (`libraries/viewers/src/diff.ts`),
read-only: a list of the changed files at the top, each scrolling to its section, then a
section per file with its path (and old path when renamed), how it changed and its added and
removed counts, over its hunks with the old and new line numbers in two gutters, added and
removed lines tinted and the text highlighted by the file's language (a hunk's old and new
side parsed apart; a file past 4,000 diff lines, or one whose parser fails, stays plain). A
line wider than the pane scrolls its own file sideways (the pane scrolls only down), the file
list, the headers and the line numbers (with the marker of each line's kind) staying in view; a
file's lines are a tab stop only while they overflow, and its sideways scroll is kept by its
path, put back as the file comes into view. A binary file, one that
may hold secrets and one past the change's size show their header with a note, an empty
change says "No changes against HEAD", and a truncated one says it is larger than shown.
The rows of a long change are made a few at a time, and the sections off screen are not laid
out, so a change of the full 4 MB opens without freezing the pane. A new content for the same
change, as the agent edits, keeps the rows and colours of every file that didn't change, and
the place the person was at (the file and row at the top, not pixels, whichever file changed),
also while the pane is out of sight, where it goes back to once the pane has a size. Nothing
asks the page to lay out a file that is off screen.

### Plans are edited in their file

Unlike the read-only `document` presentation, a plan opens editable. The user's
edits, and the notes they leave (`<!-- novadeck: … -->` comments), are written into
the plan file itself: the file is the channel back to the agent, which re-reads it
(Novadeck's skill tells it to) and removes each note it applies. Closing the pane
never approves anything; approval stays in the agent's own prompt.

Every plan text carries a `stamp`. The UI saves an edit with the stamp it was made
on, once typing pauses and at once when focus leaves the plan. The backend writes only
if the file is still at that stamp; otherwise it returns the plan as it now stands, and
the UI merges the edit into it line by line, as it merges an agent's rewrite, and saves
again. The last stamp both sides agreed on is the merge base, so an agent's rewrite
that already contains the user's edits merges cleanly. A rewrite reported while a save
is under way waits for that save's answer, since it may have been written over it. A
stamp must change whenever the text does, so a backend derives it from the content, not
from a timestamp alone: the runner stamps a text plan by a hash of its text, and a plan
file by its size, modification time and inode, which a save changes by replacing the file. A backend following the
file may report the UI's own save back; it must carry the stamp the save answered
with, and the UI takes it as its own. The runner writes plans kept in files (`companions.save`, atomic,
refused on a stale stamp) and carries `writable` and `skill` in the plan's content; a
plan in an agent's transcript, or one over 256 KiB, is read-only. A save that
can never work (`PLAN_UNWRITABLE`: the file is gone, its folder can't be written, the plan
is in a transcript or too large) stops at once and the plan says why. One that fails
for a moment, or goes unanswered for 20 seconds, is tried again after 2, 4, 8 and 16
seconds, then stalls after 5 tries with a Retry button. Until it is saved the plan shows it
isn't, and the edits stay in the editor, which can Copy my edits. The
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
  is copied into the database. A plan the person moved into a window or onto another
  bar is updated there. When another agent session binds the terminal, the plans its
  own bar mirrored of the earlier one go; moved ones stay.
- **Other items** come from Novadeck's MCP server, which ships inside the agent plugin
  Novadeck already installs: `.mcp.json` for Claude Code, `mcpServers` in Codex's
  plugin manifest (with `env_vars` naming the terminal's variables, since Codex starts
  MCP servers without the terminal's environment), `mcp_config.json` for Antigravity.
  Its first tool, `show`, takes one source under the key that names it, with that
  source's own options inside: a `file` (its path and optional lines), a `page` (its
  `url`, and optionally `scroll`, a CSS selector of the element to bring into view once it
  loads) or `changes` (`{}` or `{ path }`: the whole change in a repository, see below);
  beside it the options every source shares, a title and `open`, which the agent
  sets for a deliverable it finished or one the user asked to see (`openAsked`). A new kind
  of artifact adds a source key of its own rather than more fields beside these. `close`
  takes the same `file` (its path alone), `page` (its url alone) or `changes` and removes what the
  agent showed under it from its own bar, as the person closing it would; what the person attached, moved away from it, or another
  terminal placed there is refused with a word on whose it is, and plans are never
  addressable this way. The server finds its terminal
  from `NOVADECK_TERMINAL_ID`, `NOVADECK_REPORT` and `NOVADECK_REPORT_TOKEN`. Like
  the hooks, it is installed for every session, but outside Novadeck's terminals it
  lists no tools, so the agent never sees `show`, and a call anyway does nothing.
  The plugin starts Novadeck's relay (`backend/relay`), a small native program
  Novadeck copies into its own data folder, so it stays when a packaged Novadeck's
  runtime folder goes as it quits. On Linux and macOS a launcher starts it; on Windows agents
  start it directly, as a launcher there would keep `cmd.exe` running beside it.
  Outside Novadeck's terminals, or when the runner can't be reached, the relay answers
  the handshake itself, with no tools. In a terminal it carries the agent's messages
  over the terminal's report endpoint to the runner, which serves the MCP session
  itself (`runner/src/shell/mcp.ts`): it checks the token on each call and puts the
  item on the agent's own bar: any file the person can read, as a viewer would, or an
  http(s) page. Showing a file puts it on their screen and sends it nowhere, and the
  agent could read it anyway. `show` refuses only what can't be an item: a missing
  path, a folder, a pipe or a device, and a page address that isn't http(s), carries a
  user name or password, or is too long. Binary files are accepted and load as
  `binary`; an image over 8 MB is accepted and loads as too large to preview, which the
  answer says. Showing the same file or page again updates the item on the agent's own
  bar, or else the latest it showed that the person moved into a window or onto another
  bar, where it stays. Items are told apart by a file's real path or a page's `pageKey`
  (`protocol/src/pages.ts`): its address without the fragment, or for a server on this
  machine (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0` and `[::]` alike) its scheme and port
  alone, so a dev server stays one item whatever route the agent shows. A file that often holds secrets (`.env`,
  keys, credentials, agents' and tools' logins, shell history) is secret: it never opens
  by itself, even when the agent says the person asked (one the person attached themselves does
  open, onto the pane's gate: they picked it); the pane never falls back to
  it, its taskbar peek shows no preview, and it goes by its own name, not the agent's
  title. So none appears unasked while they share their screen. A file that resolves
  to such a file only later is secret when it loads. The server's `showing` tool lists
  what the agent's bar holds now, with where each item points and who put it there,
  then what it showed that the person moved elsewhere.
  The UI follows each item with `companions.content`, never by path.

  A **changes item** (`show { changes: {} }`, kind `changes`) is a git repository as a
  set of diffs, the terminal's by default. An agent that works in another folder or
  worktree gives `changes: { path }`, a folder inside the repository (absolute, or from the
  terminal's directory; a file stands for its folder), and `close` takes the same, even
  once that folder is gone (a worktree removed): the item shown from it is found by where
  it was shown from. The item is the repository's working tree against `HEAD` (the empty
  tree before the first commit, whatever the repository's hash), so staged, unstaged and
  untracked files, but not ignored ones, with renames found, whoever edited them. It is
  one item per repository on a bar, keyed `changes:<repository root>` (folded to lower
  case on Windows) and named "Changes · <folder>"
  unless a title is given; showing it again updates it. Its detail counts the files and
  lines (untracked files that are listed without being read count as files, not lines)
  and follows each read the pane triggers. The content (`companions.content`) is read
  with git at the start and again about every 2 seconds while followed, and sent only
  when it changed.

  Reading costs git runs, and a big repository makes each one slow: after a read that
  took over a second, the next waits four times as long (up to 15 seconds), and the
  usual 2 seconds again as reads get fast. A read that fails once or twice (git timing
  out under load) keeps the last good content on screen; a third failure in a row says
  `unreadable`, and a repository that is gone says `missing` at once. The show itself
  keeps the 5 second timeout. Where the person's `core.fsmonitor` is git's own file
  monitor (`true`), it is kept, which is what makes big repositories fast; a hook
  program named there never runs.

  Bounds: git lists every changed file with its counts first, and at most 300 files are
  carried (`truncated` says more exist; the rest are not listed). The diff text is read up
  to a budget of 4 MiB as encoded, each line counting its text and its encoding, so
  blank lines are not free; a file whose diff would pass what is left is `listed`: name,
  status and counts, without hunks, and `truncated` is set. Only files that could fit
  (each changed line costs at least 32 bytes, against what the files before already
  could take) are asked of git for their diff, by literal name, so a regenerated lockfile
  takes no room from the small edits after it; the rest are listed without being read.
  The raw patch is read to at most 8 MiB, and git is ended there (its whole process group,
  as on a timeout): the file it cut in the middle is listed, and the files after it are
  asked for again without it (a few times), so one minified bundle takes no room from the
  small edits after it (the file named is the last one read at the cut, so when many medium
  files add up to the cap it can be one that would have fitted; the retries stop once the
  diff budget is spent). Untracked files come from `git ls-files --others`, read to 2 MiB
  of names (only the first fit the 300 files, so the file count of a huge untracked tree
  is a lower bound), and none where `status.showUntrackedFiles` is `no`. Their contents
  are read a bounded amount in all (1 MiB each, 8 MiB per look); past that they are listed
  by name with no counts. A path git lists as changed and as untracked counts once. Lines are cut at 4096 characters, and names show a control or invisible
  character as U+FFFD.

  A binary file and a file that may hold secrets (the rule for files, applied to the new
  name and the old one of a rename, tracked or not) carry no hunks: a secret file's diff
  text is skipped by the reader, and an untracked one is never opened. v1 has no way to
  reveal either.

  The runner finds `git` once on the PATH (absolute entries only) and runs it with a
  fixed argument list, no shell, in the repository, for at most 5 seconds, ending its
  whole process group if it takes longer. Its environment is the person's, without the
  `GIT_*` variables that point git at another repository, configuration or diff
  (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_CONFIG*`, `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, trace
  variables and the like; `GIT_CEILING_DIRECTORIES`, `GIT_EXEC_PATH` stay), with `GIT_OPTIONAL_LOCKS=0` (following never
  takes the index lock the agent's own git needs), no prompts and no network fetch of
  missing objects (`GIT_NO_LAZY_FETCH` is honoured from git 2.45; an older git ignores it).
  Its messages are English (`LC_ALL=C`), which the reader matches; names are read as bytes.
  The diff prefixes are fixed, so the person's `diff.noprefix` and
  the like change nothing. External diff drivers and text conversion are switched off, and so is
  a file monitor hook program; clean filters (git-lfs, say) of files whose stat
  changed still run, as in the person's own `git diff`. Otherwise it is the person's git
  and configuration, which an agent in that terminal could use anyway. `show` is refused,
  with a reason the agent can act on, when the folder is not in a git repository
  (said in Novadeck's own words, with a hint to give `path`), git is not installed, or git
  refuses the folder or cannot read the change (then git's own first line of explanation
  follows, as for a folder another user owns); a repository that goes later
  makes the content `missing`, as does one whose own `.git` went and which is now a
  folder of another repository; any other failure is `unreadable`. On a Mac without the
  Command Line Tools, `/usr/bin/git` is Apple's installer stub, so each attempt to show
  can fail with its message, and may bring up the installer dialog.

- **New terminals** come from the same server's `open_terminal` and `open_agent`, listed
  only inside Novadeck's terminals like `show`. `open_terminal` opens a terminal beside the agent's,
  in `cwd` (absolute, or from the terminal's directory, which is the default), named
  `title`, and can start `command` at the new shell's first prompt, one line as the
  person would type it, such as `npm run dev`; `focus` brings it into view
  only when the person asked to see it. `open_terminal` takes no agent: to start one with
  a task (and optionally a `model` and `effort`), an agent calls `open_agent`, which makes
  it the new agent's lead. The runner checks the token, reads the request
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
- **Leading an existing agent** comes from `lead` and `release`, listed beside the
  others. `lead` (`to`, a handle, and `message`, a brief up to 4 KB) asks the person to
  let the caller lead the agent already running in another terminal of its project and
  session, as `open_agent` makes the caller lead a terminal it opens. It is refused at
  once, with a sentence to act on, for the caller itself, a handle not there, a terminal
  that runs no agent (use `open_agent`), one the caller already leads, one with another
  running lead, one that leads the caller directly or up the chain, one an approval
  already waits for, and when no client follows approvals. Otherwise the ask goes to the
  client that subscribed last to `terminals.approvals`, with the action
  `{ type: "lead", brief }`, and the call answers `asked` at once; the person's
  `terminals.answerApproval` settles it. On a yes the runner checks everything again,
  then sets the terminal's `ledBy` to the caller's handle (kept, announced, told to
  messaging), notices the terminal that the person let the caller lead it, sends the
  brief from the caller, marked as from its lead, and notices the caller. A no, a gone
  client or a closed terminal is a notice to the caller. The link is the spawned
  teammate's: it ends when the agent exits and the lead may close it at once. `release`
  (`to`) ends it from the lead's side and notices the terminal; anyone else is refused.
  The person ends it with `terminals.release` (a no-op for a terminal with no lead),
  which notices the terminal and its former lead, and drops the lead's messages to it that
  were not delivered yet (their sender is told the user released it). The brief is cleaned as
  any message is before the person is asked, so they approve exactly what is delivered, and
  the approval holds only while both terminals run the same agent sessions they did when asked.
- **Closing terminals** comes from the same server's `close_terminal`, listed only
  inside Novadeck's terminals like the others. An agent closes another terminal of its
  project and session, an agent's or a plain shell, by its exact handle, as `send`
  names its recipient; any other `to` is refused with the terminals there described, as
  `send` refuses one. Its own terminal closes a half second after the answer, which ends
  its session; a teammate it leads, and a terminal that runs no agent, close at once;
  any other terminal that runs an agent closes only once the person confirms. That ask
  goes to the client that subscribed last to `terminals.approvals` (refused with none),
  one at a time for each terminal, and the call answers at once, as Codex's tool call
  would time out waiting; the person's `terminals.answerApproval` closes it or keeps it,
  and Novadeck tells the asking agent either way with a notice. The ask is withdrawn
  when either terminal closes, and settled with a notice that nothing closed when the
  client goes away; a client that resubscribes is not sent the asks of its earlier
  stream. Its description tells agents to close only a terminal they are done with or
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
  listed only inside Novadeck's terminals like the others: an agent messages another
  terminal of its project and session by its handle, such as `@moth`, which `open_terminal` and `open_agent`
  also answer with, and the message reaches that agent through its own hooks. The runner
  keeps the messages with the workspace and lists, pauses and releases them through
  `messages.list`, `messages.pause` and `messages.release`. Its `agents` listing carries
  the summaries the terminals' agents gave through `summarize`. See
  [Agent messaging](agent-messaging.md).
- **Pages** are any http(s) address; an address with a user name or password is
  refused. The desktop app loads them live in the pane, in Electron's `<webview>`,
  which lays out with the pane, keeps Novadeck's menus and cards above it, and lets a
  later highlight mode reach into the page. Whatever the element asks for, the host
  gives each one no preload or Node, a sandbox, and the `persist:novadeck-pages`
  session, kept on disk apart from the app's so a sign-in lasts in every page and
  after a restart, where every permission and download is refused and no file loads.
  Its own links and redirects go only to http(s) addresses. A window it opens goes
  through only right after the person clicked or typed in it, one each, so a page can't
  open tabs on its own: a popup the page sized, as a sign-in's, opens in a window of the
  app on the same session, guarded the same way, so the sign-in lands there; anything
  else opens in the person's browser. A frame from another site in the page can take
  that one window, as Electron doesn't say which frame opened it. A passkey sign-in
  that names no passkey asks the person which, when more than one fits
  (`libraries/viewers/src/browser-host.ts`). Where the host can't, as the web version, a
  page is a link to open in the browser. Each show of a page loads it afresh: the
  page's content carries `shown`, its item's version, and a later one reloads it, past
  the cache so changed styles and scripts show too, or loads the address it was shown at
  if the person went to another document. Shown at a
  `#fragment` of the document the person is on, it reloads, then goes to that fragment,
  since loading another fragment of a document only moves within what it already held.
  A show's `scroll` goes with that show alone, so the runner keeps it in memory, not
  with the item: the viewer brings the element into view once the page has loaded and
  reached the shown fragment, waiting a few seconds for one a page draws later. A show
  that gives none at a fragment brings the element with that id into view instead (not a
  text directive's `:~:` part or a hash router's `#/` route), since a reload keeps where
  the person had scrolled. A show at an address the pane isn't showing builds a new view
  of it, which loads with the normal cache. It keeps
  the show it carried out with where the person took the page, so a viewer mounted again
  in the same window for the same show opens where the person was, as a show already
  carried out, and doesn't scroll.
  A live pane also reports what goes wrong on the page to the runner
  (`companions.pageTrouble`, with the show of the document that had it): errors the page
  logs or throws and a load that fails outright, which the viewer sees in the view's
  events, and the requests of the page's own origin that fail (the page itself, a frame, a
  script, a fetch...) with an HTTP error or no answer, which the desktop app's main
  process sees on the pages' session and hands to the viewer through the app's preload,
  not from the page's own performance entries, whose buffer fills and which can't tell an
  abort from no answer. A request cancelled, as by a page that aborts its own fetch, is not
  a failure. It reports only while the page is on the origin it was shown at, so nothing
  from a page the person browsed to elsewhere or from another site's frame; only on the
  desktop app, as the web version loads no page live; at most 20 troubles of any kind for
  a document (the count starts anew when the main frame navigates or a load of it fails
  outright), in calls of at most 20; the main process passes on at most 100 failed requests
  of a page view, from each origin, for each navigation of its main frame; and best effort,
  a failed call is dropped. A page at rest as its picture has no view, so it tells nothing
  until it wakes: an agent's show wakes it once its pane is on screen, so each show's load
  is watched then, while one shown into a pane out of sight, or that no pane shows, waits
  for it, and what breaks later on a page nobody is at (a dev server's hot reload) goes
  untold until it wakes again. Errors count as the page logs them, so a framework's dev
  warnings sent to `console.error` count too. Each wake loads the page afresh and tells again, which the runner keeps once per
  show. For a page on this machine the runner tells the agent at its next prompt.
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
current version, never a stale copy. Project documents are never retained by Novadeck.

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

The initial task is a message: the new agent starts with Novadeck's doorbell as its
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
