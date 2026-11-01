# Developing Novadeck

Requires Node.js 26, pnpm 11.22.0 and Rust ([rustup](https://rustup.rs)), which builds
the relay in `backend/relay`; its `rust-toolchain.toml` names the version, which
rustup installs. Run commands from the repository root.

```sh
pnpm install
pnpm dev
```

`pnpm dev` launches the Electron desktop application. Development launches keep their own
data (database, settings, agent launchers) in `novadeck-dev`, beside and apart
from an installed Novadeck's `novadeck` folder. Run one `pnpm dev` at a time:
the UI dev server holds port 5173, and the single-instance lock keeps a second Electron dev
host from sharing `novadeck-dev`. An agent's Novadeck tools always come from the Novadeck whose terminal it runs in, through the relay of the build that connected it. On Linux and macOS, once you disconnect and connect each agent after upgrading, an agent in any Novadeck's terminal starts that Novadeck's own relay (`NOVADECK_MCP`), so a build that changed or removed its relay doesn't affect the others; on Windows it starts the connecting build's relay. To run the UI and runner in a browser
instead:

```sh
pnpm dev:web
```

Open <http://127.0.0.1:5173>. `dev:web` starts a runner with a fresh random token
and hands the same token to the UI dev server. A browser has no desktop app, so it shows
no notification when an agent finishes; its terminals are still marked done. For UI-only work, use
`pnpm --filter @novadeck/desktop exec vite --host 127.0.0.1 --mode web` with `VITE_NOVADECK_RUNNER_URL` and
`VITE_NOVADECK_RUNNER_TOKEN` pointing at a runner you started; the web entry reads
`.env.web` (in `frontend/ui/`) rather than `.env.development`.

A runner that opens a `workspace.sqlite` an earlier build wrote carries it forward to its
own schema version in place, one step per version (`migrations` in
`backend/runner/src/workspaces/store.ts`), so your projects, sessions, kept terminals and
messages stay. The oldest it carries is schema version 6: one from before that (the steps
from 2 to 6 went with schema 7, before release), or whose step doesn't fit it or finds it
damaged, or whose tables differ from its version's, is set aside as
`workspace.sqlite.earlier-<time>` (with its `-wal` and `-shm`) for a new one to start; that
file stays for you to delete, and may hold saved terminal output that was never masked. A
`workspace.sqlite.restoring` an earlier build's restore left half done also stays for you
to delete. A runner keeps a copy from before each step in `snapshots/` beside it (the newest three). A standalone runner keeps it at `~/.local/share/novadeck/workspace.sqlite` unless
`NOVADECK_DATABASE` is set; the desktop app keeps it in its data folder, `novadeck` on every
platform: `~/.config/novadeck/workspace.sqlite` on Linux, `~/Library/Application
Support/novadeck/workspace.sqlite` on macOS and `%APPDATA%\novadeck\workspace.sqlite` on
Windows (`novadeck-dev` in place of `novadeck` for `pnpm dev`). Novadeck never deletes it
for you.

### Plan review design preview

Run `pnpm dev:previews` and open <http://127.0.0.1:5181> for a UI-only study of
how an agent's plan is reviewed in each view. Novadeck hosts other agents, so it
neither dictates how a plan is written nor answers the agent's approval prompt.
The reader shows the Markdown as written, and the plan file is the only channel
back: notes you leave are written into it, and a small Novadeck skill tells the
agent to re-read the plan before acting on it, apply the notes, and remove each.

Two samples show the range. “Build Studio” runs Codex with a structured plan
(headings, a task list, file paths) and the skill installed. “Refactor auth” runs
Claude Code with plain prose and no skill. Each terminal asks its own question:
answer `y` to approve or type anything else to keep planning.

A taskbar along each terminal's bottom has an icon for the plan. Opening it shows
the plan beside its terminal, never over the workspace:

- **Focus** and **Grid** split the window: terminal on the left, plan on the
  right, with a draggable divider. In a window under 640 px wide, as most Grid windows
  are, the pane covers the terminal instead, which keeps its size underneath, until you
  minimize or close it. While it covers the terminal, Escape minimizes it and never
  reaches the agent, Enter only uncovers the terminal, and any other key the terminal
  would take uncovers it and goes into it, so typing a reply brings the terminal back;
  keys typed into the pane's own fields, such as a plan, stay there.
- **Canvas** attaches the plan as a sheet beside the node, which pans and zooms
  with it; the canvas frames both as it opens. A window that recedes, unselected, fades
  with its sheet, but the sheet stays solid over whatever lies under it.

The plan is always editable: it's the file's
Markdown in a CodeMirror 6 live-preview editor. Markdown syntax shows, dimmed,
only on the line being edited, so typing Markdown is how you format the plan;
there are no formatting controls. A heading's `#` marks hang in the margin so its
text doesn't move. Note wrappers never show. The note icon in the margin adds a
note under a line, written into the file as an HTML comment; Backspace in an empty
note removes it. Tables always render as tables: click a cell to edit it, Tab and
Shift+Tab move between cells, Enter moves down, Escape cancels, and only that
cell's text changes in the file. While a cell is being edited, a toolbar adds a
row below or a column to the right and deletes the current row or column; Tab past
the last cell starts a new row. Every row has its own note button: a row's note is
written inside the row, at the end of its last cell, and shows under it; the
header's note is on the whole table and goes after it. When the agent writes a new
version, its changes merge into yours line by line, the lines it wrote are
highlighted, and the notes it applied are gone. Without the skill, as in “Refactor
auth”, notes wait until you ask the agent in its terminal to re-read the plan.
Escape closes the plan. A plan gets a sidebar tab and a window of its own only once you
undock it (below).

Besides its plan, an agent can show you other things: an image, a file from the project,
a page in a preview browser. They join the plan in the terminal's companion pane, which
has no header of its own. Each is an item the backend keeps: a pointer to the file or
page, never a copy, so it always shows what the file holds now, and it is still there
after a restart. Each item has one holder, a terminal's bar or a window of its own, and
there is no limit to how many a bar holds. One that can't be shown stays on the bar and
says why: the file is gone, can't be read or is no longer a file, it's too large to
preview, it isn't text, or the plan it pointed at is gone. A file that may hold secrets,
such as `.env` or a key, never opens by itself: it says so until you open it. The agent
lists what is beside its terminal with Novadeck's `showing` tool, and showing the same
file or page again updates it. A page from a server on your own machine is the same
page whatever route or anchor it's at, so a dev server stays one item as the agent
moves through it. In the desktop app a page is live, and signed in wherever you signed in:
sign in to a site in one page and every page is signed in there too, the agent's included,
and stays so after a restart. A sign-in that opens a small window of its own, as "Sign in
with Google" does, opens it in Novadeck, titled by the site it's at; the page stays live
while it's open, and closing the page closes it. A passkey sign-in that fits more than one of your passkeys asks
which; on macOS, passkeys saved in iCloud Keychain don't show yet. Each gets an icon in the taskbar, as an OS taskbar has, with
several of a kind (images, files, pages, or plans) stacked under one; only Messages
never stack. A markdown file the agent shows reads as a document, formatted like a plan
with its outline, but read-only: it's the agent's file, not a plan to edit or note (the
demo's Codex has shown `docs/brand-voice.md`). The pane stacks what's open as a desktop
stacks windows: it shows the last thing opened, by you or by the agent when you asked
for it, and the rest wait behind it, the nearest two peeking out above it: click one to bring it
forward. The mark under
an icon says whether it's new, showing, open behind, or seen: something new gets a dot,
quietly, and nothing opens on its own unless you asked for it. Something the agent opens
for you opens at once only on the terminal you're on, so the view never moves under you:
on any other terminal it waits, new, with a toast over the header laid out as the Inbox's
are ("@haze wants to show you", localhost:3000, and Order status page at its foot), which a
click takes you from to that terminal, in view with the keyboard in it, and it opens when
you go to that terminal by any route. In Grid, where nothing moves as a pane opens, it
opens in its window at once and the toast still tells you. Opening, peeking at, hiding,
closing or moving it yourself first ends the wait, as does putting it away in Grid, which nothing keeps across a restart. Hover an icon to peek: a
card per thing behind it, each a preview, its name and the same mark, with no copy. Once
you've peeked, what was new is seen, without opening it. Click an icon or a card to open
it on top. Click the showing icon again, or the pane's minimize button, to minimize it,
uncovering what's behind; press Escape to hide the whole pane, which keeps what's open in
it for when the pane comes back. Close from the pane's header, a card's corner button or the icon's
right-click, which uncovers what's behind too. Closing a plan or Messages on its own terminal's bar hides it: the
plan comes back with the agent's next version of it, Messages with the next message,
last on the bar each time. Closing anything else deletes it, with the window it's in;
nothing keeps a history, so ask the agent to show it again. Icons line up in the order they came,
plans and Messages among them; drag any icon to reorder the bar, a group moving as one,
or use Move left and Move right on its right-click.

Drag any icon onto another terminal's bottom bar to move it there (Grid and Canvas,
where both are on screen); a terminal with nothing to show grows an empty bar while an
icon is dragged over it. It now belongs to that bar: its peek, menu and pane still say
which terminal it came from, and an image or file stacks with the bar's own like any
other. If that bar already holds the same file or page, the moved one replaces it. Its
agent showing it again updates it where you put it, as it does an undocked window.
**Send back to** its terminal, on its right-click, or a drag onto that terminal's bar,
moves it home. Items go with the terminal whose bar holds them when it closes, and the
backend keeps where each is across restarts. Messages are the exception: a terminal's
messages are its agent's conversation, so they stay on its bar. Dragged off the bar,
their icon stretches toward the pointer, giving less the further it's pulled, and
springs back when let go; nothing out there lights up for it, and the pointer shows it
can't go. Within the bar it reorders like any icon.

Any card in a peek can be dragged out too, one of a group's on its own: it turns into an
icon under the pointer, which goes wherever a dragged icon goes, onto another terminal's
bar or into a view's empty space, while the rest of a group stay grouped. Dropped where
nothing takes it, or with Escape, it settles back into the icon it came from.

Drop a plan or a single artifact in a view to undock it right there. On Canvas,
over its empty space, a ghost window joins the canvas under the pointer and follows it
freely, as a dragged window does; dropped, the window opens where the ghost was and
settles onto the canvas's grid. On Grid, a placeholder window joins the grid under
the pointer as soon as the icon is over it, and the grid makes room for it like any
window: the window it's over moves aside. It goes as the icon leaves the grid; dropped,
the window takes its place. In
“Build Studio”, type `show` to have Codex show the next thing, or `open` to play
asking it to open it; it opens `projects.json` for you as the demo starts. Files are
syntax-highlighted by their extension (JSON, JavaScript and TypeScript with JSX, CSS,
HTML, XML, Markdown, YAML, Python, Rust, Go, Java and C/C++), with each language's
parser loading the first time one of its files opens; any other file shows as plain
text. A page shows as a snapshot until the pane hosts a browser.

**Undock to its own window**, in a plan's or a viewer's header or an icon's right-click,
moves a plan or what the agent showed out of the pane into a window of its own beside
the terminal; a plan stays editable there. It joins the sidebar and every view like a
terminal: rename, hide, resize, reorder, Focus and close all work. While it's
undocked, the terminal's taskbar leaves it out. **Dock in** the terminal it came from,
on the window's right-click, closes the window and opens the item in that terminal's
pane again; once that terminal has closed, Dock in shows disabled. Closing the window
deletes the item, as closing it anywhere does. Nothing runs in a window, and it reads
the file as it is now. Windows are the runner's, as terminals are: they outlive the
terminal they came from and come back after a restart; the session saves only where
each sits.

Items and windows reach the workspace the way terminals do, through the backend's seed
and its changes. The pane loads what an item points at through the backend's optional
`companions` capability (`frontend/core/src/items.ts`): its content as it changes, and a save
that writes the person's edits and notes into the plan file unless it changed since, in
which case the pane merges and saves again. Edits save once typing pauses and when focus
leaves the plan. The runner reads content from disk and can't write plans yet, so its
plans are read-only; the content-preview demo writes them, with sample agents in
`frontend/demo/src/showcase/` that revise their plans over the file as the person left it and
remove the notes they apply. `docs/agent-workspace.md` ("Companion pane") describes the
runner's side. The editor and its merge code load when a plan first opens.
Normal development and packaged builds keep their runner behavior.

### Debug panel

The content-preview demo has a panel for reaching every state of the app on demand,
including the ones that need a runner to go wrong. Run `pnpm dev:previews`, open
http://127.0.0.1:5181 and click the Debug handle in the middle of the footer to slide
it up or back down; Escape closes it too. The runner has no panel. Its header shows the
connection state, the crash-loop count and the terminal count, over the demo switcher.

`?demo=` in the address's hash picks the variant: `showcase` (the default, with the
sample agents' plans and artifacts), `plain`, `agents` (its seven projects each with
an agent in a state of its own: waiting, asking, working, and two that finish done and
failed a moment after it opens, for the project switcher), `messages`, `inbox` (the agents
demo with hardcoded Inbox rows of every kind over those its agents make), `welcome` or
`chirp` (a one-off for the runner-skits video "Chirp": a desk of twelve agents at work on the
Canvas, one waiting to run a command; `frontend/demo/src/videos/chirp.ts`) or `babcia` (a one-off
for the video "Babcia": project bar-mleczny's twelve Claude Code, Codex and Antigravity agents
on the Canvas, all working, beside a second project, setlist; its beats are the debug panel's
"Babcia" group, one cue each, fired by a capture plan: 1 three asks (a permission to run
`pnpm test`, a plan, a question with its own pick; 1d an agent's rude ask, told No, then its
polite one), 2 a failed turn, 3 the lead Site API opens
three helpers, 4 a helper's free-text question, whose answer reaches its lead through a message
and the doorbell, 5 a page shown in the pane (the cue selects its agent's window first, as an
open waits for a terminal you're not on), 6 every agent finishes but those waiting on the
person (an open ask, one told No, a failed turn until prompted again, and the helper and its lead
while the helper's answer is on its way); a second press ends whoever works by then. Answered or
told, an agent works until cue 6; `frontend/demo/src/videos/babcia.ts`) or `launch` (a one-off for the
launch walkthrough video: project northwind's ten Claude Code, Codex and Antigravity agents on the
Canvas, all working, beside a second project, northwind-docs; its beats are the debug panel's
"Launch" group, numbered by the video's beat: 3 a spread of states (an agent asking, one failed, one
done; or each alone), 4 three asks at once (or each alone: a permission, after the three steps
its Inbox sheet lists, a plan, a question with its own pick), 5
the lead Orders API opens three teammates, each briefed by its lead as a message; one asks the
person a question and messages its lead the same one, the lead answers first and the teammate
withdraws its ask; another reports done (a done mark and an Update row, and the same to its lead as
a message), 6 the page and then the changes (`show { changes }`) or a screenshot of three takes
on a button (6c) shown in the pane, each cue selecting Order status page first as Babcia's 5
does, 7 every agent
finishes (each teammate reporting to its lead, which finishes after; whoever waits on the person
stays waiting, and a second press ends whoever is still working), and for the website's /vs pages 8a
one agent asking another by message to review its change, which it answers, 8b an agent showing
its plan in the pane, and 8c a Codex agent asking in Codex's words to run its tests, which once
allowed runs them and reports done (8a and 8c share Search index, so each does nothing once the
other has run); `frontend/demo/src/videos/launch.ts`,
sharing the desk's builders with Babcia and Chirp in `videos/desk.ts`). Every variant's Inbox
lists what its agents wait on, built as the runner's is. In it each
agent carries a transcript, and api-service's worker a brief from its lead, so a row's
sheet shows the context block built from its transcript: the person's last words to the agent
(never another agent's, so the worker its lead briefed shows none), and under them up to three
steps since that edited, ran or failed, each with what came of it (`+4 −2`, a command's last
line, the error). The switcher in the panel's header,
which leaves out `welcome`, `chirp`, `babcia` and `launch`, changes between them without reloading
(pressing the current one boots it again), and the browser tab remembers the last one chosen.
`&turnMs=` sets how long a demo agent's turn works (1500 ms unless given), as a spec does
that must act on the screen before the turn ends.

The search field at the top filters actions by label, hint and group. Groups start folded,
under three sections (Terminals, Agents, App), and the panel remembers which you opened in
this tab. A ↺ beside an action marks one that boots the demo again.

Terminals:

- **Selected terminal:** put the selected terminal in each of its states: starting, loading
  output, back at the prompt, running a long program, Claude Code or Codex, a failed
  paste, and each way to end (clean exit, exit code, killed, killed for memory, failed to
  start). Each one that changes the state calls off what the terminal's agent had
  pending, so a finish due later doesn't bring the agent back. "Leads the others" makes the selected terminal
  lead every other live terminal of the session, for the team wire with many workers on
  the rail, in Grid and in Canvas; with "Burst of" first, part of the team scrolls out of view.
  "Leads the next one" moves the next live terminal after the selected one into its team, out of any
  other; done on two terminals that aren't neighbours, it makes two teams, which Grid and
  Canvas wire side by side (on neighbours, the teams chain through the middle one).
- **New terminals:** "Every state at once" adds one terminal per state, named after it, so
  the tabs and the windows in Grid and Canvas show done, replied (unread), failed, working,
  planning, subagents, asking, waiting, paused at its limit, ended and the rest side by
  side. "Asks (MCP)" and "Needs a sign-in" are agents with an `ask` open in the Inbox (a
  question, and an action ask), so their "?" and "!" show beside "Working, a side question",
  an agent that works on with a question open. You stay on one that needs permission, and the
  marks land on the others as you look away. Its shell an agent opened and its shell an agent
  exited from keep their handles on their tabs; its other plain shells show none. Also a
  burst of 30, a quick failure, a spawn failure and the terminal limit.
- **Projects and sessions:** mark the selected terminal running, then start a fresh
  session and open Sessions to see the old one count it; or make the next folder pick fail.

Agents:

- **Agent:** verbs on the demo's agents, which have one owner that keeps their status, the
  requests their chats hold and what their screens show in step, as the runner's do. A
  switch at the top of the group, remembered in this tab and shown with each search hit,
  picks the terminal they act on: the selected one; another terminal of its session (added
  in the background when there is none, so you look elsewhere and get the unread mark and
  the notice); or the first terminal of another project, for the switcher's marks. A terminal
  that runs no agent becomes Claude Code first. Work, Plan mode and Subagents start a turn
  that works on. Needs permission, Asks a question, Plan ready and 3 permissions stop it on
  requests you can answer in the chat or on the screen, which clears the tab and the
  notification. Completes, Replies (no done call), Fails, Interrupted and Ends without reply
  work for 3 s, then end the turn the way asked: Completes calls `done` with a report, so the
  tab marks it done and the Inbox lists the report; Replies, no done call ends with its reply
  and no `done`, so its program name brightens until you look and no row appears; Fails marks
  the tab failed; Interrupted ends with a short reply (no unread mark); Ends without reply
  has none. Background work (2 tasks counted) and Background, uncounted end the
  turn and leave work running; Finishing subagents keeps the agent working until its 2
  subagents finish. Rest leaves it at its prompt with everything answered and read.
- **Agent fixtures:** what no turn produces: an unheard agent (Claude Code whose hooks say
  nothing), and context and limits or tokens alone, in the tooltip and status; those two set
  only the usage of the selected terminal's agent, so a turn, request or queued prompt stays.
- **Approvals:** "Ask to close selected" has another terminal of the session ask to close the
  selected one, and "Ask to lead selected" has it ask to lead the selected one, which raises the
  approval modal (two presses queue two; approving closes the terminal, or makes the asker its
  lead); "Withdraw approvals" takes them back.
- **Doorbell** and **Messages:** only in the `messages` variant, on the selected terminal.
  Doorbell puts its idle agent where the doorbell can't ring it (working, a prompt queued,
  shell mode, text in its box, a dialog, asking you, failed, away), which its Messages pane
  says while messages wait for it. "News from a peer" has its latest peer write to it, so the
  peer's row in its Messages list says Unread until the person opens it; "News from a
  repeated handle" has `foxz` (or `mothz`) write, whose critter is its word's. The variant's
  Messages pane has the rest at rest: the person's entries (an answered ask, an unread tell,
  an open ask with Answer), a thread folded to one line, messages waiting, delivering and
  not delivered, and the critters of agents working (hopping), at rest and gone (dim).
- **Waiting agents:** "Fill the Inbox" has up to 12 terminals across
  the projects ask for you (questions, permissions, plans), and after 3 s finish with a done
  report or failed, so the Inbox lists every kind and its header counts 12 waiting. It
  adds terminals to the current session if the workspace has too few, without selecting
  them or leaving the Inbox, and leaves the selected terminal alone, since
  a report is read once you have looked at its terminal for a moment. "Clear waiting agents" rests every agent,
  which answers every request, reads every finish and calls off those still to come, and
  has a terminal back at its prompt work for a moment and leave, for an empty Inbox. The notices for finishes need the Preferences switch
  "Notify when an agent finishes" on.
- **Chat: next send or Stop fails:** arm the next send from a chat to fail as the runner turns it away: a
  draft in the agent's box, its shell mode, too tall a message, no box on screen, or no
  agent running (each with Open terminal), a request waiting (answer it first), or a
  doorbell ringing or a screen not ready (try again in a moment), or no reason given, as
  from an older runner (check the terminal). Arm the next Stop to fail as the runner's does
  when the words queued behind the turn stay in the box (with Open terminal), or when a
  request waits (answer it first).
- **Plan:** only in the `showcase` variant, on the selected terminal's agent (Build Studio or
  the auth agent), for what happens to a plan the person has edited. "Plan in the agent's
  messages" makes it read-only; "Plan file deleted" shows that its file is gone, with the
  edits kept; "Plan folder can't be written" and "Plan too large to save" show their
  message once you type, with Copy my edits and Try saving again; "Plan saves keep
  failing" shows "Not saved yet. Trying again." and, after five failures in a row
  (about 30 s), Retry; "Plan back to normal" lets saves work again. Specs open the showcase
  with `&planFault=` `transcript`, `gone`, `folder`, `too-large` or `failing`.
- **Changes:** only in the `showcase` variant, no action needed: the dev server's terminal
  (`@fox`, the third) holds its items on the bar beside those that can't show, seven of them
  changes, one in each shape the diff viewer draws: an ordinary change (modified and added
  files), a file renamed with one deleted and one added, a change with very long lines, a
  binary file, a file that may hold
  secrets, a change past what the runner reads (files listed by name, and "This change is
  larger than shown"), and one with no changes ("No changes against HEAD"). Their data is
  `frontend/demo/src/showcase/changes.ts`.
- **Source:** the Source panel shows the current project's files, read one folder at a time as
  folders open, and read again when the panel is shown again or an agent's turn ends in the
  project. The runner has no changes to tell yet, so there the panel is the plain tree. In the
  `agents`, `messages` and `inbox` variants (and the try demo), the Source panel shows the
  storefront project's files with what its agents changed: Moth's work as history, and Moth and Crow writing on
  their own, a file every 3 to 7 s, resting 10 to 20 s between turns, only while their
  terminal's agent works and asks nothing of the person (a permission, question or plan stops
  the writing and its cursor; nothing moves under `?still` or reduced motion). The `plain` and
  `welcome` variants have no Source, as their storefront terminals are plain shells. "Agent
  writes a file" and "Agent stops writing (Source only)" act on the selected storefront agent
  terminal (Crow otherwise): the row pulses and its cursor moves, or goes; the second only
  clears the cursor, and the agent's turn is ended with the Agent group's states. "Third agent
  edits Checkout.tsx" adds the storefront's third terminal's agent (`owl`) to a row that
  already shows Moth and Crow, folding the chips into "+1". "Agent creates a file in a folder"
  adds `src/api/payments.ts`, so a folded `src/api` pulses and shows Crow's chip. "A folder can't
  be read", "A folder lists only part" and "The project's files can't be read" make the next
  reads of `src/cart`, of `src/components` and of the root fail, list two files, and fail (the
  panel reads again when it is shown again, so switch panels and back): a muted "Can't read this
  folder" row, a muted "More not shown" row, and a line in place of the tree. "The project's folder
  is empty" and "The project lists only part" make the root hold nothing (the line "This project's
  folder is empty.") or two entries and a "More not shown" row; "Source reads normally again"
  ends them all. Every sample project has a small tree of its own. `node_modules` is the demo's
  empty folder: it opens onto a muted "Empty" row.
  A strip of agent chips above the tree lists the agents with work in the project, in the
  session's roster order, each light-able by a click (any number, Escape lets them go; with
  none kept the selected terminal's agent is lit). The `messages` variant has a squad, as
  Moth leads Crow there: the two share one track, and a click on `@moth` keeps both. A squad
  stands only while its lead has work too (else its workers are solo chips), and an agent in
  two teams sits in the first squad that names it. The `agents`, `inbox` and try demos have no
  team, so their strips are solo chips.
- **Agent connections:** make the next connect in Preferences fail, refresh the agents, or
  connect Antigravity with the note Preferences shows where its own status line keeps
  Novadeck's out, as on Windows.

App:

- **Inbox:** each action adds one row of its kind to the Inbox, over what the agents wait on,
  waiting from now and in place of the one of its kind already there: a stuck agent, Codex's
  command permission, an unreadable dialog, a held message, a decision with options, a
  detected question, an ask while its agent keeps working, a login request, the 5-hour limit, a usage limit Novadeck can't resume (no switch), a request whose dialog never read, a
  failed turn with no error, a held message whose sender is gone, a plan approval
  (its bypass-permissions yes a quiet link; in the agents and Inbox demos it brings its long
  checkout plan, shown again on storefront's terminal 6 as a harness shows the plan it asks
  about; "Plan still loading" keeps that plan's box on Loading, and "Plan not found" shows no
  plan, so the box waits five seconds and the dialog's own words stand in), a failed turn, a free-text ask, a permission
  whose Deny is a plain no, messages held long behind what keeps the doorbell from an idle
  agent, a heads-up, an agent's done report, mobile-app's lead's Grant card (push and pull
  requests for three repos, one flagged an added remote and one recent, two exact commands, its team now and later with a Codex note, until done, and the lead's
  reason quoted; Grant keeps what stayed ticked and makes the live grant, Decline dismisses it)
  and design-system's approval card ("Lets @moth run, without asking again, until it reports done or for 1 hour:" with
  three commands as code; Approve, until done or for 1 hour, makes a grant for that terminal). "Live grant" puts the
  Grants section at the top of the Inbox with a team grant (holder, actions, repos, time left,
  its last allowed command, Revoke); "Grant ends" adds a terminal grant that leaves the list by
  its time after four seconds; "Revoke a grant" ends the newest as Revoke does; "Clear grants"
  empties the section, which shows only while a grant is live. "AutoRun offer", "AutoRun manual
  step", "AutoRun silenced" and "AutoRun gone" put cmd's AutoRun card (Windows) at the top of the
  Inbox: the offer (why, the value now, the exact new one, "every cmd window", Silence and Not
  now; Silence moves it to silenced), the step in words where the machine's AutoRun prints, and the
  silenced state with Undo and the exact value it restores, which Preferences lists under Agents
  too. "Several asks at once" adds four asks from four
  projects together, so three toasts stack with a "+1 more" pill behind (the page needs focus
  and the Inbox panel closed, and a row from the selected terminal never lands until you look away: with
  storefront's terminal 4 selected you get three toasts and no pill). "Fail the next answer" makes
  the next answer to any row fail, so its sheet shows why and keeps the row and draft for retry. Ask, Tell and Your reply
  also appear in the terminal's Messages pane, in the conversation You; replies show queued and delivered states.
  "Stale next answer" makes the next answer report that the ask is no longer available,
  keeping the draft. "Ask withdrawn" and "Ask session ended" remove the sample preview ask
  and keep its outcome in Messages; with the preview ask's sheet open, "Ask withdrawn" leaves
  the sheet open, tagged Withdrawn, saying so in place of its answers. "Next reply not delivered" queues the next reply, then
  shows the delivery failure in its Inbox receipt (on the sheet the Inbox moved on to, with
  Back to it) and Messages history. A box for your own words says when it is over 4,096
  characters, and won't send until it isn't. Pausing messages between agents leaves
  your replies going through. "Usage limit, reset passed" adds the limit Novadeck can't resume, with its
  window reset, offering Continue now. "Command hiding lines" adds a permission whose command
  buries a line under blank lines and spaces; its box counts the lines and marks what draws
  as nothing. "Long command" adds a permission for a 12-line script, every line in a box that
  scrolls. "Pick several, with your own words" adds Claude's question that takes several picks
  and words: numbers and Space tick, the last row opens a box, and Enter sends the picks with
  the words. "Plan with a change field" adds Claude Code 2.1.287's plan, whose only way
  back is "Tell Claude what to change": that row opens a box that must say what. Answering any
  row moves the sheet on to the next that needs you (updates skipped) with a one-line receipt,
  and closes it once nothing is left; "Decision with options" is hard to undo, so its first
  press only arms the answer. "A new row
  arrives" adds the next kind not there yet, and "Clear the added rows" takes away the
  hardcoded rows and those added here, leaving what the agents wait on. An added row
  stands alone; one that waits on the person for its agent (a request, an ask, trouble) takes the place of a dialog its agent's
  story shows there, as no real agent shows two; answering an added request for an
  agent that waits takes the agent past it. The group shows in every variant over the
  sample projects, so not in the content showcase.
- **Murmur:** the demo starts with it installed and on, as the try demo shows it, and never
  offers it; `&murmur=uninstalled`, `unsupported`, `no-device`, `network-down` (the first install fails
  on the network, the second works) or `offered-out` (the offer already shown in three sessions)
  in the address starts it otherwise. The offer is a chip,
  "Name it for me", beside the title of the first terminal whose agent finishes a turn (or the
  selected one, from "Offer the chip now"); in a narrow window or Grid tile it shrinks to its
  icon. Its popover has No thanks and Turn on. Turn on leads to a footer item: a ring and
  "Murmur 42%", and a card above the footer's end with the step, the bar and Cancel (an update's
  download bar stands aside while it shows). The actions
  set Installed, Not installed, Offer the chip now, Installing, Checking this computer (a
  turning ring), Install done ("Terminals name themselves now", then it leaves), Install fails
  (network) (a danger item whose sheet opens once, with Try again and Not now, which only
  hides it), Install ends Not available (the sheet says so, with Details), Next install ends
  Not available, Not available, Not available, files left (Details and Check again by
  Uninstall, no switch) and Not available (software rendering) (no Check again).
