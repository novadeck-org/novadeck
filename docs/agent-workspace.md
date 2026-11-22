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
send, spawn, show, interrupt and close, plus separate account-telemetry access.
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
  show(caller: Caller, input: ShowRequest): Promise<ShowOperation>
  reportPlan(caller: Caller, input: PlanReport): Promise<PlanSnapshot>
  operation(caller: Caller, id: string): Promise<OperationSnapshot>
}

// What is implemented keeps only pointers: a companion item points at a workspace file,
// a page or a plan slot and is read when it loads (see Companion pane). An `artifact`
// source holding bytes of its own is not built.
type DocumentSource =
  | { kind: "workspace-file"; path: string }
  | { kind: "artifact"; artifactId: string; revision: string }

type ShowRequest = {
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
   calls `documents.show` with kind `document`, a workspace-relative path and idempotency key.
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
`show` request. Native child plans appear in the plan/attention list; they do
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

An explicit `documents.show` for content already associated with the current
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
the terminal (inside its window; in a window 864px wide or less, as every Canvas window is, it covers the terminal).
Nothing opens on its own unless the user asked for it; everything else waits in the
taskbar, marked new.

What belongs there is a deliverable: a file or page the task itself calls for that the
agent's reply can't carry, made to be looked at (an image or screenshot, a rendered page or dev server, a mockup or diagram, a
rendered document such as a PDF, the one file the user asked for, or an existing file or page, or the working tree's changes, that they ask to see), shown
once it is done, with `open` so it opens at once; without `open` for anything supporting, which
waits marked new. It is defined by what the task calls for and the reply can't carry, not by kinds of
document: when the list named "a report" or "a generated document", agents wrote answers
that belonged in their reply to a file just to show them, and with "the task calls for"
alone, a task asking for a write-up still read as asking for a file. Asking to see is
bounded the same way: "or whatever they ask to see" turned "show me the plan" into edits made
only to have a diff to show, so it is an existing file or page, or the working tree's changes,
that they ask to see, and what the reply
can carry stays there. A page is one the agent serves or just deployed, such as a dev server
or a preview: a link to someone else's site often wants a sign-in in the pane and helps
little there, so it goes in the agent's reply unless the user asks to see it in the pane. A source file counts while it is the one
the user and the agent work on together; the files a change touches on the way do not,
and a change is shown as its diff. The diff is shown when there is a change to show, not
after every piece of work by rule. Every harness hears this two ways, as no plugin ships a skill: the `show` tool's
own description carries the rule, which every harness reads alike from `tools/list`,
and the runner's prompt-time hook adds Novadeck's companion notice, one paragraph, at
the first turn the person's prompt or the doorbell begins in each root session, and after a compaction
(`companionNotice` in `terminals/nudges.ts`; it rides with the summary nudge but a
`describe` never clears it; see [Agent messaging](agent-messaging.md), "Nudges"), with
the Inbox notice beside it (`inboxNotice`): the Inbox shows the person a copy when
they're away from the terminal, so a question the agent's turn ends waiting on goes there: through the harness's own
question tool where the agent would use one, which the Inbox shows as it is, else with
`ask`. A
worker another agent runs by briefs alone hears them at the person's first prompt there,
so until then its tool descriptions are what tell it. In Antigravity an injected message
lasts one model call, so there the notices are read once at the prompt and the tool
descriptions are what last; a lasting injection is a gap to probe.

What is shown is a companion item: a pointer to a file, a page or a plan, never a copy,
held by exactly one terminal's bar, one undocked window, or the session's project window,
which holds the one file the person opened from the Files tree and is re-pointed at the
next; no agent's show lands there, and it can't be moved to a bar or undocked. The runner
keeps items and windows (`companions.*`, see [Backend API](backend-api.md)), so they
survive restarts.
Moving an item to another bar or undocking it changes its holder; closing it deletes
it, except that a plan, a terminal's shells or the Messages closed on their own terminal's bar only hide
there, which the UI keeps as presentation. There is no cap and no eviction: an item
that can't be shown stays and says why. Items and windows reach the workspace store
through the backend's seed and actions, as terminals do; the person's moves are
workspace actions the backend makes so. The pane loads content through the backend
port's optional `companions` capability (`frontend/core/src/items.ts`):

| `companions`                                | What it carries                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `follow(target, itemId, { reveal }, on)`    | What an item holds now, then again as it changes: ready with a stamp, or why not                             |
| `save(target, itemId, text, basedOn)`       | The user's edit written to the plan file, unless it changed since stamp `basedOn`                            |
| `openInProject?(target, path, windowId)`    | A file the person opened from Files, in the project window; absent where it can't be                         |
| `repoint?(target, itemId, path)`            | A file's item shown another file of its kind, as stepping through a folder does; absent where it can't be    |
| `changeFile?(target, itemId, path, layers)` | One file of a change for the layers selected: its diff and both sides' text; absent where it can't be        |
| `changeRange?(target, itemId, layers)`      | The files the layers selected changed as one range, with the range's own counts; absent where it can't be    |
| `changeRead?(target, itemId, path)`         | The person read a file of a change: the content's `read` names it until it changes; absent where it can't be |
| `folders?(target, terminalId, path)`        | The folders a typed path may be, for a folder view's path field; absent where it can't be                    |
| `wroteTo?(target, terminalId)`              | The folders outside the project agents wrote in, with who, which harness and when; absent where it can't be  |

A file that may hold secrets is `secret` until the person asks to see it, and `reveal` is the path
they asked for: the item re-pointed to another file reads `secret` again.

A file (the `file` item kind) shows as code, highlighted and numbered, unless its type has a
preview: the previews are a list in `frontend/items/src/kinds/file/previews/`, each naming the
files it takes (by how the name ends), its icon, its view and, optionally, its peek miniature,
and a type joins with one line there. Markdown's is the read-only document with its outline. A CSV or TSV file's is a table
(`previews/table/`, its own small RFC 4180 reader: quoted fields with delimiters, line breaks
and doubled quotes, a byte-order mark; a CSV's delimiter is the comma, semicolon or tab that at
least half its first lines hold, most steadily): the header held on top, each column sorted
from its header (up, down, the file's order; numbers by value, empty cells last), numbers to
the right, each row led by the line it starts on, and where it was scrolled and sorted kept as
the code viewer's place is. Past 200 rows it draws only the rows in view (`rows-window.ts`),
its columns held to widths from all its rows' text, so a data file read whole stays quick.
A long cell shows its first six lines, and, where it runs past them, a Show all button under
it shows it whole and back (kept with the place); shown short again, its row's top comes back
into view.
What the runner read of a long file is only part of it (its start, or the lines around those
pointed at, whose rows it marks and opens at, up to its budget), and the table says so under
it: which lines, that a first line too long to read whole came cut, that it shows only the
first 1,000 columns, and that lines pointed at past the file's end were pulled back to it.
Lines past the file's first have no header, so their columns are lettered, and may start
inside a quoted record, so the table starts at the first line from which the rows read whole
(weighed on the first 256 lines). A quoted field the part cuts off in its last 64 lines ends
there; a quote never closed in a file shown whole, or open longer in a part, reads as text
from its record on, as a TSV's inch mark. Each
column's decimal mark is the one all its numbers read with (a comma first in a semicolon file),
and digits led by a zero (IDs, postcodes) are text.
An HTML file (`.html`, `.htm`) is drawn as the web page it is (`previews/html.tsx`, `HtmlViewer.tsx`;
its frame and viewer load only when one shows). The runner reads it whole like a data file (up
to 2 MiB; one cut short shows its source, saying so), and the viewer reads the stylesheets,
pictures and fonts it names, and what those name in turn (`@import`, `url()`), by their names
from the page's folder, through `companions.part` with `file` (a page's own: any style, picture
or font in the page's folder or under it, `..` and links out of it refused, never one that may
hold secrets; at most 64 files, 16 MiB each and 32 MiB all told). The page is then built from them
(`libraries/viewers/src/html/page.ts`: stylesheets as `<style>`, pictures and fonts as data
addresses, scripts, frames, plugins, `<base>` and refreshes taken out) and drawn in the viewers'
sandboxed frame (see SECURITY.md), so nothing in the page runs and nothing it names beyond those
files is fetched. A file the page was drawn with is part of the item's content: the runner adds
the stamps of the files the pane read to the page's own, so saving a stylesheet beside it, as well
as the page, draws it again; a page that comes out the same as the one drawn is left alone. A file
with a preview opens on it, with a Show source tool in the pane's row (Ctrl+Shift+V, ⌘⇧V
on a Mac, from anywhere in the file) that switches it to the bare file in the code viewer and
back. A preview's own tools join the row before it (`usePreviewTools`); one that can't read its
file says so in its body, the switch still there. The choice is the item's, for the file it
shows: it holds while the pane is built again, as across Focus, Grid and Canvas, for the files
lately switched, isn't saved past a reload, and another file the item is pointed at (as the
project window's is) opens on its preview. A plan is its own kind and has no switch.

JSON, JSONL/NDJSON and YAML files preview as a tree (`previews/data.tsx`, drawn by
`@novadeck/viewers/tree`): objects and arrays open and close, a closed one shows its first
entries and its count, and a row copies its value or its jq path. Only the rows in sight are
drawn; what's open and the scroll are kept by item. JSONL reads one row per record, a record
that doesn't read showing why; YAML reads anchors, merge keys and several documents. A preview
can send its file to its source with a note: a whole file that doesn't read goes there once per
load, its note saying where it stops, with that line pointed at. A data file (JSON, JSONL,
NDJSON, YAML, CSV or TSV, the protocol's `isDataPath`) is read whole from its start, up to 2 MiB
(`companionLimits.data`, each line's break counted) of whole lines, none cut but a first line
that alone runs past it, while other text
files are read up to 400 lines around what was pointed at, each cut at 4,096 characters. When
the lines pointed at lie past a data file's budget, it's read the same way from 40 lines before
them. A data file past its budget arrives in part: a JSONL file shows the records it holds,
and a JSON or YAML file says only its start came and offers its source. Its source draws at
most 2,000 lines, around the line pointed at, and its miniature its first 40.

A change (the `changes` item kind) is read-only and has two views, in `frontend/items/src/kinds/changes/`,
on the pane's own ground (`--pane-bg`). The **list view** is where it opens: a row for the work
not committed yet ("Uncommitted") and one for each commit since the merge base with main, newest
first (short hash, subject, time, `+N −N`), then a "Files" tree, as the Files panel draws its
own, of what the selected rows changed together (for one row its own counts, for a range or all of
them the range's own as git lists it, names coloured by how the file changed, folders with guides), and a hint line saying what a click does. All rows are
selected to start; the selection is a 2px `--color-strong` rail on a row's left edge, joined across
selected neighbours, growing and shrinking by scale and opacity and sliding its ends over
`--motion-state` (none under reduced motion). A click on a row keeps only that row, a click on
another row keeps only that one instead, and clicking the row kept alone is all again. A
Shift+click (or Shift+Enter) takes every row from the row clicked last (the anchor) to it, either
way, and another moves the range's end from the same anchor; with no row kept it is a click, and a
range of every row is all again, so later commits show too. A selection is all the rows, one, or
one unbroken range (`selection.ts`), whose files `changeRange` lists. A file the person opened is gray in the tree, in
any selection, until the file changes again: the runner keeps it read (`changeRead`, in the
content's `read`), across restarts, and the pane grays it at once until the content comes again. One click on a file unfolds what it changed under its row, one file
at a time, as `.terminal-tab-branches` unfold a terminal tab's subagents (├ └ rows with the
tab's own fold and transition), each a fact (where the change sits, `+N −N`), with "Open diff ›" under them; that, a double click,
Enter, or the `›` at the row's end (shown where the pointer is, on the unfolded row, and always
where nothing hovers) opens the file. The **file view** is the row grown into a plain heading (‹ back, the folder
dim and the name in body type, the file's counts, ⌃ ⌄ and "N of M" within the selection), a line of
what the file came to, and its changes, each headed by where it sits ("2/4 in requireUser()", "new
refreshSession()") and the lines it spans; a change past 36 rows shows its start and end with
"N more changed lines · +N −N · Show", and the unchanged stretches between changes are folded
with a click to show them. Esc or ‹ shrinks the heading back into its row; J and K step through
the selection's files. Lines are unified, in classic green and red from the
theme's own `--color-success-fg` / `--color-danger-fg` inks (a sea green and a rose in Coolant),
carried by the gutter: the number and sign sit on the ink at 20% (18% on a light scheme), the line
on the ink at 5% (7%), with no bar. The changed tokens of a replaced line are marked, each
changed run one mark at the ink's 30%, and lines whose tokens are the same with other
whitespace are shown once as plain lines and counted apart ("+4 −6 · 4 re-indented"). Monochrome
themes read by the `+` and `−` signs.

What it says of a change is facts only, computed in the page from the two sides' text with the
Lezer parsers the viewers highlight with (`libraries/viewers/src/facts.ts`), when a file is
unfolded or opened: the declaration a change sits in (top-level, exported and class members, not
inner locals), declarations new, removed or changed, imports added and removed by name, test
titles (`it`, `test`, `describe` with a string first argument), the exact tokens of a small edit
(`cookieMaxAge 7 → 30`), and, in Markdown, the heading above a change. Other languages say the
lines a change spans. Never why. A file's answer is kept by the item, its stamp, the layers
selected and the path. Where a side passes 512 KiB, or the file's diff passes the bounds, the
change is only its lines (no facts); a binary file or one that may hold secrets shows a note. Its
look is `changes.css`, and the pane keeps what the person picked and opened, by item, while the
page lives.

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
  source's own options inside: a `file` (its path and optional lines, or for a video or recording `at`,
  the second its show starts it at, which only that show carries out), a `page` (its
  `url`, and optionally `scroll`, a CSS selector of the element to bring into view once it
  loads) or `changes` (`{}` or `{ path }`: the whole change in a repository, see below);
  beside it the options every source shares, a title and `open`, which the agent
  sets for a deliverable it finished or one the user asked to see (`openAsked`); the app
  opens it at once only on the terminal the person is on, and otherwise lets it wait with
  a toast until they go there (development.md, "Plan review design preview"). A new kind
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
  answer says. A video (`.mp4`, `.m4v`, `.webm`, `.mov`, kind `video`) or an audio recording
  (`.mp3`, `.m4a`, `.aac`, `.wav`, `.ogg`, `.oga`, `.opus`, `.flac`, kind `audio`, played as the
  whole pane with its name and a waveform, not a picture) is played with the pane's own controls: its content is its format and size, never its bytes, which the UI
  reads with `companions.part`, 2 MiB at a time while the file is as its stamp names it,
  and plays whole from a blob, so the desktop app, a browser and the demo play it alike.
  Rendered again, it reloads where the person was; one over 512 MB loads as too large to play.
  A PDF (`.pdf`, kind `pdf`) is read the same way and drawn page by page with pdf.js in a
  sandboxed frame of no origin and no network (see SECURITY.md), so the desktop app and a
  browser show it alike: only its pages are drawn, so a link in it goes nowhere, no form or
  script it carries runs, and nothing it names is fetched. It opens fitted to the pane's width, and keeps its page and zoom across views,
  windows and a rewrite of the file; one over 128 MB loads as too large to preview, and one
  locked with a password, or that isn't a PDF pdf.js can read, says so in the pane.
  A 3D model (`.glb`, `.gltf`, `.stl`, `.obj`, `.ply`, `.3mf`, kind `model`) is read the same
  way, with the files beside it that it names (a glTF's buffers and textures, an OBJ's material
  libraries and theirs, in its folder, none that may hold secrets, none at an address of its
  own), and drawn with three.js in the same kind of frame: it opens fitted on a grid, turns,
  moves and zooms, toggles wireframe and flat shading, plays a glTF's animation, and gives its
  size in millimetres where its format has units. Rewritten, as a CAD loop writes it again, it's
  drawn from where the person was looking; one over 256 MB with its files loads as too large to
  preview. Its peek is a still of it.
  A folder (`show {"file": {"path": "<dir>/"}}`, or the person's "Open in the pane" on a
  Files panel row, kind `folder`) is listed, read-only, as a grid of thumbnails or a list
  (newest first, or by name or size): the runner reads its entries (name, kind by extension
  (an `.obj` by its first bytes too, so a compiled object file is a plain file, not a model),
  size, modified time, and what a folder inside holds), watches it with the file system's own
  watch (a few events together, at most about four reads a second; a folder deleted and made again
  is watched anew), plus a poll for what a watch can't tell, as on a share or under a link that was
  retargeted: every 20 s while the watch works, and every 3 s where it can't watch at
  all, as for a folder that is gone, which is polled for until it is back. It pushes the listing again as files land, which the pane draws on top, or
  holds in a "N new files" pill while the pointer is in the grid; a file whose size is
  changing shows the Files panel's write cursor. A folder with files landing behind another tab
  makes its taskbar icon new. Double-clicking a folder goes into it in the same tab, never above
  the one that was opened (the crumbs start there); double-clicking a file opens it as an item
  of its own kind on the terminal's bar (`companions.attach`), as if shown, so it goes to that
  kind's group. An entry's menu (right-click, the menu key or Shift+F10) offers Open,
  Open as text, Quick look and Copy path; a folder's has Open and Copy path, and a secret or a link
  out only Copy path. Open as text, and Alt+double-click, open a file on its source (the file
  preview's "Show source" switch, kept per file as that switch keeps it): only a file whose type
  has a preview with a source, by its name (Markdown `.md` and `.markdown`, tables `.csv` and `.tsv`, and
  data `.json`, `.jsonl` and YAML), has it, and any other opens as usual. Space
  is a quick look, a floating peek over the pane that opens no tab: an image larger, a video's
  first frame and length, a kind registered through `registerEntryThumb` by its renderer, and
  for anything else (text, a PDF, a recording, a file too large, a secret) its icon, kind, size and
  when it changed; it reads files only as the thumbnails do (never text or a PDF's content). ← and
  → step through the files (folders skipped), Enter opens the file in a tab, Space or Escape or a
  click outside closes it, and focus goes back to the folder. It is transient, not modal: a press or focus outside it, or its file going or the folder
  changing, ends it (a click into the terminal keeps the focus it took), Tab stays in it, Backspace
  and Alt+Up, which would go up behind it, do nothing, and a key held down (Escape too) acts once. When the pane covers its terminal, a folder's entries keep only Space (the look); any other letter
  typed there still uncovers the pane and goes to the terminal, Backspace and the arrows were never
  characters, and Escape hides the pane unless a look is up, which keeps all its keys (`data-pane-keys`
  in `homes/terminal/cover-keys.ts`; the folder's is `"space"`). Nothing in it is harness-specific.
  "Show in Files" isn't offered, because Novadeck has no reveal-in-system action for a path yet.
  A file open on a bar's pane or in an undocked window (an image, video, recording,
  PDF or text file; not the project window's, which keeps its one file) that lies under the top of
  a folder item of the same session, on any bar or in a window (the one on the file's own holder if
  there is one, else the deepest top), has ‹ and › in the row's tools, which step it
  to the folder's previous or next file of the same kind: in the folder's own sort (newest first
  unless the person changed it), never a folder, a file that may hold secrets, a link out or a link
  that stays inside (each file once), or what is no regular file; they show only once the file's
  place among them is known, and not round the ends, where they show off. A step that fails says
  so in a line under the viewer ("Couldn't open b.png: …"). Stepping points the same item at that file
  (`companions.repoint`), so no tab comes or goes and the pane stays in its group; what the bar
  held under the new file's pointer goes. The listing it steps through is one the file follows
  for itself, beside the folder tab's, which stays where it was. ← and → step an image,
  unless it is zoomed in and pans; a video and a recording seek by them, a PDF turns pages, and
  a text file's caret, scroll and data tree move by them, so those step by the tools only.
  "Show in <folder>" brings the folder item forward, in the folder the file sits in, with the file
  selected and scrolled into view (a file in a window has no such tool, as a window can't bring
  another item forward). ← and → work with focus anywhere in the pane or window, the tool row
  included, and the pane takes focus back when the viewer that held it is drawn again for the
  next file. None of it is specific to a harness. Thumbnails of images up to 2 MiB, and of videos up to 24 MiB (their first frame
  and length, drawn by the page), are read through `companions.part` with the file's own stamp,
  lazily and nearest first; a PDF, a recording and a text file show their kind's icon. It is
  the same for Claude Code, Codex and Antigravity, as the runner reads the folder. Secrets
  follow `companions/secrets.ts`: a folder that may hold secrets (by its name, by what lies under it, as gcloud's, or as one the person's environment moves a tool's logins to, as `GNUPGHOME`; judged by the name it is asked by, each name its links lead through and where it leads, so a `.ssh` that links to `keys` is one, and so is a `stuff` that links to that `.ssh`) is refused (`show` answers
  with why, and nothing in it is listed), a secret file or folder inside one is named and
  flagged, never opened, counted, read or given a thumbnail, and a symbolic link that leaves
  the opened folder is listed as a link and never followed. Of a folder holding more than 2000
  entries, the first 2000 by name are listed and the pane says so.
  The first line's path is typed over with Ctrl+L (Cmd+L on a Mac) while the folder view has
  focus, or a click on the path's text (a crumb still goes to its folder): the line becomes a text
  field holding the folder's absolute path, selected. Escape, or focus leaving, puts the crumbs
  back. Enter opens the typed path as a new tab on the terminal's bar through `companions.attach`,
  with its own top, so Up still stops at what was opened: a folder opens as a folder, a file in
  its kind's group, a path that is neither shows the runner's reason (`INVALID_FILE`) under the
  field, and `~` is the person's home. Under it a floating list, a combobox (up and down move,
  Enter opens the highlighted one, Tab completes it into the field), offers in this order,
  each group only when it has something: the folders the typed text may be
  (`companions.folders`, none until the text is changed from the folder's own path); folders an
  agent showed in the session, with its handle and how long ago (the workspace's items, by an
  agent); folders agents wrote in outside the project (`companions.wroteTo`: the handle, the
  harness and how long ago, from the `file-touched` events of Claude Code, Codex and
  Antigravity alike, named in `work.wrote`, which keeps the latest 20 folders outside the one
  the terminal works in, with the time, in the terminal's own record so it outlives a restart;
  what a shell command wrote is told by no harness and is not listed); and folders the person
  opened in the session. The suggestions come from the session's items as they stand when the
  field opens; nothing new is stored for them. Showing the same file or page again updates the item on the agent's own
  bar, or else the latest it showed that the person moved into a window or onto another
  bar, where it stays. Items are told apart by a file's real path or a page's `pageKey`
  (`protocol/src/pages.ts`): its address without the fragment, or for a server on this
  machine (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0` and `[::]` alike) its scheme and port
  alone, so a dev server stays one item whatever route the agent shows. A file that often holds secrets (`.env`,
  keys, credentials, agents' and tools' logins, shell history) is secret, a login also where a
  variable of the person's environment moves its tool's folder or names its file (`CODEX_HOME`,
  `GH_CONFIG_DIR`, `KUBECONFIG` and the like; `companions/secrets.ts`): it never opens
  by itself, even when the agent says the person asked (one the person attached themselves does
  open, onto the pane's gate: they picked it); the pane never falls back to
  it, its taskbar peek shows no preview, and it goes by its own name, not the agent's
  title. So none appears unasked while they share their screen. A file that resolves
  to such a file only later is secret when it loads. The server's `showing` tool lists
  what the agent's bar holds now, with where each item points and who put it there,
  then what it showed that the person moved elsewhere. Its `look` tool pictures one of
  the pages there (see [Agent messaging](agent-messaging.md), "Looking at a page").
  The UI follows each item with `companions.content`, never by path.

  A **changes item** (`show { changes: {} }`, kind `changes`) is a git repository as a
  set of diffs, the terminal's by default. An agent that works in another folder or
  worktree gives `changes: { path }`, a folder inside the repository (absolute, or from the
  terminal's directory; a file stands for its folder), and `close` takes the same, even
  once that folder is gone (a worktree removed): the item shown from it is found by where
  it was shown from. The item is the checkout measured against the repository's main branch
  (`refs/remotes/origin/HEAD`, else `main`, else `master`, as for Works; `HEAD` itself where there is
  none), in **layers**, newest first: the work not committed yet (the working tree, untracked
  files included, ignored ones not, taken as a tree through a private index so the person's
  own is never written, under the snapshot's 1 MiB limit for an untracked file), then each commit
  from the merge base to `HEAD` (following first parents, at most 100), each diffed against its
  parent with renames found, whoever edited them. A **merge** is shown as what it did itself: it
  is diffed from its first parent with main's work it holds merged in, in memory (`git merge-tree
  --write-tree`, its objects in a private folder), so a merge of main is usually empty, a
  conflict it resolved shows the resolution, and a branch of the checkout's own that it merged
  shows as its work (only main counts as brought in). Where git is older than 2.38 (no
  `merge-tree --write-tree`) a merge is diffed from its first parent and its layer has
  `firstParent` set, which the list says. Before the first commit it has no layers.
  It is one item per repository on a bar, keyed `changes:<repository root>` (folded to lower
  case on Windows) and named "Changes · <folder>", or "Changes · <folder> · <branch>" for a
  linked worktree on a branch (worktrees of one repository share their folder's name),
  unless a title is given; showing it again updates it. Its detail counts the files the change
  as a whole differs from main by and their lines (the net, not its layers added up), and follows each read the pane triggers. The content
  (`companions.content`) is each layer's files with their counts, and the whole change's own list of files (the net), not their diffs; for every layer selected the pane reads that list, and for one layer that layer's own files, and for a range of two or more `companions.changeRange`'s list (the layers' files added up until it answers, or where the backend can't): it is read
  with git at the start and again about every 2 seconds while followed, and sent only
  when it changed. One file's diff for a selection of layers is `companions.changeFile`: the
  selection is one range, diffed from the oldest layer's parent to the newest (the uncommitted
  layer from `HEAD` to its tree). Where the range contains a merge, it starts from that parent with main's
  work as the range's end holds it merged in (in memory) where the parent lacks it, so the range
  shows its own work only; only a range that reaches the oldest layer starts at the merge base
  (for the newest layer's commit, where that commit left main), so the whole of it is
  `git diff main...HEAD`. `companions.changeRange` lists the files of a run of layers over the
  same span, git's own listing for the range (a file added and dropped inside it is not there, a
  rename is one row, the counts are the range's) up to the file bound, with `truncated` where more
  exist; in a compare, of the compare's layers.

  A **compare** is a changes item of two refs an agent names, for a person who asks to see a
  branch's commits, a run of commits or two branches side by side: `show { changes: { base?,
  head?, path? } }`, with `base` defaulting to the repository's main branch (by its name, as
  above) and `head` to `HEAD`. A ref is anything git reads as a commit (a branch, remote
  branch, tag, hash or `HEAD~5`), never one that starts with `-` or holds `:`, white space or a
  control or invisible format character. It is read as the checkout's change is, with `head` in place of `HEAD` and
  `base` in place of main: `head`'s commits since its merge base with `base`, newest first, at
  most 100, so the whole of it is `git diff base...head`, and a run of commits is the ref before
  the first as `base`. It has no work not committed yet and takes no snapshot. It is an item of
  its own beside the working tree's, keyed `changes:<repository root>\n<base>...<head>`,
  named "Compare · <folder> · <head>", kept with its refs (`compare_base`, `compare_head`, as
  the agent named them, read again each time, so a branch that moves moves it), and its
  content names `head`, which the pane reads to link no pull request (the checkout's isn't
  its). The files read in a compare are its own, kept in memory with its listing for the 32
  compares read latest (the checkout's own marks keep only what its work changes), so they
  don't outlast the runner. `close` takes the same refs; a ref git can't find refuses the
  show, naming it. A repository whose worktree goes takes its compares with it.

  **Remote refs in a compare are kept current.** When `base` or `head` names a remote-tracking ref
  (`origin/x`, or the default main base, which `origin/HEAD` names), `show` first makes the repository's
  origin current with `MainFetcher.fetchBriefly`: nothing if it was fetched in the last minute, a fetch
  under way is shared, and the call waits at most five seconds while the fetch keeps its usual limit and
  carries on (the open compare's next read, within the changes poll, finds what it brought); a remote that
  hangs or fails leaves the refs as they were. For as long as such a compare is on a bar its repository
  stays on the fetch schedule (every five minutes, as a tracked worktree's is) though it has no tracked
  worktree: `Worktrees`' `repositories` host hook adds it to what each look fetches, and its state is
  forgotten once the compare closes (and not while a fetch is under way or was within the period).
  Only `origin` counts: a ref of any other remote (`upstream/x`) is never fetched and has no note, and a
  name `origin/x` that git doesn't know yet is taken for one a fetch may bring, so a branch pushed since
  the last fetch can be shown; a local branch named `origin/x` is none. The person's checkout is not
  fast-forwarded by such a fetch (see "Fetching"): that follows only for a repository with a tracked
  worktree, by its scheduled fetch. The content of such a compare carries `origin: { fetchedAt?, failed? }`, which the
  pane's header turns into a quiet note only where freshness is in doubt: "origin fetch failed · last
  fetched 3 h ago" (the reason in its title), "origin last fetched 3 h ago" once over an hour old (both
  amber, as the Worktrees panel's age is), or "origin not fetched yet". Fresh, it says nothing.

  One snapshot service (`backend/runner/src/checkouts/snapshots.ts`) takes the working tree for
  both the changes item and the Worktrees panel (Works), so a checkout both read is taken once:
  a snapshot younger than 1.5 seconds serves whoever asks next (an agent's show and a look
  take their own). Each checkout has one private index file, and each repository one private
  object folder for all of its worktrees, which the objects a snapshot or an in-memory merge
  writes go to (with the repository's own as an alternate, quoted in
  `GIT_ALTERNATE_OBJECT_DIRECTORIES` so a path with `:` or `;` in it reads), never the person's
  store. The folders live beside the Worktrees panel's memory file (`works-objects/`, one per git
  common dir) and are rebuilt every 300 snapshots, once nothing is using them, to what the
  trees the works were last read as reach, so the read marker survives a restart. The panel
  counts a work's files as the item does (renames found, whitespace ignored, re-indented lines
  apart), so a row's `+N −N` is its pane's.

  **The Worktrees panel** lists **works**, and a work is a tracked git worktree: a row of the
  `worktrees` table (see "Worktrees"), keyed by its root, whatever the Preferences switch says
  (with it off, the worktrees already tracked still show; terminals' plain checkouts are not works).
  Each work is `{ root, terminalId | null, projectId, working, branch, base, firstSeenAt, merged, files, … }`:
  the owner comes from the table (null once orphaned), never inferred, and a worktree that differs
  from nothing (just made, or merged) is a work with no files, first seen when it was recorded; `merged`
  tells the two apart: it is true when nothing differs and the worktree has commits of its own since
  it started that main holds (by content, as squash and rebase merges, or by history, off main's
  first-parent line). It is true too for a worktree that conflicts with main because main changed
  the same lines again after its work landed: a commit on main's first-parent line since the two
  parted, which merging the worktree into changes nothing (`landedIn`, which tries the commits that touch
  its files once all of them have been touched, oldest first, at most 32). Such a work lists no
  files and conflicts with nothing, and the panel lets merged win over a conflict. Work that merges
  cleanly but would change main (main reverted it) is not merged.
  It is not the close side's "merged" below (HEAD is in main, which a fresh
  worktree is too). It is
  measured as before: the working tree against main by an in-memory `merge-tree`, with what is unread
  and what conflicts with main or another work (named by root, and its owner if it has one). A row
  shows the owner terminal's title, or "No owner", its size, then the owner's handle and the branch,
  and under them what it says in words, most telling first: a conflict ("Conflicts with
  origin/main", or with another work's owner) or a failing CI in red, Working, the pull request's
  state followed by its number (a link to its page: No PR yet, Draft, Ready for review, Merged, PR
  closed; nothing while no forge is on), its CI (running, passed, no CI), commits not pushed and,
  on a done one that isn't safe, files not committed, in amber, and "safe to trash" in green. Its
  icon is that first fact (a red triangle or cross, the Terminals panel's spinner while its agent
  works, a merge, closed, ready or draft pull request glyph, else a branch). Rows stand in groups by
  what is next (`worktree-rows.ts` `groupOf`): Needs you (a conflict, or its CI failing), In progress
  (no pull request), In review (an open one) and Done (merged, or its pull request closed), newest
  first in each; Done folds (kept in this browser) and holds Trash N safe, which closes every safe
  row, unforced, after one confirm that lists them, saying above the list why any that stopped
  being safe stays. A safe row's trash button shows at rest, in green. Over the groups, a line says
  how old the remote's main is ("origin/main, 12 min ago", the oldest fetch among the works
  measured against a remote's main; amber once an hour old) with Fetch (`works.fetch`). Sizes are
  neutral: red is only for what needs the person. The panel lists only the open
  project's worktrees (the runner reports every project's, and the UI keeps those whose
  `projectId` is the open project's), and a click
  shows the work as a changes item on the owner's bar (a work with no owner, on the selected terminal's:
  `works.show({ root, terminalId })`). `working` says the owner's agent is mid-turn in this very
  worktree (its activity is working, or a shell command runs, and its current checkout is the
  worktree). The row's trash button calls `works.close({ root, force })`, which closes the worktree with the
  person as the actor, through the worktrees service's removal (see "Worktrees": uncommitted work, and commits only a detached HEAD reaches, are kept on
  `refs/novadeck/kept/` refs, and the branch goes only when Novadeck made it and main holds all of
  it). The panel
  always asks the runner to close unforced; the runner's own standing decides, not the files the row
  lists. A worktree is merged when HEAD is an ancestor of main, or merging it changes nothing, into
  main or, where that conflicts, into the commit its work landed in (the test Works uses, so squash
  and rebase merges count, also once main has changed the same lines again) and holds no uncommitted file, and then it
  closes with no question. Otherwise the runner answers `closed: false` with what it holds, and the
  panel asks (committed work stays on the branch, uncommitted work and commits only a detached HEAD
  reaches are kept on refs, ignored files like `.env` are not kept), forcing the close only once
  confirmed. The close is queued in the worktrees service (the row looked up there, and a fresh check
  that no terminal's current checkout is the worktree with its agent working or a command running),
  so it can't race an agent's take, give or close; a command run elsewhere with `git -C` into it is
  not seen. The trash button waits while `working`. A refusal (`CONFLICT`, with the service's reason: git
  status unreadable, submodules, a git repository of its own inside that holds work) shows above the list, as does a work that can't be shown; a
  worktree an agent closed meanwhile counts as closed. A work whose owner is closed (in History)
  shows on the selected terminal's bar. With no works the list says what appears there. The panel
  and its rail toggle show only while Preferences → Experimental → Agent worktrees is
  on (`useWorktreesShown`), so a stable build, which turns that setting off, has no Worktrees panel; a
  link naming it then opens Terminals. A closed worktree's memory goes with it (`works.json` and its snapshot).
  A work also carries what it holds that lives only in its worktree: `uncommitted` (paths changed and not
  committed, read from the snapshot the pass already takes: the working tree as a tree against HEAD's
  tree, one `git diff-tree` run when the key changes, plus the untracked files the snapshot leaves
  out) and `unpushed` (`git rev-list --count HEAD --not --remotes`, one cheap run on every read, as the
  remotes move without the key changing), and `safe`: `(merged && uncommitted === 0)` or `(its pull
  request closed && uncommitted === 0 && unpushed === 0)` (`works/standing.ts`), never while its pull
  request is open or a draft. A merged work ignores `unpushed`: its remote branch is often deleted after
  a squash merge, which leaves its own commits unpushed. Each is absent where git couldn't say. The
  person's unforced close (`closeWork`) of a work that is `safe` by a fresh read goes through
  `Worktrees.closeAt` with `safe`, which skips the refusal for commits main lacks (uncommitted files
  still refuse); the agent's `close_worktree` is unchanged, and the branch stays or goes by the same
  rules. `works.fetch({ projectId })` fetches origin now for the project's repositories
  (`MainFetcher.fetchNow`: all at once, each repository's in-flight fetch shared, a failure leaving its
  schedule alone), then reads those works again, so `fetchedAt` and main move before it resolves.
  A work's `pullRequest` comes from the forges (`forges/service.ts`): its `ci` for an open one is how
  its checks stand on the latest commit (GitHub's `statusCheckRollup` in the one GraphQL query; GitLab's
  `head_pipeline` from one more request per open merge request; Azure DevOps' build policy evaluations
  and statuses, two more), and a repository is looked up every 5 minutes, or every minute while any
  of its open pull requests has `ci: running` (given up after 30 minutes with no pull request's
  checks changing, until one does). Azure DevOps counts only each status context's newest post and each
  policy's current evaluation.
  A work also carries `fetchedAt`, when the runner last fetched its repository's origin (absent when
  it never has), so a row's tooltip can say "main as of 12 min ago": a PR merged on the remote shows
  as merged here only after the next fetch (see "Worktrees": cleanup and fetching). Worktrees the
  runner removes by itself drop out of the list like one the person closed.

  The Worktrees toggle flares the History toggle's dot and ring once for every worktree the runner
  starts tracking in the open project (an agent's `open_worktree`, or `take_worktree` adopting one;
  not a worktree changing hands); a switch to another project flares nothing for the worktrees
  made there before. The panel's feed is followed only while it shows, so a separate stream,
  `works.made`, carries one event per new worktree for the backend's whole life, without
  replaying any and without reading git; the adapter counts them by project (`Works.made`).

  The files the person read are kept in the same memory file (`works.json`), each by its object
  as the change listed it (all zeros for a file deleted): `companions.changeRead` marks one,
  and the content's `read` names the files of the change whose object is still that one. A
  mark goes once its file is no longer part of the work.

  Reading costs git runs, and a big repository makes each one slow: after a read that
  took over a second, the next waits four times as long (up to 15 seconds), and the
  usual 2 seconds again as reads get fast. A read that fails once or twice (git timing
  out under load) keeps the last good content on screen; a third failure in a row says
  `unreadable`, and a repository that is gone says `missing` at once. The show itself
  keeps the 5 second timeout. A file monitor hook program named by `core.fsmonitor` never
  runs.

  Bounds: a layer lists at most 300 files and a change 100 layers and 2,000 files in all
  (`truncated` says more exist, as it does where an untracked file past the size limit was
  left out of the snapshot). A file's lines count whitespace-insensitively (`git diff -w`): lines
  that only changed whitespace are `reindented`, counted apart. The commits' listings never
  change, so they are kept by pair of commits. A `changeFile` answer reads the diff text up to a
  budget of 4 MiB as encoded (a file past it is `big`: counts, no hunks, no sides) and each
  side's text up to 512 KiB (past it, hunks without sides). Lines are cut at 4096 characters,
  and names show a control or invisible character as U+FFFD.

  A binary file and a file that may hold secrets (the rule for files, applied to the new
  name and the old one of a rename, tracked or not) carry no hunks and no text: they are
  listed by name with their counts, and `changeFile` never reads them. v1 has no way to
  reveal either. An untracked file that may hold secrets (a stray `.env`) is never read or
  hashed into the snapshot, but the uncommitted layer, the change's own list of files,
  `changeRange`'s list and `changeFile`'s run over a range that takes it in name it, `added` and
  `secret`, with no counts.

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
  person would type it, such as `npm run dev`, which opens only once the person approves
  it (an approval dialog shows the exact command, the folder and the asking agent; the call
  answers at once that they were asked, and a notice later tells the agent their answer);
  `focus` brings it into view only when the person asked to see it. `open_terminal` starts no agent: every agent, with or without a
  task (and optionally a `model`, `effort` or a session to `resume`), is started by
  `open_agent`, which makes the caller its lead as `lead` says (by default, when it opens
  with a task). The runner checks the token, reads the request
  strictly, checks the folder, and lets a terminal's agents open five a minute, or
  fifteen when they are teammates (agents it opens led: with a task unless `lead` is false,
  or with `lead` true), counted
  from the same budget, so a lead starts its team at once while other opens keep five, a
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
  already waits for, and when no client follows approvals. Otherwise the request goes to the
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
  any other terminal that runs an agent closes only once the person confirms. That request
  goes to the client that subscribed last to `terminals.approvals` (refused with none),
  one at a time for each terminal, and the call answers at once, as Codex's tool call
  would time out waiting; the person's `terminals.answerApproval` closes it or keeps it,
  and Novadeck tells the asking agent either way with a notice. The request is withdrawn
  when either terminal closes, and settled with a notice that nothing closed when the
  client goes away; a client that resubscribes is not sent the requests of its earlier
  stream. Its description tells agents to close only a terminal they are done with or
  the person asked about, as closing ends whatever runs there. The runner checks the
  token, reads the request strictly, and closes it as the person's close does: it ends
  the shell, removes the terminal and forgets it, even while a window controls it (it
  stays in History for 7 days, restorable as a new terminal, with `closedBy` the caller's handle, unless nothing ran in it), so
  the UI drops it from the layout on `terminals.watch`'s `removed`, as for a close in
  another window. Messages still waiting for it are `gone`, their senders told as
  always; the answer names the agent that ran there and counts them. Messages the closed
  terminal sent the caller that haven't arrived yet (queued or held; one leased is already
  in the caller's harness) are named, by id and time sent, in the answer, or in the
  notice once the person confirms (which may reach the caller with them, so it never says
  "after this"): they arrive, those held only if the person lets them go, and delivery
  marks each `closed="its terminal closed after sending this, so no reply
  reaches it"` on its `<message>` tag, in every harness (the one `wrap` prints them all),
  for any message whose sender closed for good, by an agent or the person. An exited
  terminal, which may run again, isn't marked; the closed set is in memory, so after a
  runner restart a terminal closed before it isn't known closed. A message kept before the
  mark was sized for, which no longer fits with it, goes unmarked rather than block the
  queue behind it. A terminal's
  agents close five a minute, or fifteen teammates they lead, from the same budget, a
  terminal opened on request sharing the budget of the one that began the chain, and all agents twenty a minute across the runner, each
  budget apart from the one for opening, so a runaway loop can't empty the workspace.
  A chain's times, for opening and closing alike, outlive the terminal that began it
  until they pass out of the minute, so its terminals can't start afresh by closing
  it. A terminal already closing is refused as such, at no cost, and a close the
  runner's own shutdown overtakes answers that it failed, the terminal kept as
  shutdown keeps every terminal.
- **Worktrees** come from the same server's `open_worktree`, `take_worktree`, `close_worktree`
  and `give_worktree` (`backend/runner/src/worktrees/`, called from `terminals/calls.ts`). They
  are experimental: listed (the tool listing asks the runner, with the `worktrees` call) and
  allowed only while the person has Preferences → Experimental → Agent worktrees on
  (`runnerSettings.worktrees`); the listing doesn't refresh mid-session, so a call made while
  it is off is refused with a sentence that says how to turn it on. A worktree lives at
  `~/.novadeck/worktrees/<project id>/<group>/<repo folder>` (`worktrees/root.ts`); `group`
  defaults to the branch made safe as a folder name, and two repositories with one folder
  name can't share a group. The `worktrees` table (schema 14) records each one's path, git
  common dir, branch, the commit it `base`d on, project, owner terminal (plain text: a live
  terminal or one in History, null once orphaned), whether it was `adopted` and whether Novadeck made
  its branch (`branch_made`). A terminal may own several, and ownership moves only through agents.
  - **A worktree's home** is the branch its work belongs on (`checkouts/home.ts`; design in the
    workspace's `architecture/worktree-home.md`). Git keeps it, not the table: the runner writes
    `branch.<branch>.novadeckHome` in the repository's own config (shared by its worktrees, never
    committed or pushed), with `novadeckBase` (the commit it started from) and `novadeckMade`
    (Novadeck made the branch) beside it, so git moves them with a renamed branch and drops them
    with a deleted one, and plain `git config` reads them in any harness. Only the runner writes
    them, as an agent's sandbox may hold `.git` read-only. Home is the `home` an agent gives
    (`open_worktree` or `take_worktree`, a branch here or `origin/<b>`), else the branch `from`
    names, else the checked-out branch when the new branch starts from the folder's `HEAD` (`from` left
    out or `HEAD`; commit and branch read in one git call, a lead's worktree on `feat-x` homes its
    teammates' worktrees on `feat-x`; a detached `HEAD`, a tag or commit, origin's branch of its
    name or an existing branch gives none),
    else the repository's main, for which no key is written: no key means exactly the
    measure before homes (`mainBranch`). A worktree with a home is measured against it (its
    remote-tracking branch where that holds local home, else local home) by the Worktrees
    panel (`Work.home`, `base`), the changes item and `close_worktree`, and its work counts as
    home once home, home's remote-tracking branch or the repository's main holds it, so a
    stacked pull request retargeted to main reads merged too. The open and take answers, the
    give notice and `agents` (where it isn't main) say it. At start, `reconcile` carries a row's
    `base` and `branch_made` into keys its branch lacks, only while the row's branch is the one
    checked out there. Keys are read with one `git config --get-regexp` per repository, again
    only when its config file changes; a write retries while `config.lock` is held, and one
    that fails is logged and never fails the call.
  - **`open_worktree({ branch, repo?, from?, group?, home? })`** checks out the branch if it exists
    locally, or runs `git worktree add -b` from `from`. Left out, `from` is origin's branch of that
    name where `refs/remotes/origin/<branch>` exists, which the new branch then tracks
    (`git branch --set-upstream-to`), as a teammate's pull request branch, fetched but never checked
    out, is; else the remote's main when the checkout is on the local branch that main is, as `main`
    for `origin/main`, and `HEAD` is a strict ancestor of it, so a stale checkout doesn't make a stale
    branch; else the checkout's `HEAD` (a feature branch, a `HEAD` ahead or diverged, or no main).
    Only `origin` is looked at, the one remote Novadeck fetches. With no local branch and no `from`,
    origin is fetched first, before the service's queue and not if it was fetched in the last minute,
    and the call waits at most five seconds for it: the fetch keeps its usual time limit and carries
    on in the background, and a remote that is slow or fails leaves the cached refs, so creating
    never waits long on the network. As that fetch prunes nothing, origin is then asked whether it
    still has the branch (`git ls-remote --exit-code`, as briefly): a branch it no longer has (one
    deleted after its merge) is passed over, and the new branch starts as above; where origin can't
    be asked, the cached `origin/<branch>` is used. The answer says which (`origin`: `current`,
    `unchecked` or `gone`), and whether the branch tracks origin's (`tracking`, false where git
    couldn't set the upstream, which the answer says too). A name `git check-ref-format --branch`
    refuses is refused before any of this, with nothing fetched. It runs with 60 seconds,
    and `core.longpaths` on Windows, after `git check-ref-format --branch`. It answers the path,
    the branch and the paths of AGENTS.md, CLAUDE.md and GEMINI.md at the worktree's top, and
    tells the agent to read them, as no harness loads them from an added folder.
  - **A worktree's changes stay on its owner's bar** (`worktrees/changes-shown.ts`). While
    agent worktrees are on, each time `open_worktree` makes one or `take_worktree` adopts one
    (the service's `onMade`), the runner shows it there as a changes item, as the agent's own
    show, marked new and not opened, unless the agent showed it already, so an `open` it asked
    for stands. Each worktree is its own repository top, so its own item: an agent in several
    worktrees gets several, which stack under one icon on the bar like any kind's items. When it
    changes hands (`give_worktree`, a take the person allowed, or a take of one whose owner is
    gone; the service's `onChanged`, `moved`), the old owner's bar lets go of the item it holds
    as its agent's show and the new owner's bar shows it the same way, as it does for a
    terminal restored from History, whose bar came back empty. When its row goes (closed,
    cleaned up, or its folder gone at the start: `removed`), every changes item of it closes, wherever it is held. The agent's own
    `show { changes: { path } }` updates its item, with `open` when the work is done. An
    unopened item's detail is the count as of its last show: only a read the pane triggers
    brings it up to date.
  - **`take_worktree({ path, home? })`** records a linked worktree some other tool made, as adopted;
    takes one with no owner, or whose owner terminal exists neither live nor in History, at
    once; and, for one another existing terminal owns, asks the person (a `take` approval
    aimed at the owner, `{ type: "take", path, branch }`, answered like `close` and `lead`
    through `terminals.approvals`: "Let @claude take @codex's worktree?" with Allow and
    Deny). The call answers `asked` at once; both agents hear the outcome as a notice, and
    ownership moves only if it hasn't changed meanwhile. The nudge about the old owner
    arrives with the later step that nudges agents.
    On a worktree the caller owns already, `home` sets or changes its home at any time (the
    answer says `already`); a folder in no git repository is refused with the fact that its files
    are changed in place, as `open_worktree` does.
  - **`give_worktree({ path, to })`** hands the owner's worktree to a terminal of its
    project and session by handle, which is told. **`close_worktree({ path, force? })`** is the
    owner's: refused while the worktree has uncommitted or untracked files or commits the main
    branch lacks. `force` keeps the files git lists (ignored files, such as `.env` or data, are
    not kept) as a commit at `refs/novadeck/kept/<branch>-work-<sha>`, and commits only a
    detached HEAD or a stopped rebase reaches at `…-head-<sha>`, then removes the folder. The
    branch goes only if Novadeck created it and the main branch holds all of it. A worktree
    whose status git couldn't read, that has submodules, or that holds an untracked folder which is
    a git repository of its own holding work no remote has, is never removed, forced or not. A
    nested repository is any untracked folder `git ls-files --others --exclude-standard` lists as a
    folder, at any depth (read as it streams, keeping only those, so a huge untracked tree never
    passes the listing's cap): a commit could keep one only as a gitlink, none of its files or
    commits. One holds work unless it is clean (no uncommitted or untracked file), has no stash and
    no submodule checked out, and every commit of its HEAD and its local branches is on one of its
    remote-tracking branches as last fetched; anything git can't read counts as work. The refusal
    names the first that holds work, and what. A clone with nothing to lose goes with the folder.
    The row goes last. A `git worktree remove` that stops partway (on Windows, a file in the
    folder still held for a moment) deletes git's record of the worktree even where the folder
    wouldn't go, so where git's own listing no longer has it, Novadeck deletes what is left
    (`finishRemoval`, retried while a file is held) and the close goes on; where git still lists
    it, or can't list its worktrees, nothing is touched and the close is refused. The git runs a
    close needs wait up to a minute, as a loaded Windows machine takes past 5 seconds for some.
    Every `path` may be a folder inside the worktree. Only a worktree of
    the project's repositories, and not locked, is adopted.
  - **At the runner's start** every row is checked: a folder that is gone is pruned from its
    repository (its own entry only, found by the path in the entry's `gitdir`, which git 2.48's
    `worktree.useRelativePaths` writes relative to the entry's folder) and its row deleted, an owner that exists neither live nor in History leaves
    the worktree orphaned. Removing a project removes its worktrees first, the same way as
    `force`, before the rows cascade away; one `force` can't remove stays on disk, and is logged. Nothing here watches git for worktrees made
    another way.
  - **Cleanup** (`worktrees/cleanup.ts`) removes worktrees nobody needs, in the service's queue
    and whatever the switch says. _Merged_ is the Worktrees panel's test (HEAD in main, or merging it
    changes nothing, into main or, where that conflicts, the commit its work landed in, so squash
    and rebase merges count) with no uncommitted or untracked file.
    A merged worktree stays while its owner is open (running, or asleep or hibernated). Once the
    owner has closed into History, or is gone from both live terminals and History, or the
    worktree has no owner, it is removed with the same checks as a close without `force`: it
    stays if git couldn't read its status, it has submodules, or an agent works in it
    (`terminals.checkouts()`, read again just before the removal). An unmerged worktree is never
    removed by this: while its owner is in History it waits (a terminal restored from History
    finds it still there), and an orphaned one is listed as "No owner" for the person to close.
    When the owner's History row is pruned (`ClosedTerminals.prune`, the only place that tells
    cleanup; a restore also deletes a row but does not), its worktrees are removed with `force`
    semantics: uncommitted work and a detached HEAD are kept on `refs/novadeck/kept/` refs and an
    unmerged branch is kept. If git couldn't read the worktree, it has submodules or a git
    repository of its own inside that holds work, or an agent works in it, the row is orphaned instead, the folder stays, and a warning is logged. Each
    automatic removal is logged at info level (`worktrees.cleaned`); no agent is told. Cleanup
    runs when a terminal is closed for good (`Terminals.forget`), at the runner's start after the
    reconcile above (which orphans rows whose owner is gone, so a merged one among them goes at
    once), and every minute.
  - **Fetching** (`worktrees/fetching.ts`) is what makes a merge on the remote visible, since
    nothing else fetches. On the minute pass, each repository (git common dir) with a tracked
    worktree gets `git -c maintenance.auto=false -c gc.auto=0 -c fetch.writeCommitGraph=false
    fetch --quiet --no-tags --no-write-fetch-head origin` in its main folder, so nothing in the
    person's repository changes but `refs/remotes/origin/*` (no `--prune`, no FETCH_HEAD). It runs
    one repository at a time and at most every five minutes. At 300 seconds git is sent SIGTERM so
    it removes its lock files, and killed after 10 more (Windows has no graceful stop here, so
    there it ends at once, which is why the timeout is long); shutdown aborts a fetch under way. The
    run never asks for anything: `GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS` and `SSH_ASKPASS`,
    `GCM_INTERACTIVE=never`, and `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` unless the person set
    `GIT_SSH_COMMAND`, `GIT_SSH` or `GIT_SSH_VARIANT`, or git's `core.sshCommand` (PuTTY's plink takes no
    BatchMode, so it may still ask). A failure or timeout (offline, no access, no origin) is ignored and
    logged at debug level, and that repository waits twice as long after each one, up to an hour.
    The main branch is `origin/HEAD` where the repository sets it; a clone with no `origin/HEAD`
    measures against its local `main`, which a fetch doesn't move, so such a work carries no
    `fetchedAt` and its row doesn't say "main as of".
    **The checkout follows the fetch** (`worktrees/fast-forward.ts`). After each successful fetch the
    repository's home checkout (`homeOf`, never a linked worktree) is fast-forwarded to origin's main,
    but only when all of this holds: main is a remote-tracking ref `origin/<x>` and `HEAD` is the symbolic
    ref `refs/heads/<x>`; no merge, cherry-pick, revert, rebase, bisect or sequencer is in progress and
    there is no `index.lock`; no tracked file has changes, staged or not (untracked files don't count; git
    refuses to overwrite them); `HEAD` is a strict ancestor of main. The checks read with
    `--no-optional-locks` and run with the fetch's no-prompt environment; `HEAD` and the branch are read
    again right before the move, and the branch once more after it (a change is logged at warn level). It is
    `git -c core.hooksPath=<an empty folder the runner owns, `no-hooks` beside its database, emptied and owner-only at first
    use and kept; a private temporary one without a database> -c core.fsmonitor=false -c merge.autoStash=false merge --ff-only --no-verify-signatures
    --no-overwrite-ignore --quiet <the commit checked>`, with no time limit and outside the shutdown
    scope, since a checkout stopped halfway leaves a half-updated tree. The fetch doesn't wait for the
    move, so a merge that hangs stalls nothing else. Moves of one repository run one at a time. Any failure, a lock held by the person's git, a shallow clone or a missing ref is debug-logged
    and ignored, and the next fetch tries again. It only happens for repositories with a tracked
    worktree, as only those are fetched. The one switch is `MainFetcher`'s `follow` option.
    Where the checkout is on main and behind and was not moved, whatever held it (tracked changes, an
    operation, a file in the way, a repository not fetched since), `projects.checkout` reports `behind`, and the Files panel says "main is N behind origin" with
    Update (`projects.updateCheckout`): the same move with tracked changes allowed, where git itself
    refuses if a changed file is in the way, and its reason is shown in plain words ("Your changes to
    src/a.ts would be overwritten."). The panel asks every 20 s while shown, one read at a time, and when
    `moved` or `head` (the commit HEAD is at) changes, which the person's own pull does too, reads its
    folders again, so added and removed files show.
  - **Restore and looking again.** A restore from History makes a new terminal id; when the restore
    is confirmed (or a newer row of the same conversation replaces the row) `ClosedTerminals` tells
    the service, which moves the old id's worktrees to the new one in its queue before the row goes.
    Removal without `force` does not pass `--force` to `git worktree remove`, so git itself refuses
    a worktree with files written after Novadeck's check. Each minute, a History, gone or orphaned
    worktree that was refused is looked at again in the queue only when its HEAD, the main
    branch's commit or its index file's time changed, or fifteen minutes passed; shutdown waits
    for removals a prune started.
- **Messages** between agents come from the same server's `send`, `agents` and `team` tools,
  listed only inside Novadeck's terminals like the others: an agent messages another
  terminal of its project and session by its handle, such as `@moth`, which `open_terminal` and `open_agent`
  also answer with, and the message reaches that agent through its own hooks. The runner
  keeps the messages with the workspace and lists, pauses and releases them through
  `messages.list`, `messages.pause` and `messages.release`. Its `agents` listing carries
  the summaries the terminals' agents gave through `describe`, and `team` follows the
  caller's own team's work since it last looked. See
  [Agent messaging](agent-messaging.md).
- **Pages** are any http(s) address; an address with a user name or password is
  refused. The desktop app loads them live in the pane, in Electron's `<webview>`,
  which lays out with the pane, keeps Novadeck's menus and cards above it, and lets a
  later highlight mode reach into the page. Whatever the element asks for, the host
  gives each one no preload or Node, a sandbox, and the `persist:novadeck-pages`
  session, kept on disk apart from the app's so a sign-in lasts in every page and
  after a restart, where every permission and download is refused and no file loads.
  Its own links and redirects go only to http(s) addresses, and so does an address the
  person types in the pane's address field, at the start of its tools: one with no scheme
  goes over https, or over http to this machine or its network (`localhost:5173`), and
  one naming a user or password, or with any other scheme, goes nowhere; where pages don't
  load live, what they type opens in their browser. A window it opens goes through only
  right after the person clicked or typed in it, one each, so a page can't open tabs on
  its own: a popup the page sized, as a sign-in's, opens in a window of the app on the
  same session, guarded the same way, so the sign-in lands there; anything
  else opens in the person's browser. A frame from another site in the page can take
  that one window, as Electron doesn't say which frame opened it. A passkey sign-in
  that names no passkey asks the person which, when more than one fits
  (`libraries/viewers/src/browser/host.ts`). A right-click or the menu key on the page
  opens Novadeck's own menu, not the browser's: a field's Cut, Copy, Paste and Select
  all, Copy on a selection, a link's address to copy, or open in the browser, and the page
  to open in the browser; going back, forward and reloading are the pane's tools, and its
  address is the address bar's (`frontend/items/src/kinds/page/page-menu.ts`, which leaves
  a first group for what a later feature offers there). Where the host can't, as the web
  version, a page is a link to open in the browser, and a snapshot's menu has only the page
  to open in the browser. Each show of a page loads it afresh: the
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
  scoped like `show`: the caller may write only the plan the terminal's agent keeps.
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