- **Feedback:** where the backend has feedback (every demo but the visitor's, and never the
  runner). "Next send fails" makes the next note Not sent, so the card keeps it and the footer's
  button reads "Not sent · Retry". "Next ask fails" makes the next Ask from an agent window's card
  fail, so the card says no agent is running there. "Show the button's word again" clears
  `novadeck.feedback-opened` and boots the demo again, so the button shows "Feedback" as on a new
  install. "A feedback draft from the selected agent" asks the selected terminal's agent to write
  feedback, as the window menu does: it works a moment (after its current turn, if it is in one),
  then its draft, with a path under the home folder to strike, waits in the demo's feedback
  drafts (the `drafts` port a feedback card reads; no card shows them yet). "An unasked feedback
  draft from the selected agent" puts one there at once, as when an agent wrote it on its own.
  The demo's card says version 0.0.219 and the browser's OS.
- **Voice input:** the demo starts with it installed and on, as the try demo shows it, and
  never offers it. `&voice=uninstalled` in the address starts it without, and
  `&voice=failing` starts it without and makes its first install fail. Voice input's setup
  lives in the dictation strip of the terminal the person reached from (the overlay at the
  app's foot where none shows): the offer, the install's progress, the ready note and a
  failure. The actions set:
  - Installed: on; the mic and Ctrl+Shift+M dictate; no offer.
  - Not installed: the mic of an agent's terminal, or Ctrl+Shift+M, opens the offer; typing,
    another terminal or 15 s hides it and the next press offers again.
  - Offer in the strip: opens it at once.
  - Software rendering: the offer quotes small's size and Turn on installs small only.
  - Installing: held at the model, half there, with Cancel.
  - Install, then ready: follows the steps, then says it is ready for a few seconds.
  - Install, turbo too slow: small's model and check follow turbo's.
  - Cancelled at the check: the engine and the model are on disk, never checked; the offer
    says no size, and Addons shows Install and Uninstall.
  - Install fails (network): the failure with Try again, not a decline.
  - Declined: no mic, Ctrl+Shift+M reaches the terminal, and Addons still offers it.

  The install actions press the chord for you, once for the offer and again to turn it on.

- **Startup:** "Hold the splash" keeps it until you press Escape; "Slow attach" counts
  terminals attaching over about 3 s; "Welcome dialog" opens the first-run dialog for
  connecting agents again (no reboot).
- **Boot failures:** each fails the first attempt as the runner would, so a transient one
  retries on its own and the others wait for Retry (an incompatible runner, or a workspace
  a newer Novadeck has used, only for Quit). Each hint carries the error code, so the search
  finds it; `WORKSPACE_TOO_NEW` is what an older Novadeck shows once a newer one has used
  the workspace.
- **Runner:** lock the terminals with Reconnecting for 5 s; show them Runner offline until
  you toggle it back; or count four crashes, which opens the dialog, puts Restart terminals
  in the footer and fails the selected terminal's session's terminals (Try again or Restart
  terminals clears the count and restarts them).
- **Sandbox:** boot as a desktop app running without Electron's sandbox, for the footer's No
  sandbox chip and its fix command; "No sandbox, no fix" as one with no command to offer;
  and "Sandboxed" back to normal.
- **Guides:** "Toggle icon guides" draws a dashed box over every icon (`svg.lucide`) and a
  dashed line through its middle, 20 px past each side, both 1 px and half see-through
  (`--icon-guide-color` changes them), for checking how icons line up with their text;
  it stays on through the demo's boots and reloads in this tab.
- **Portable:** boot again as a portable copy, which never updates itself and is the way to
  install the app that does. Its corner card, the update bar's size and place, comes up by
  itself once per boot and then only from the footer chip, which Escape or × folds it back
  into. "No release known" shows the Portable copy card and the quiet Install Novadeck chip
  (Install when narrow); "Update available" adds a release, so the card reads "Novadeck
  0.0.80 is out" and the chip says Update available with a dot. Install takes four seconds
  here, a download climbing to 100% and then the install, and ends as installed: the card says
  it takes effect after a restart (after a quit and reopen on macOS), fades after a few seconds and leaves Installed on the chip;
  Novadeck never restarts itself. "Install never finishes" holds the Installing card and the
  chip's Installing…. "Newer install exists" and "Install fails" arm the other ends: a card
  saying a newer Novadeck is already installed, or one giving the reason with Try again.
  "Already installed" is a window opened again after installing: no card, the chip reads
  Installed. "Slow app" makes the app take four seconds to say it is portable, to check
  the No sandbox chip does not flash meanwhile. "Installed copy" boots as one. With "No
  sandbox" set under Sandbox, the No sandbox chip stays away on a portable and the card adds
  a line about it. For specs, `?portable=` opens any of these by key (`no-release`, `update`,
  `never`, `newer`, `failed`, `installed`, `slow-app`, `installed-copy`); `&installMs=` sets
  how long an install takes (none by default), and `&update=` adds an update scenario.
- **Uninstall:** boot as a desktop app that offers the About row's Uninstall…, and end the run as
  armed. "Not offered" has no row (a portable copy, or no desktop app); "Homebrew copy" shows the
  brew command with Copy and no button; "Ready, no data folder" has no Keep my projects checkbox, as when the app runs with its own data folder; "Removed" goes through Removing… to Novadeck is
  uninstalled with Quit, and "Removed, leftover" adds the command to copy (the Linux sandbox
  profile when no password prompt was available); "Removal fails" keeps the dialog open with
  the reason; "Fails after terminals ended" ends on a reason telling you to quit and open Novadeck
  again, which every retry repeats, and "Trash refused" fails once on macOS' App Management and
  then succeeds; "Windows uninstaller" reads Continue and ends on Novadeck closing for its
  uninstaller, and "Windows uninstaller fails" ends on the reason. Connect agents in
  Preferences first to see them named in the dialog; Agent connections' "Connect fails" makes a
  disconnect fail before the run. `?uninstall=` opens `unavailable`, `manual`, `removed`, `leftover`,
  `failed`, `stopped`, `trash`, `windows`, `windows-failed` or `no-data` for specs.
- **Updates:** Download counts the floating progress bar above the footer's right end up in
  steps, shows it ready for a few seconds, then fades it; Download, held stops it at 40% to
  look at. Download failed holds the bar at 40% for a moment, or fails one already running, and
  drops it with nothing in the footer, as the app tries again by itself (`retrying`). Release
  to fetch shows the Update available chip alone, which opens the release page (nothing opens
  in a browser). Release, needs an administrator shows the Allow updates chip instead
  (Allow when narrow), which stands in for the administrator's step: pressing it starts the
  download. Ready at
  launch offers an update downloaded before this run, which shows nothing, as at a launch.
  Finish restart reloads the demo, as the app comes back on the new version. Experimental on
  and off set the channel; Preferences' Experimental switch, the IS_EXPERIMENTAL flag and the
  chat view it holds back follow once Preferences is reopened.
  What's new, after an update shows the card of three highlights until it is dismissed; What's
  new, text with markup shows highlights holding `<b>` and `**stars**` as typed; What's new,
  longest highlights fills four highlights to the app's limits, so the list scrolls; Updated,
  no highlights has the app answer after 1.5 s that it has nothing, and no card appears; each
  reboots the demo, as the card is asked for once at launch.
  For specs, `?update=` opens any of these by key (`download`, `held`, `failed`, `available`,
  `allow`, `ready`, `whatsNew`, `whatsNewMarkup`, `whatsNewLong`, `noHighlights`). Both panels and the spec keys come from one record, `frontend/demo-debug/src/desktop/scenarios.ts`.
  Specs also take `?channel=experimental`, an app on the experimental channel, so IS_EXPERIMENTAL is on (the
  chat view still needs its own switch on); only specs read it, not `dev:web` or the try demo.

### Visitor build

A clickable, public version of the demo, for a website. `pnpm dev:try` serves its entry
(`apps/try/`) in vite mode `try` (http://127.0.0.1:5190); `pnpm build:try` writes static files to
`apps/try/dist` (the desktop app's own `apps/desktop/dist/` is what it packages), with relative
paths and a hash router, so any static host serves them from any path, and
`pnpm preview:try` serves them on http://127.0.0.1:5191. The [Try
workflow](../.github/workflows/try.yml) deploys a release's build to Cloudflare Pages at
https://try.novadeck.dev, beside the website, so the demo always shows a published
version. Promote to Stable runs it for the release it promotes, so the demo shows what
Download gives people and prereleases never reach it. Run workflow deploys a tag by hand. Quality builds it on every pull request. The
build carries a `_headers` file (`apps/try/src/deploy.ts`, written by `tools/build-kit`):
only novadeck.dev may frame it, nothing of it is indexed, hashed assets are kept for good,
and the posters for five minutes.

The Try workflow also writes four posters into the build before it deploys it, and
`pnpm poster:try` does the same for a local build: `poster-light-1280.webp`,
`poster-light-2560.webp`, `poster-dark-1280.webp` and `poster-dark-2560.webp`. Each is a
screenshot of `?embed&still` (the desk held at its first frames, Claude Code just begun reading, so the live app picks up where the poster is and the plan arriving is the first thing to move), once the app has booted, in a 1280 × 640 window, captured
at its own pixel density (1280 × 640 and 2560 × 1280 pixels) rather than scaled down, from
`apps/try/scripts/poster.ts`. It needs Playwright's Chromium (`pnpm --filter
@novadeck/try exec playwright install chromium`). novadeck.dev's hero shows the one that
matches the visitor's color scheme and screen until the live demo is ready, so it always
pictures the deployed demo; the posters exist only in `apps/try/dist`. Quality's "Build (try)"
captures them too. Run workflow can deploy only releases made since the posters. The
poster run first boots the demo alone three times on a CPU four times slower and fails when
the median is above 8 seconds from the address to Claude Code's terminal drawn (about 2 s
now, as main's; the website gives up at 15). The build fails over its budgets
(`tools/build-kit/src/bundle-checks.ts`, with the numbers in `apps/try/vite.config.ts`): what the page loads first, its scripts and styles gzipped and
every woff2 font they declare, 1,300 kB, and the demo with its terminal emulator, which
loads with the connection, 190 kB.

The hero's terminals are real terminal cells, as the desktop app draws them: the theme's
ANSI palette, boxes in box-drawing characters, text wrapped at the column count. Where xterm
draws with the DOM (Canvas, and browsers without hardware WebGL 2) its box sides show a gap
between rows. A program running in front, as the dev server, draws no prompt under its
output: what is typed shows on a bare line, and it runs no command. The terminal with focus
anywhere in it keeps a screen reader's tree and live region (`screenReaderMode`), and only
that one, so the terminals that go on printing out of focus don't talk over it; a key typed
writes the key alone, which it takes as the key's echo.

Setting it up takes a Cloudflare Pages project named `novadeck-try`, made in the dashboard
(Workers & Pages, Create, Pages, Upload assets) with production branch `main`: wrangler's
`pages project create`, run by an agent, makes a Workers project instead. Add
try.novadeck.dev to it as a custom domain, with the `try` CNAME to `novadeck-try.pages.dev`
it asks for at the domain's DNS host; put an API token with Cloudflare Pages: Edit in the
repository secret `CLOUDFLARE_API_TOKEN` and the account ID in the repository variable
`CLOUDFLARE_ACCOUNT_ID`. Until both are set the workflow deploys nothing and says so; with
only one it fails. Only releases cut with this setup can be deployed, rolled back to
included.

It runs the agents demo's storefront and its other projects as fixtures, with no debug
panel, chat view, voice, murmur, agent connections, notices or updates, and no Welcome
dialog; `frontend/demo/src/visitor/` lists the backend's fields one by one, so nothing added to
the agents demo reaches the page unasked. The desk is never still: Claude Code reads for
five seconds before it asks for its plan to be reviewed (`visitor/story.ts`), the dev server
logs a hot update every 14 seconds and the tests rerun every 23, and Codex, reviewing, has
subagents look into something for a few seconds now and then (`visitor/ambient.ts`). None
of that asks for the visitor or marks a tab, it waits while the page is hidden, and where
the visitor asked for less motion there is none of it and the plan waits from the start. A strip above the header says the agents are
simulated and links to the download (`app/Visitor.tsx`); under 760 px wide a panel pointing
to a desktop browser replaces the app, whose UI unmounts behind it and comes back on
widening. Typing into a shell answers as a simulated one (`mockReply`). A page loaded
before a deploy reloads once when a view it loads later is gone from the host.

Another page frames it at `https://try.novadeck.dev/?embed` (the query string, before any
hash), as the website's hero does. Framed, the app shows neither the strip nor the narrow
window's panel, since the page around it says what it is and decides what a phone gets; it
lays out at the frame's own size, so a page scales a desktop-sized frame rather than
shrinking it; it keeps its address in memory, adding nothing to the framing page's Back
button; and it takes no focus until the person uses it. Its links then carry plain paths
the static host doesn't serve, so a link opened in a new tab from the frame finds nothing;
a click works as anywhere. Once the app is in view (the backend connected, the workspace
mounted and the boot splash lifted) it posts `{ type: "novadeck:ready" }` to its parent
window, once per page load, with target origin `*`: the frame's `load` event fires for an
error page too, so this is how the page tells a booted app from a failed load. The message
carries nothing sensitive; the page checks its origin and source. `?embed` means nothing
outside the visitor build.

A framed app takes no wheel until the visitor engages it: the wheel is kept from every part
of the app, so no canvas pans or zooms, but never cancelled, so the browser scrolls the page
around the frame with it, at the visitor's own pace (a terminal with history above can still
take an upward scroll first, as any scrollable box would). The app has the wheel for the rest
of the page load once the visitor presses in it, or the page posts `{ type:
"novadeck:engaged" }`, which the app accepts only from its parent window. The first click
that completes in the app is told to the page once, as `{ type: "novadeck:clicked" }`,
posted right after the app's own handlers have had it (a tap counts), so the page can
engage then without the click landing elsewhere; it is not sent once the page has engaged
the app. An app that is not framed has the wheel from the start and says nothing. `?still`
holds the desk at its first frames: nothing moves on its own and the plan never comes.

## Repository map

This is a TypeScript monorepo using pnpm workspaces and Turborepo. `apps/` holds what
ships or deploys: the desktop app, the visitor build and the content preview; `frontend/`
the UI, split into packages (the model, the two backend adapters, the terminal views, the
specs and the test kit); `backend/` the runner and the relay; `contract/` the protocol and
the runner client; `engines/` holds the native inference engines Novadeck downloads once
installed, and the build they share; `harnesses/` holds the agent harness adapters and the
contract they share; `libraries/` holds the mechanics that never import app code (see
[libraries/README.md](../libraries/README.md)); `tools/` holds the apps' build helpers and the
atlas.

| Package                   | Responsibility                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `frontend/ui`             | React frontend built with Vite, Tailwind CSS, and Lucide icons.                            |
| `frontend/core`           | The UI's model: types, reducer, stores, and the port to a backend.                         |
| `frontend/toolkit`        | The controls every feature draws with: Ark UI wrappers, shared recipes, the sidebar item.  |
| `frontend/items`          | The items package: kinds, store, taskbar, peek, plan editor, messages, bar drag and homes. |
| `frontend/chat`           | The chat view: transcript, requests and composer, with the chat's own store and commands.  |
| `frontend/runner-adapter` | The UI's backend for a runner, over a WebSocket or the desktop app.                        |
| `frontend/terminal-views` | The xterm mount both backends draw terminals with.                                         |
| `frontend/demo`           | The demo backend: a scripted workspace and simulated terminals.                            |
| `frontend/demo-debug`     | The demo's debug panel and rehearsals.                                                     |
| `frontend/test-kit`       | The frontend's test helpers: a jsdom render, the port contract suite, test phase timing.   |
| `frontend/specs`          | Behaviour specs and integration tests: the whole app over the demo, in a browser or jsdom. |
| `frontend/chat-contract`  | The chat's contract test: recorded harness transcripts through to the rendered chat.       |
| `apps/desktop`            | Electron host that starts the runner and loads the packaged UI.                            |
| `apps/try`                | The visitor build of the demo, which the website embeds.                                   |
| `apps/previews`           | The content preview: the demo with its debug panel.                                        |
| `backend/runner`          | The runner: shells and metadata, served over WebSocket or port.                            |
| `backend/relay`           | Rust relay for agents' Novadeck MCP server and hooks.                                      |
| `contract/protocol`       | Shared Zod contracts the runner and its clients agree on.                                  |
| `contract/runner-client`  | The `connectRunner` client UIs reach a runner with.                                        |
| `engines/whisper`         | Voice engine: whisper.cpp built for download (`build:engine`).                             |
| `engines/murmur`          | Murmur engine: llama.cpp built for download (`build:engine`).                              |
| `engines/ggml-build`      | The engine build both of those share.                                                      |
| `harnesses/core`          | The harness adapters' contract and the helpers they share.                                 |
| `harnesses/claude`        | The Claude Code adapter: hooks, transcripts, dialogs, input box.                           |
| `harnesses/codex`         | The Codex adapter, same shape.                                                             |
| `harnesses/agy`           | The Antigravity adapter, same shape.                                                       |
| `libraries/emulator`      | The terminal emulator: xterm.js pinned and patched, the character-width rule, helpers.     |
| `libraries/terminal`      | Hosting terminals: a pty, a headless screen, a resumable stream, the browser view.         |
| `libraries/tui-input`     | Typing into a full-screen program and checking that the text landed.                       |
| `libraries/viewers`       | Content viewers behind one contract: code, image, markdown and web pages.                  |
| `libraries/wire`          | RPC calls and streams between processes over a WebSocket or a MessagePort.                 |
| `libraries/sandbox`       | An isolated environment for tests and benchmarks that run real shells and programs.        |
| `libraries/log`           | Structured, privacy-first log files: the line, the rotating file, the redactor.            |
| `libraries/secrets`       | Finding secrets in terminal text by their shape, and masking them.                         |
| `tools/build-kit`         | The apps' Vite helpers: CSP sources, hosting headers, noindex, fonts, bundle checks.       |
| `tools/atlas`             | Dev-only code map: `pnpm atlas`; agent briefs: `pnpm -s atlas:brief`.                      |
| `scripts`                 | Repository checks and automation.                                                          |

Build an engine locally with `pnpm --filter @novadeck/whisper build:engine` or
`pnpm --filter @novadeck/murmur build:engine`; the archive and `engine.json` land in
the package's `dist/`.

The UI runs real shells through the runner. Projects, sessions and their terminals
live in the runner's SQLite metadata, and each session saves its terminals' order and
layouts there too; preferences (the light, dark or system mode among
them) and sidebar settings are stored locally. Unit tests
and behaviour specs run on the demo adapter's sample data instead.

See the [terminal backend plan](backend-plan.md) for the proposed runner
architecture and typed API.

The standalone backend now supports authenticated, real terminal processes and
persistent project/session metadata. The Electron host runs it in a utility process,
but the interface above is **not connected yet** and still uses mock data. See the
[backend API guide](backend-api.md) for configuration, client examples, and
backend-only tests.

### Working on the UI

The UI is split into packages: `frontend/core`, `frontend/ui`, `frontend/toolkit`,
`frontend/items`, `frontend/chat`, `frontend/runner-adapter`, `frontend/terminal-views`, `frontend/demo`, `frontend/demo-debug`, `frontend/test-kit`,
`frontend/specs` and `frontend/chat-contract`, and the apps `apps/desktop`, `apps/try` and `apps/previews`. `frontend/ui`
holds the page's layers, each a folder of its `src/`; the rest are packages of their own. In
the table a path that starts with `frontend/` or `apps/` is a package, and any other is a
folder of `frontend/ui/src/`:

| Location                                                        | What belongs here                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `app/`                                                          | Composition root: router, provider, backend selection, and the page sections.                                                  |
| `app/ui-store.ts`                                               | The UI store: route, preferences, shell, rename, switcher, and its store subscriptions.                                        |
| `app/selectors.ts`                                              | Pure reads over the stores that sections, commands, and keys share.                                                            |
| `app/commands/`                                                 | Commands, key commands, and the navigator: plain functions over both stores.                                                   |
| `app/controller/`                                               | React glue: context, selector hook, route sync, keyboard dispatcher, effects.                                                  |
| `frontend/demo/src/`                                            | The demo adapter for the website, tests and specs: sample projects, the backend and its variants.                              |
| `frontend/demo/src/agents/`                                     | Its agents: turns, conversations, the requests they make, and their transcripts.                                               |
| `frontend/demo/src/terminals/`                                  | Its simulated terminals: the engine and the screens they draw through.                                                         |
| `frontend/demo/src/screen/`                                     | What a terminal's screen writes as terminal output, and the keys read back from it.                                            |
| `frontend/demo/src/inbox/`                                      | The Inbox's hardcoded rows and the transcripts behind the Inbox demo's sheets.                                                 |
| `frontend/demo/src/addons/`                                     | Pretend voice input and murmur addons.                                                                                         |
| `frontend/demo/src/showcase/`                                   | The showcase demo the content preview opens: sample agents' plans, artifacts, and their simulated work.                        |
| `frontend/demo/src/videos/`                                     | One-off demos for videos: Chirp, Babcia and Launch.                                                                            |
| `frontend/demo/src/visitor/`                                    | The try demo a visitor plays with on the website.                                                                              |
| `frontend/runner-adapter/src/`                                  | The runner adapter: connection, terminals, sessions, companions, agents, addons and the desktop app's bridge.                  |
| `frontend/terminal-views/src/`                                  | The xterm mount both adapters draw terminals with: theme, WebGL pool, links, styles.                                           |
| `frontend/core/src/`                                            | Pure domain: types, reducer, store, seed and the backend port, then its domain folders (below).                                |
| `frontend/core/src/items.ts`                                    | Items, their content, the `companions` port, and the plan note format.                                                         |
| `frontend/core/src/items/companion-bar.ts`                      | A bar as the person arranged it: order, hidden plans and Messages, the open tab.                                               |
| `frontend/core/src/messages.ts`                                 | The contract for agents' messages: threads, states, the pause, and a tab's count.                                              |
| `frontend/core/src/conversation.ts`                             | The contract for an agent's conversation: transcript items, requests, the port.                                                |
| `frontend/core/src/inbox.ts`                                    | The contract for the Inbox: rows by source, their type and urgency, answers, the port.                                         |
| `frontend/core/src/source.ts`                                   | The contract for the Source panel: a project's folders, listed one at a time, and what its agents changed.                     |
| `frontend/core/src/conversation/picks.ts`                       | What the person has picked and written for a dialog's questions, and the answer it makes.                                      |
| `frontend/core/src/conversation/turns.ts`                       | A conversation grouped into blocks, the turn's status.                                                                         |
| `frontend/core/src/roster.ts`                                   | A session's terminals and undocked windows, laid out as tiles, their order and status.                                         |
| `frontend/core/src/layout/workspace-layout.ts`                  | Where each terminal sits and how big it is in each view.                                                                       |
| `terminals/`                                                    | Terminal frame, tabs, rename state, and the recent-terminal switcher.                                                          |
| `frontend/items/src/`                                           | Items: `store/`, `bar/` (taskbar, peek, drag), `registry.ts`, `kinds/<kind>/` (one folder per kind), `document/` and `homes/`. |
| `frontend/items/src/bar/drag-session.ts`                        | What's dragged off a taskbar, the views' drop spaces, and the windows it's over.                                               |
| `frontend/chat/src/`                                            | The agent's chat: its blocks, tool rows, requests and the composer, and the chat's own store (`state.ts`) and commands.        |
| `layouts/canvas/`, `grid/`, `focus/`                            | View adapters and colocated library styles.                                                                                    |
| `layouts/` (top level)                                          | Helpers shared by views: view transitions, background gestures, visibility.                                                    |
| `inbox/`                                                        | The Inbox: what agents ask of the person, its sidebar rows and the sheet that answers.                                         |
| `shell/`                                                        | Header, rail, panels, zen dock, sidebar, and shell state transitions.                                                          |
| `sidebar/`, `projects/`, `preferences/`, `search/`              | Feature components.                                                                                                            |
| `interaction/`                                                  | Shortcut records, the keymap, and shared DOM focus/overlay contracts.                                                          |
| `frontend/toolkit/src/`                                         | Reusable controls, direct Ark UI imports, their recipes, the sidebar item and `Markdown`.                                      |
| `test/`                                                         | The command harness: the real stores, navigator and commands, for tests.                                                       |
| `frontend/test-kit/src/`                                        | A jsdom render helper, the port contract suite, and test phase timing.                                                         |
| `assets/`                                                       | Static files referenced from CSS.                                                                                              |
| `theme/`                                                        | Tailwind's layout-only theme, token defaults, Coolant and Phosphor, `apply.ts`.                                                |
| `styles.css`                                                    | The cascade order, every recipe, theme and vendor sheet in its layer, Tailwind sources.                                        |
| `frontend/specs/src/`                                           | Behaviour specs for the whole UI in domain folders, and the spec backend over the demo.                                        |
| `entries/start.tsx`                                             | How every app starts: applies the theme, renders the app it is given.                                                          |
| `apps/try/src/`, `apps/previews/src/`, `apps/desktop/renderer/` | Each app's pages and entry: it picks its backend and renders `App` with `start`. The desktop app's `src/` is its main process. |

Imports point down the layers. The core, `frontend/core`, imports nothing else: no UI layer,
no React, and among packages only the protocol's data-only entries (`/harnesses`, `/pages`,
`/text`, `/sounds`, and `/release-notes` for its types alone), which
`frontend/core/src/architecture.test.ts` checks. Everything outside it reaches it as
`@novadeck/core/*`, the package's exports; inside it files import one another by relative
path. Its hubs sit at the top of `src/`; the rest is in domain folders: `agents/`, `inbox/`,
`conversation/`, `items/`, `terminals/`, `desktop/`, `addons/`, `feedback/` and `layout/`.
`theme/` imports nothing but itself and the core's types; every layer that
composes the page may use it, though no backend does (the entries hand them the page's
theme), and [docs/theming.md](theming.md) is its contract with components.
Each backend adapter, `frontend/runner-adapter` and `frontend/demo`, builds only on the core
and `frontend/terminal-views`, never on the app's chrome; the package graph holds that, as a
package imports only what its `package.json` declares. The demo's debug panel is a package
of its own, `frontend/demo-debug`, the one with React and Lucide. `interaction/` builds on
the core and imports no packages;
features add `frontend/toolkit`; `layouts/` may use
`terminals/`; the items package, which holds the companion pane, is a package of its own, `frontend/items`, built on the
core, the toolkit and the viewers and never on the UI, which composes it, as it does the chat, another package, `frontend/chat`, built on the core and the toolkit and never on the UI or the items package; no feature
(`inbox/`, `preferences/`, `projects/`,
`search/`, `sidebar/` or `voice/`) imports another, only the base and itself, and none reaches the
chat or the items package; `shell/` may use `layouts/`, `projects/`,
and `inbox/`. `app/` composes every feature layer, `inbox/` among them.
Only an app imports a backend adapter, each its own: `apps/desktop` takes the runner adapter,
`apps/try` the demo, and `apps/previews` the demo with its debug panel (tests and specs may
import the demo's spec entry). Each starts the UI through `entries/start.tsx`. `app/commands/`
has no direct React or package imports, though
routing still loads React Router at runtime: it builds on the core,
`interaction/keymap.ts`, the UI store, routing, selectors,
the Canvas handle type in `layouts/canvas/types.ts`, and the pure state modules
of `shell/` and `terminals/` (unread finishes among them), the item store and the chat's store among them. Vendor
libraries stay in their adapters: XYFlow in `layouts/canvas/`, React Grid Layout
in `layouts/grid/`, Allotment in `shell/`, dnd kit in `terminals/`, Ark UI in
`frontend/toolkit`, React Router in `app/` and `shell/`, and React DOM in
`layouts/transition.ts` and `entries/start.tsx`; and the runner client and
the emulator's view in `frontend/runner-adapter/`, the demo's terminals
(`frontend/demo/src/terminals/`, `frontend/demo/src/screen/`) and `frontend/terminal-views/`,
which both adapters draw their
terminals with and which imports only the core and libraries; no
backend reads `theme/`, as the entries hand it the page's theme. Other packages are denied
unless the test lists them: React and Lucide are allowed in every layer above that takes
packages, and test code may use any package but one the test gives other
owners. `test/` may import
the core and what the command harness runs: `app/commands/`, the UI
store, routing, and the Canvas handle type. Hooks declare named contracts instead of
`ReturnType<typeof useHook>`. `frontend/ui/src/architecture.test.ts` enforces these rules and
fails for a source file that belongs to no layer.

Navigation uses React Router with hash URLs in both the browser and Electron,
so links work with the packaged `file://` UI and static hosting. For example:

```text
#/projects/storefront/sessions/initial/canvas?terminal=05&panel=sessions
```

The path selects a project, workspace session, and view. Query parameters select
the terminal, sidebar panel, and dialog (`dialog=search` or `dialog=preferences`);
Preferences also accepts `section=shortcuts`. Back and Forward restore navigation
without discarding terminal drafts or output. Sidebar visibility, search text,
canvas gestures, and other temporary controls stay out of the URL.

Demo sessions use the stable ID `initial`; with the runner, projects, sessions,
and terminals use UUIDs the UI generates, so links survive a reload. A link to a
session that no longer exists falls back to that project's available session.
Unknown routes, missing terminals, and disabled views are replaced with a valid URL.

The page renders from two synchronous stores, and from a third where a backend has
companions; the backend also keeps small stores of its own, such as `telemetry`. The
workspace store in `frontend/core/src/store.ts` holds the model: every session's
roster of terminals and undocked windows, layout, navigation memory, its companion items
as the backend reports them, and how the person arranged each bar (`frontend/core/src/items/companion-bar.ts`),
changed through one pure reducer. The UI store in `app/ui-store.ts`
holds what the model does not own: the current route, preferences, the shell
state from `shell/shell-state.ts`, the rename in progress, the recent-terminal
switcher and each session's most-recent order, the new-terminal highlight, whether the
page has focus, and the terminals whose agent finished unseen (`terminals/unread-state.ts`,
kept by `watchFinishes`, which also asks the backend's `notices` for a notification).
It starts over on reload apart from preferences, the collapsed sidebar and the
project arrangement (the switcher's order and pins, `novadeck.project-arrangement`),
which store subscriptions persist. Another subscription saves the active session's
windowed view from the workspace store, and a new App seeds sessions with it. The
item store in `frontend/items/src/store/item-store.ts` holds what it loads for the items,
by item: each plan as the person edits it, what each item last loaded, and the secret
files the person chose to see; it follows the backend's companions from an effect, and
`followMessages` (`frontend/items/src/homes/terminal/messages/messages.ts`) puts messages on their
terminal's bar from another. What an item loaded stays 30 seconds after nothing shows it, then goes, so a
large image doesn't stay in memory. What a taskbar shows is derived from it and the workspace in
`frontend/items/src/bar/bar.ts`, never stored.
`WorkspaceProvider` creates the backend, the stores, the drag session
(`frontend/items/src/bar/drag-session.ts`), the navigator, and the commands once per App, in a pure
initializer, and shares them through context; it receives the page as children, so a URL
change re-renders only the provider.

The URL owns current navigation; the workspace model remembers each session's
last selection. The navigator in `app/commands/navigator.ts` commits a
destination's workspace actions and route to the stores before it asks the
router to navigate, so a command's changes and its URL render together. The
route sync in `app/controller/useRouteSync.ts` is the one place the URL enters
the stores: in a layout effect it reconciles Back, Forward, typed URLs, and
preference changes against the latest model and replaces a URL that names
something unavailable. A session change starts the shell's presentation over in
the same commit, through a store subscription, and Back or Forward does the same
from route sync, so a view that mounts next already sees it.

Commands in `app/commands/` are the operations the pointer UI and the keyboard
share. They are plain functions that read the latest stores when they run, so
several in one event retain one another's changes; construct an action from
command-time state when it depends on a counter or the current selection. They
reach the page (focus, view transitions, timers, the clock, ids) only through the
`CommandEffects` that `app/controller/effects.ts` supplies, and tests pass their
own. Address updates by project and session IDs so delayed callbacks affect
their original session or become a no-op after it is removed: layout callbacks
take the target their view rendered with, because Canvas saves its geometry when
it unmounts after a session switch.

Keyboard shortcuts are data. `interaction/keymap.ts` lists every binding by
layer and routes a key from its input, the kind of element it was pressed on,
and the store state, without touching the DOM; `app/commands/keys.ts` maps each
command id onto the commands, and `app/controller/useKeyboard.ts` listens on
window in the capture and bubble phases of keydown, and for keyup and blur.
Preferences renders its shortcut table from `shortcutGroups`. Canvas keeps its
own zoom keys.

Sections in `app/` subscribe to just what they render with `useWorkspaceState`
and `useUiState`, built on `useStoreSelector`, and share selectors from
`app/selectors.ts`. Each terminal frame and sidebar tab selects by its own
terminal, so a rename keystroke re-renders only that tab and frame. A Canvas
layout save re-renders the stage section, Canvas, and the terminals on it, but not
the header, sidebar, tabs, or overlays. Effects that must follow a commit, such as
saving a rename left behind, live in `app/controller/useWorkspaceEffects.ts`.
Feature components outside `app/` take props.

Terminal metadata and saved layouts live in the workspace model. Everything
else about a terminal belongs to a backend behind the port in `frontend/core/src/port.ts`:
it supplies the starting workspace seed, allocates new terminals synchronously,
sees every store commit before listeners run, and mounts each terminal into the
element its frame gives it. A terminal's mount marks the element that takes typed input with
`data-terminal-input`, so shortcuts treat it as terminal input; from there the app's
shortcuts run in capture, ahead of the terminal's emulator, which takes the keys it reads
before they bubble. The demo adapter draws its terminals as the runner's are drawn, through
`frontend/terminal-views/` and `@novadeck/terminal/view`: each is a real xterm fed by a
stream the demo writes as terminal output (`frontend/demo/src/terminals/screens.ts`). Its screen
(`frontend/demo/src/screen/`) keeps an append-only transcript (the program's sample output or
the agent's opening, the commands typed and their replies, the agent's conversation) and
redraws a live tail in place (the dialog an agent waits on, its status, the prompt), as Claude
Code and Codex redraw their bottom; a resize draws it whole at the new width. Keys come back
through a line editor (`frontend/demo/src/screen/line-editor.ts`). The engine keeps each terminal's
command line and output with one subscription each, so output does not trigger
workspace-wide renders. A terminal's
presentation can unmount during view or session changes without losing that
state; closing the terminal removes it. `frontend/core/src/terminals/registry.ts` provides this
lifecycle for any adapter. An adapter opts into the port contract suite by
calling `describeBackendContract` from `@novadeck/test-kit/backend-contract` in a
colocated `contract.test.ts`, with a probe of what it holds and the I/O it
started, and a driver when it has `start`. `App` reads its backend once at mount: each
app's entry chooses its own, a runner connection for the desktop and web
apps, or the demo in the content preview and visitor builds. Tests and specs pass the demo's
spec backend (`frontend/specs/src/support/backend.ts`) themselves.

Each app is an entry of its own, named by its Vite mode, so a deploy carries only its own
chunks. The desktop and browser apps are in `apps/desktop`: the desktop page is
`renderer/index.html` (built to `dist/`, which the app packages and loads, and the dev server's
root page in development), and the browser page is `renderer/web/` (mode `web` for
`pnpm dev:web`, built to `dist-web/`). The visitor build and the content preview are apps of their own,
`apps/try` and `apps/previews` (modes `try` and `content-preview`), each with its page at the
package's root and built to its `dist/`. Every page is the same document but for the script it
starts, which `apps/try/src/deploy.test.ts` checks; an app's page starts its entry through
`src/main.tsx` (the desktop app's pages through the `main.tsx` beside each), as a dev server
serves only what's under its root. A backend that must connect first supplies a
`ConnectBackend`; `app/BackendGate.tsx` shows a splash until it resolves with the
seed loaded, or a card saying what failed with a Retry button, and closes it on unmount.

A backend reports changes of its own, such as a process exiting or failing to
start, through the optional `start`. It runs from an effect after mount and
receives a sink that commits each call as one store transaction, like a UI
command; the sink ignores stale targets and anything sent after stop. It reports
status and the foreground process, which picks the terminal's icon and counts it as
running, and closes a terminal whose shell exited cleanly. What an agent's status line
says of its context, limits, model and effort goes to the backend's `telemetry` store
instead, by session and terminal, so a report every few seconds re-renders only what
shows it, never the roster. The frame labels an exited, killed, or failed terminal.
Closing a terminal a program runs in asks first:
the `close` command records the pending close in the UI store, and the dialog in
`terminals/CloseTerminalDialog.tsx` answers with `confirmClose` or `cancelClose`. A backend may also
expose its connection state, which the footer shows, and a folder picker, which
enables "Open folder…".

The runner adapter creates projects, sessions, and terminals on the runner as their
commits arrive, and saves each changed session after a short pause and on
`pagehide`. On load it restores saved sessions, most recently visited first, and adds
running terminals the save did not know. A terminal the runner no longer has, after
a runner restart or a relaunch, gets a fresh shell in place with the same id, name
and layout once its session is on screen, or at once when it has an agent to resume;
more than three runner restarts in a minute stop that, and each terminal then waits
for Enter. An exited, killed, or
failed terminal shows "Press Enter to restart", which starts a fresh shell in the
same tile. While the runner is away, terminals dim and refuse input.

XYFlow owns live Canvas gestures; save geometry and camera state when a gesture
ends or the view unmounts. Grid, Canvas, Preferences, and search load on demand.
Keep vendor-specific types and CSS inside their adapters, and use
application-owned types for saved layouts.

Keep direct Ark UI imports in `frontend/toolkit`; features own their content and state.
Use Tailwind utilities in TSX only to arrange elements: layout, spacing, sizes, and
the size and flow of type. How a component looks comes from its recipe, a stylesheet
beside it that reads theme tokens; see [docs/theming.md](theming.md), which
`theme/contract.test.ts` enforces. See [CODING.md](../CODING.md) for broader
conventions.

### UI behaviour specs

`frontend/specs/src/` describes the UI the way a person uses it and guards the UX while
the implementation changes. Each spec renders the whole app in headless Chromium
with real CSS, layout, pointer, and keyboard input. The main behaviour project
enables reduced motion; the smaller motion project exercises ordinary transitions.
Specs find elements by accessible role, name, or text, and assert only what a
person can observe: what is visible, focused, selected, or where it sits on
screen. They never import components, mock app modules, or select by CSS class,
so a refactor that keeps the UI intact keeps them green. `frontend/specs/src/support/` holds
the shared vocabulary (for example `openWorkspace`, `terminal`, `chooseView`);
when markup changes on purpose, update it there. If a behaviour can't be reached
through accessible markup, improve the markup rather than adding test IDs.

Install the browser once with `pnpm --filter @novadeck/specs exec playwright install chromium`.
Run a single spec with `pnpm --filter @novadeck/specs exec vitest run --project behaviour src/views/canvas.spec.tsx`,
or `--project integration` for the tests that render the whole workspace in jsdom over the
spec backend (render scope, the terminal and overlay wiring; they are `*.test.ts` files here,
as `support/backend.ts` is the one file that may import the demo), and `--project motion` for
transition behavior. The specs package has no `unit` project: reducer invariants, terminal
lifecycle, layout rules, stores, commands, keymap routing and architecture rules are
colocated `*.test.ts` files in the package that owns them, run with `pnpm --filter
@novadeck/<package> test`. The desktop app's build
checks, which validate both entry assets and deferred chunks with relative packaged paths,
are `apps/desktop/src/build.test.ts`.

### UI counter run

`frontend/specs/src/counters/` measures what busy agents cost the UI. It isn't a behaviour spec. It
boots the real app, its runner adapter and the real runner client over a scripted runner
(`frontend/runner-adapter/src/testing/scripted-server.ts`): the whole contract served by oRPC over an
in-memory port, so a procedure the contract adds is a type error there. It is the one spec that may
reach that adapter. A warm-up on the real clock loads the views' code first, then closes
and waits out the timers that act (a screen parks 5 s after it was last shown). The run
itself is on a fake clock: timers, animation frames, `Date` and `performance` move only
when the script moves them, React works inside `act`, and a frame that changed the page
waits real frames until it is still. The fixed script plays 13 Claude terminals'
status-line ticks and output in Grid, then in Focus once the terminals Focus doesn't show
have parked, then switches between them in Focus. It counts store listeners woken (through
`countListenersWoken` in `frontend/core/src/store.ts`, test instrumentation that does nothing
otherwise) and DOM mutation records per tick, output bytes the runner sends the UI, and
terminals streaming at once. React commits and component renders per tick are counted
beside them, through a stand-in for React DevTools' hook. Every run gives the same counts,
and a probe that hears nothing in a phase fails the run. Run it with `pnpm --filter
@novadeck/specs exec vitest run --project counters`; it leaves its reading in
`frontend/specs/test-results/counters.json`. It runs in `pnpm test` on every platform:
its own checks hold on each.

The Benchmark workflow runs it on Linux for every pull request whose change can move a
count (the UI, the runner, their contract, `libraries/`, the lockfile or the checker), and
on main for the trend. It warns when a count goes past its budget in
`frontend/specs/src/counters/budgets.json` and fails when one goes past twice it
(`failsAt` in `scripts/benchmark/counters.ts`: loose by choice while the product is early),
or when a phase's script plays another number of ticks than its budgets record. Commits and component renders are reported in the
job summary, never gated, and each run's reading is kept as an artifact. Locally, after
the counter run, `node scripts/benchmark/main.ts` checks the reading the same way, and
`node scripts/benchmark/main.ts <base budgets.json>` checks budget changes too, as CI does
against the base branch.

A count past its budget is a regression, never noise: fix it, or, for work that really
costs more, raise the budget in the same pull request (past twice it, one of the two must
happen before it merges), written `{ "budget": n, "reason":
"why", "from": "#PR" }`, where `from` names that pull request (on main, any source but the
raise it replaces). A count under its budget asks for the budget to come down, so the gain
stays. The job summary shows every budget a change moves, old to new, and a raise without
its reason and its own pull request fails.

The base branch's budgets are read only as far as the comparison needs, so a change to the
file's form lands in one pull request. A budget the base lacks shows as new, and needs a
reason as a raise does when its phase is one the base has; one the base has and the change
drops shows as no longer budgeted; a base that has none of the phases only warns. The
check always reports, so it can be required.

The timing run, the real app in the sandbox (`pnpm bench:timing`), is too heavy and too
noisy for every pull request: the Benchmark Timing workflow runs it nightly on main and on
pull requests labelled `bench`. It reports switch p90, each layout's main-thread share and
frames over 33 ms in the job summary and in one comment on the pull request, beside main's
last nightly run, and keeps each report as an artifact. It never fails on its numbers, only
when the sandbox leaked or couldn't be made, which the report then leads with.

## Configuration

For standalone UI/runner configuration, copy the environment templates:

```sh
cp frontend/ui/example.env frontend/ui/.env
cp backend/runner/example.env backend/runner/.env
```

- Browser UI: `VITE_NOVADECK_RUNNER_URL` (a `ws:` or `wss:` URL ending in `/api/rpc`)
  and `VITE_NOVADECK_RUNNER_TOKEN` name the runner a browser build (the web entry,
  `--mode web`) connects to; the CSP permits that origin. The desktop app ignores them and
  uses its own runner.

  > **Warning:** a browser build made with `VITE_NOVADECK_RUNNER_TOKEN` embeds the
  > token in its JavaScript. Anyone who can load that bundle can run shells on the
  > runner as its user. Keep such builds private: never deploy or share them.

- Runner: `HOST`, `PORT`, and `CORS_ORIGINS` control the listener and allowed frontend origins; a `HOST` that isn't loopback is refused unless `NOVADECK_ALLOW_REMOTE_HOST=1`.
- Terminal API: `NOVADECK_TOKEN` enables authenticated WebSocket RPC;
  `NOVADECK_DATABASE` optionally selects the SQLite metadata file. Without a token,
  only the existing HTTP status API is available.
- Electron: the host runs the runner in a utility process and hands each window a
  MessagePort through a sandboxed preload bridge. It also serves the status endpoint
  on a local, OS-selected port. Package `.env` files are not used.

Local `.env` files are ignored by git; never commit credentials.

## Validation

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Use package filters for focused checks, for example `pnpm exec turbo run test --filter=@novadeck/ui`,
which builds what the tests need first. `pnpm test` runs the packages' tests in parallel,
but the frontend packages' and apps' tests (the browser specs among them), the runner's real-PTY
tests and the host's run one at a time, after the rest: they are timing-sensitive, and the UI's
and the runner's, run together, starved the
smaller CI runners enough to time out. What each task waits for, and why, is in [docs/build-graph.md](build-graph.md).
Tests use Vitest: UI behaviour specs run in Vitest Browser Mode on Chromium, and
MSW covers HTTP behavior. The PR workflows run formatting, lint, typechecking,
builds, and PR metadata checks on Linux. The Test jobs run all package and repository
tests on Linux, macOS, and Windows, including for draft PRs. Each runs UI tests in
Chromium alongside backend API, real PTY, and built-CLI tests. The required `Test`
check passes only when the entire Quality matrix succeeds. Once it has, a PR ready for review
packages and smoke-tests the app on Linux, macOS, and Windows, through the
[Package](../.github/workflows/package.yml) workflow releases use too, which Quality calls: no
runner waits for the checks. It does so only when the change
can affect the packaged app (`scripts/package/plan`: the host and every package it's built from,
apart from their tests and prose, the dependency pins and patches, and the workflows that
package). Draft PRs skip packaging; PR checks never create tags or publish releases.
Quality checks run on PR opening, reopening, and commits. A PR reads only its own and
its base branch's caches, so the [Warm Caches](../.github/workflows/warm.yml) workflow fills main's test
browser and Rust build caches on each push to main, under Quality's keys, and runs no tests.
Marking a draft PR ready
starts only the Package workflow, which waits for Quality's `Test` check of its head,
usually already there, before packaging and smoke testing. Release preparation, tagging, and publishing are
disabled for PR runs.

### Known flakes

Tests that sometimes fail for reasons outside the change under test are registered in
`scripts/flakes/register.json`: each by the jobs it fails, its test, a signature its
failure's log matches, what is known of its cause and where it was seen. When a Quality
(a pull request's packaging included), E2E or Package run fails, the Known Flakes workflow reads its failed jobs'
logs with main's register. If every failure is a known flake, it reruns the failed jobs
once, unless the run was rerun meanwhile or its pull request has moved on, and records why
in the job summary and on the pull request. A failure it can't explain or read, a known
flake failing again on the rerun, or a flake registered as fixed coming back is left
failed, to triage; the pull request hears of it only when a registered flake is involved,
and a rerun's own failure may go unjudged, as GitHub starts no workflow from one. A
packaging run that failed because the Quality checks it waits for failed isn't rerun with
them: rerun it by hand once they pass. Prefer fixing a flake at its cause over registering
it; when it is fixed, mark it `fixed` rather than removing it, so its return is noticed.
`node scripts/flakes/main.ts <logs dir> <verdict> <comment>` judges logs downloaded from a
run the same way.

## Packaging and releases

```sh
pnpm package:linux
pnpm package:mac
pnpm package:win
```

Artifacts go to `apps/desktop/release/`:

- Linux x64: `novadeck-linux-x86_64.AppImage`, built on the static type2 runtime so it
  mounts with FUSE 3. Releases also carry `install.sh`, the installer in
  [scripts/install](../scripts/install) with the repository filled in.
- macOS universal: `novadeck-mac-universal.dmg`, the disk image to drag the app to
  Applications from, and `novadeck-mac-universal.zip`, which updates install from.
- Windows x64: `novadeck-win-x64-setup.exe`, a one-click installer that installs for the
  current user without an administrator prompt.

None of the names carries a version, so `releases/latest/download/<name>` is always the
newest stable build. The ZIP and the AppImage are not advertised: `install.sh` installs
the AppImage, which replaces itself in place once installed, and the app from the ZIP.

Local builds are unsigned, so Gatekeeper or SmartScreen may warn. The application ID is `dev.mzpk.novadeck`.
Releases are signed and notarized once the signing credentials are set up; see
[docs/release-signing.md](release-signing.md).

Builds also write `latest*.yml` update metadata and `.blockmap` files beside the packages,
which releases upload so installed apps can update themselves; see
[docs/auto-update.md](auto-update.md).

Each package ships the relay agents start for Novadeck's MCP server and hooks, built
from source with the rest of the app; the Windows packages also ship `novadeck-cmd.exe`, the
`cmd.exe` pass-through Antigravity's hooks run through where cmd's AutoRun prints (see
[agent messaging](agent-messaging.md)), beside it in `relay`.

The [release workflow](../.github/workflows/release.yml) publishes immutable GitHub
prereleases from qualifying changes on `main`, with notes, checksums, and native
packages. It smoke-tests each packaged application before upload, installs the AppImage and
the macOS app through `install.sh` served from a local copy of the release, and fails when
the installed AppImage runs without Electron's sandbox. The packaged binary's Electron fuses
(`electronFuses` in `apps/desktop/electron-builder.yml`) turn off running it as Node,
`NODE_OPTIONS` and the inspect arguments, and turn on the asar integrity check and loading the app only
from `app.asar` (the UI in `resources/ui` is outside that check); the smoke test reads them back. The smoke test drives the shipped binary itself over Chromium's
remote debugging port (no fuse covers it) and quits it as a person does. What needs the app to
run as Node or under Playwright's inspector (the smoke test's worker and koffi checks,
`scripts/bench/profile`) uses `openedCopy` from `apps/desktop/scripts/fuses.mjs`: a copy of the
app with only those three turned on (beside the executable on Linux and Windows; on macOS the
whole bundle, copied to a scratch folder and signed ad hoc there). The workflow feeds
its own repository into the update feed baked into each app and into `install.sh`, so
moving the repository needs no edit. Conventional
Commits determine release eligibility; versions are currently limited to patch
increments. Documentation-only changes do not trigger a release. See
[.release-it.json](../.release-it.json) for the release configuration.

Bump `engineInterface` in `engines/whisper/scripts/build.ts` (voice) or
`engines/murmur/scripts/build.ts` (murmur) with any change to the server flags the
runner passes, the requests it makes of the server, the patched HTTP surface or, for
murmur, the `--list-devices` output: during an update the runner uses an older engine only
if it speaks the same interface. Both engines are built by the shared
`engines/ggml-build`.

There are two channels. Every release from `main` is a prerelease, the experimental channel. The
stable channel is GitHub's latest release that is not a prerelease, which installs, the
`releases/latest/download/` links and, by default, installed apps follow. Promote a tested
prerelease by running the [Promote to Stable](../.github/workflows/promote.yml) workflow from
the Actions tab, with a version such as `1.2.3` or none for the newest prerelease. It
checks that the release is published, is a prerelease, carries every package, `latest*.yml`
and `install.sh`, and is newer than the current stable release, then clears **Set as a
pre-release** and sets it as the latest. No rebuild happens, and GitHub still lets those
two flags, and the notes, change on an immutable release.

Release notes are written by a model through OpenRouter
([scripts/release-notes](../scripts/release-notes)). After each prerelease is published, its
commits become short lines grouped by area, led by up to two highlights of new features, each
a short title and line for the what's-new card with an icon the model picks from a fixed set,
its change kept in full under its area; when a prerelease is promoted, its notes are rewritten
with up to four highlights picked from everything since the last stable release. The app
shows a release's highlights after updating to it until the person dismisses them. The
`OPENROUTER_API_KEY` repository secret enables it, and the `RELEASE_NOTES_PRERELEASE_MODEL`
and `RELEASE_NOTES_PROMOTE_MODEL` repository variables pick the models (by default
`anthropic/claude-haiku-5.5` and `anthropic/claude-sonnet-5.5`). Without the key, when the key is
out of credit, or when a run fails, a release keeps the notes it has, the run page shows a
warning, and neither step holds a release or a promotion. A promotion costs about $0.25 and a
prerelease well under a cent. With `OPENROUTER_API_KEY` and a `gh` login,
`node scripts/release-notes/main.ts promote v1.2.3 --dry-run` prints what a promotion would
write without changing any release; it asks the model, so it spends credit.

For an interrupted release, inspect the latest
workflow first. An unpublished draft or orphaned version tag must be cleaned up before
rerunning the latest release workflow; published immutable releases must remain intact.

## Contributing

Start with [AGENTS.md](../AGENTS.md) for the required reading,
[CONTRIBUTING.md](../CONTRIBUTING.md) for the issue and PR workflow, and
[CODING.md](../CODING.md) for code and test conventions. Follow
[SECURITY.md](../SECURITY.md) for credentials and vulnerability reports.
