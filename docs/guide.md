# Using Novadeck

The full guide to how Novadeck behaves: installing and removing it, its views, terminals,
agents and Inbox, restoring after a reboot, Zen mode and keyboard shortcuts. For a quick
overview, see the [README](../README.md).

## Install

- **macOS:**

  ```sh
  curl -fsSL https://github.com/novadeck-org/novadeck/releases/latest/download/install.sh | sh
  ```

  Run it as yourself, not with `sudo`, and quit Novadeck first. It checks the download
  against the release's `SHA256SUMS` and puts the app in `/Applications`, or in
  `~/Applications` when your account cannot write to `/Applications`. Run again, it
  upgrades the copy already there, preferring `/Applications`. If another account put
  Novadeck in `/Applications`, the script stops and leaves that copy for the account that
  installed it. You can also download
  [`novadeck-mac-universal.dmg`](https://github.com/novadeck-org/novadeck/releases/latest/download/novadeck-mac-universal.dmg)
  and drag the app to Applications.

- **Windows:** run [`novadeck-win-x64-setup.exe`](https://github.com/novadeck-org/novadeck/releases/latest/download/novadeck-win-x64-setup.exe).
  It installs for the current user without an administrator prompt.
- **Linux (x86_64):**

  ```sh
  curl -fsSL https://github.com/novadeck-org/novadeck/releases/latest/download/install.sh | sh
  ```

  Run it as yourself, not with `sudo`. It puts the AppImage in `~/.local/share/novadeck`
  with a menu entry and a `novadeck` command in `~/.local/bin`, checks every download
  against the release's `SHA256SUMS`, and upgrades when run again. The AppImage needs FUSE
  (the `fuse3` package), but not libfuse2.

  On systems that block unprivileged user namespaces, as Ubuntu does from 24.04, Electron's
  sandbox starts only with an AppArmor profile, so the script asks for your password once
  to write `/etc/apparmor.d/novadeck-appimage-<uid>`. The profile lets a program at your
  install's path, or at `~/Applications/novadeck.AppImage`, use user namespaces, and so
  does everything Novadeck starts, including the programs run in its terminals. Both paths
  are yours to write, so any program running as you could use them too. Without the
  profile Novadeck still runs, without its sandbox, and says so in the footer. To write the
  profile later, or for an AppImage in `~/Applications`, run the script with `--sandbox`:

  ```sh
  curl -fsSL https://github.com/novadeck-org/novadeck/releases/latest/download/install.sh | sh -s -- --sandbox
  ```

To remove Novadeck, press **Uninstall…** under About in Preferences. It disconnects the
agents you connected, ends your terminals, and removes the app: on Linux the AppImage, its
`novadeck` command, menu entry and icon, and, through a password prompt, the sandbox profile
(if the prompt is not available it shows the command to run instead); on macOS it moves the
app to the Trash; on Windows it starts the uninstaller. Your projects and sessions stay unless
you untick **Keep my projects and sessions** (there is no such box when Novadeck runs with
its own `--user-data-dir`, whose folder it never deletes). A portable copy has nothing installed and shows
no such button, and a Homebrew install shows the `brew uninstall --cask novadeck` command to
run instead. On Linux and macOS the script does the same without the app, and leaves your data
and agent plugins alone, printing how to remove them:

```sh
curl -fsSL https://github.com/novadeck-org/novadeck/releases/latest/download/install.sh | sh -s -- --uninstall
```

An installed build keeps itself up to date; an unsigned macOS build only tells you when a
newer release is out until signing lands. An AppImage run from anywhere other than the
install path (`~/.local/share/novadeck/novadeck.AppImage`, or Homebrew's
`~/Applications/novadeck.AppImage`), a macOS app run from outside an Applications
folder, and the Windows ZIP (`novadeck-win-x64.zip`, unpacked anywhere), is portable: it only looks for new releases and offers to install Novadeck (from itself on Linux and macOS,
the latest setup on Windows; see [docs/auto-update.md](auto-update.md)). Those links point to the latest stable release; until
the first one is promoted, Novadeck's builds are prereleases on the
[Releases page](https://github.com/novadeck-org/novadeck/releases). See
[docs/auto-update.md](auto-update.md) for how updates work.

## Working in Novadeck

In Canvas, scroll to zoom in or out, and drag the background or an inactive terminal
to pan. Click a terminal to activate it, then select its text, scroll its output,
or drag its header to move it. Activating a terminal brings it in front of the
others; Canvas retains that stacking order until you leave the view.
Double-click or double-tap a terminal header outside its name to smoothly center and zoom that terminal
to fit the canvas viewport. Repeat the gesture on the same terminal to return to the
previous camera position and zoom. Manual pan or zoom (including keyboard shortcuts),
Fit all, sidebar camera navigation, leaving Canvas, or switching sessions clears that
return point. Flying to a different terminal starts a new visit from the current camera.
Repeated double gestures during a flight are ignored. Going to a terminal from outside the
canvas, as Show terminal on an Inbox item or a click on a desktop notification does, flies to it
the same way, from another session's camera too; it never flies back, so a terminal already
visited stays, and going on to another keeps the way back to where the visit began, which the
gesture on the header returns to. The header's maximize button opens Focus view; in Focus, its
minimize button opens Grid or Canvas.

Click **New terminal** or use its keyboard shortcut to create and select a terminal
immediately in any view, with or without Zen, ready to type in; F2 renames it. Focus
shows it right away. Grid uses
an available slot and scrolls it into view. Canvas chooses a nearby free position,
preferring the current viewport, and pans only as needed to reveal it without changing
zoom. Terminals can be moved or resized immediately; there is no placement step.
Right-click the Grid or Canvas background and choose **Terminal** to create one without entering
rename mode. In Canvas, its top-left corner is placed at that canvas point without moving the
camera. Terminals created with the New terminal control open in rename mode with their name
selected: in the sidebar when visible, or in the terminal header otherwise. Enter or clicking
away saves the name; Escape keeps the original name. In any
view, double-click or double-tap a terminal's name in its header to rename it
directly; in the sidebar, use the tab's Rename button or F2. The header and sidebar share rename mode and
the live draft. Move between either name field to continue editing; saving or
canceling ends the edit in both places.

Terminal tabs show the program in the foreground in small gray text beneath the
name, updating as programs start and finish; the line stays empty when it is unknown.
The runner reports each terminal's foreground process as its name and, on Linux, the
process group leader's command line (`argv`); macOS reports only the name (the one the
program was run by, not a versioned file a link points at, as Claude Code's `claude` is), and Windows
reports none. `frontend/core/src/terminals/process.ts` turns that into a program name,
resolving known Node CLIs from the script Node runs, so the Codex and Claude packages
show as `codex` and `claude` while other Node programs stay `node`. Where the process
cannot tell, as on Windows or for a Node CLI on macOS, a connected agent that reported
its session since the shell's last prompt names the program.

On Linux with systemd, each terminal's shell runs in a transient scope of its own (such
as `app-dev.mzpk.novadeck-term<pid>.scope`, named after the app's scope), which the
runner asks the user's service manager for right after the shell starts
(`libraries/terminal/src/pty/scopes.ts`). The app's own scope stops everything in it on
one OOM kill, so before this a program in any terminal that ran out of memory took the
whole app down. Now a kill inside a terminal's scope stays there. The scope's
`OOMPolicy=continue` keeps the shell when the kernel kills only the program, as outside
a scope; a terminal whose shell was killed for memory, as systemd-oomd kills the whole
scope, ends as "Killed · out of memory". What stays in the app's scope can still take it
down: the app's own processes, and anything a shell started in the few milliseconds
before its move. Without a user bus (no systemd, a container, WSL without systemd),
shells run in the app's scope as before. macOS and Windows are unchanged.

While a program holds the foreground, its profile decides how the terminal looks.
`frontend/ui/src/terminals/processes/profiles.ts` maps program names to a tab and
header icon and a body around the terminal's content; programs it does not list,
shells, and terminals starting or ended use Lucide's Terminal icon and no body. Every
terminal keeps the same `frontend/ui/src/terminals/WindowShell.tsx` window, so a
program starting or ending never replaces the header: a rename in progress, focus,
and the terminal switcher carry on. Claude and Codex have their own icons in
`frontend/toolkit/src/icons/` and their own bodies beside the profiles, where
their presentation can grow. To give another program its own look, add a profile
entry, with its own body if needed, and a launcher entry in `frontend/core/src/terminals/process.ts` if it
runs as a Node script. Profiles are presentation only: per-program behaviour goes beside
`programName` in `frontend/core/src/terminals/process.ts`, as `frontend/runner-adapter/src/terminals/resumable.ts` names the agents whose sessions resume.

A terminal running an agent (Claude Code, Codex or Antigravity) has a **Chat** button in
its window header wherever the backend reads the agents' transcripts
(`backend.conversations`). Chat shows the agent's own conversation as it records it,
read from its session's transcript rather than a second agent process: your messages,
its replies as formatted text, its tool calls (one line each, opening to their input and
result), other agents' messages to it, what waits on you, and whether it is working. Its
box types a prompt into the agent's real TUI the way you would (Enter sends, Shift+Enter
adds a line): the runner's `agents.prompt` pastes it, checks it landed in the agent's
box, then presses Enter. The words leave the box as they go, and come back to it, before
anything typed meanwhile, if they don't arrive. What you send while the agent works waits
in its queue, as when typed in its terminal; **Stop** presses Escape there, and gives what
waited back to the box. The TUI keeps running underneath
at its full size, so the Chat button, or **Answer in terminal** on a request card, shows
it again as it was. What waits on you (a permission, a plan to approve, the agent's
questions, a form an MCP server asks you to fill) shows as a card under the conversation
and is answered right there: pick an option, give your own words where the agent's
dialog takes them (a refusal with instructions, plan feedback, an answer of your own), or
fill the form's fields and accept or decline it. Novadeck answers by pressing the
dialog's keys in the agent's terminal, as you would, then checks that it took; each
agent's dialogs are read by its own adapter (`harnesses/<agent>/src/dialogs.ts`), which checks what it reads against what the agent asked and never guesses. When
it can't read a dialog, as after an agent update changed it, or an answer didn't take,
the card shows the dialog's text as the terminal draws it, with **Answer in terminal**. The choice and
the draft last until the agent ends; a reload starts in the terminal again. The
behaviour specs' demo (`?demo=agents`) has a conversation for each of its agents.

The backend port keeps windows out of the backend: a backend draws one terminal into an
element the UI gives it (`mountTerminal(element, key, props)`), and `app/MountedTerminal.tsx`
puts that element in the shared window and the profile's body, and draws what lies over it
(the lock, a failed paste's notice, the ending bar) from the mount's `state`. The UI keeps
the element for the terminal's life, so a program change swaps the body without restarting
the terminal; the UI moves the element into the new body, keeping output, selection and
focus. Switching between Focus, Grid and Canvas mounts a new one, which takes the same
xterm and attachment from `libraries/terminal/src/view/screens.ts` instead of opening and attaching
again. A terminal no view shows keeps them while its session is on screen, and for 30
minutes after its session leaves the screen, so going back to a session or project finds
its output in place; they go when that time passes or the terminal closes. Of the screens
no view shows, `screens.ts` keeps at most the 16 parked most recently, closing the one
parked longest first (a closed one resyncs from the runner's snapshot when shown again);
screens a view shows, Focus's kept windows among them, don't count. A Canvas node out of
sight keeps its mount but lets its screen go, so the screen parks after 5 s and
counts toward the cap, and the node's content is hidden until it is back in sight. Focus keeps
the last four terminals it displayed mounted, parked out of sight with `display:none`,
so switching back finds a terminal's companion pane as it was: a page still loaded, a
plan's editor, where each was scrolled. A component that docks status, opens over the
page or plays sound reads `useShown()` (`frontend/toolkit/src/shown.ts`), which Focus sets false
for a terminal it parks, and leaves that to what is on screen.

The runner owns every terminal: which terminals a session has, their names (the ones
you give them; else one an agent gave, or your first prompt to its agent, shortened;
else the program it was opened to run, or "Terminal"), directories, what
they run and the program each last had in its foreground (only its name, never its
command line, which can hold secrets). The UI shows them, renames through the runner,
and saves only how it shows them: layouts, sidebar order, the view and the selection,
by terminal id. A terminal has a `restoredProcess` only while it
has no live shell: a program running when the runner lost the shell, the shell was
killed, or the app closed becomes it, and it ends once a shell reaches its prompt or
runs a program. Every replacement shell starts in the runner backend's `freshShell`,
which resumes that program when it can (see [Restoring terminals](#restoring-terminals)).
Quitting or closing the desktop app's window saves before the runner ends its shells,
except on macOS, where closing the last window leaves them running, so the save reflects
that close rather than the final quit. A system shutdown or log-off saves the same way:
on Linux and macOS it quits the app, and on Windows the window saves as soon as the
session may end.

Shells start with the runner's environment. On macOS, where an app started from the Dock
or Finder gets no locale, a runner with none of `LANG`, `LC_ALL` and `LC_CTYPE` gives its
shells `LANG` for the system's language and country in UTF-8 (`AppleLocale`, its `@rg=`
region override left out), as Terminal.app does (`en_US.UTF-8` when the system has no such
locale), so typing a character such as "ż" works in bash.

In Canvas, resize a terminal by dragging its bottom-right corner. New terminals open at
864×576 until you resize one; from then on they open at the size you last gave a terminal,
in every project and session. In Grid, the terminal header's resize control alternates
between two widths: **Make full width** fills the available columns; **Restore width**
returns to the width at each breakpoint from before that click, preserving terminal height.
That choice is remembered per terminal and session. New Grid terminals start at compact
column width, with no placement preview.

In Grid, selecting a terminal from its tab smoothly scrolls it into view. With
reduced motion enabled, it scrolls immediately.
Double-clicking or double-tapping a Focus or Grid terminal header outside its
name has no effect; use the header action to move between those views.

A terminal tab's tooltip says who its name is from: you, the agent in another terminal
(`@fox`), your first prompt there, or the default. Right-click a tab for **Rename**,
**Close**, and, for a name you gave, **Reset to automatic**, which hands the name back
to Novadeck.

A terminal's sidebar tab ends its name's line in a small icon for each icon on its
taskbar, in the taskbar's order: its plan, images, files, pages and messages. What
you've seen is faint; something you haven't opened yet, and the messages while some wait
for the agent, is a step brighter with a small dot. A long name truncates before them,
so they line up down the list.

An agent that finishes the task it was given calls its `done` tool, a short report of
its own. That marks its terminal done for as long as the report stands, whether or not
you look at it, until you write to the agent or a message reaches it: a green "✓" before
its program on its tab and "Done · reported" in its tooltip, and on its window a solid
green line under the header (no glyph; red for an error). Only a `done` call makes a finish: a turn that ends
without one, or with only a question, marks no state. The tab stays idle and its program
name brightens ("Reply unread" in the tooltip) until you look. A turn that ended on an
error is marked the same way in red, "✗" on its tab and "Stopped with an error · reply
unread". Looking means that terminal is the selected one of the session on screen while Novadeck's window has focus
(on a narrow window, not while the Inbox list covers the screen). Starting another turn
clears the unread mark of a reply. The desktop app also shows one system notification for
a `done` report, "@moth is done: <its name>" with the report's subject, and one for a
failed turn, "@moth stopped with an error: <its name>"; clicking one brings Novadeck to
the front with that terminal selected, or opens its report in the Inbox. **Notify when an
agent finishes** in Preferences turns both notifications off; the marks stay. Marks
belong to the window that showed them: another window keeps its own, and a reload or a
restart forgets those of unread replies. The browser build (`pnpm dev:web`) shows no
notifications. The behaviour specs' demo (`?demo=agents`) finishes a prompt you give its
Claude Code in Build, with a `done` call.

When agents message each other (see [Agent messaging](agent-messaging.md)), a
terminal's tab says in its tooltip how many messages wait for its agent: queued, being
delivered or held, never those delivered, and whether a thread is held for your release
or messaging is paused. A terminal that has had messages gets a **Messages** icon in its
taskbar, with that count, which opens its
conversations in the companion pane: one per peer, each with its critter, and **You**
for its entries to you, first while one waits on you, then latest first. Opening one
reads it as a chat, the agent's text exactly as written, never formatted, saying where a
message is only while it's on its way or lost. A thread held for your release is answered
in the Inbox, not here. The pane's header has **Pause all agents' messages**, one switch
for every project and session. It pauses only messages between agents; your Inbox replies
still go through. It all updates as messages move. The content preview
(`pnpm dev:previews`) shows a conversation between its two agents; the behaviour specs'
demo (`?demo=messages`) has every state, entries to you and the pause.

Right-click a window's header for the same menu as its sidebar tab: Rename, Reset to
automatic for a name you gave, Dock in for an undocked window, and Close.

Use the eye on a terminal tab to hide it from Grid and Canvas without closing it.
Hidden tabs stay in the list with a faded label. While selected, a hidden terminal
appears at 50% opacity in Grid and Canvas, then disappears when it is no longer active.
Its hidden setting stays unchanged; use the eye to make it visible permanently.
Hidden terminals retain
their content and layout and remain available in Focus view.
Showing and hiding use a short fade and scale transition; reduced motion skips it.
Switching terminal tabs in Focus uses the same transition.

The project switcher in the top bar lists every project with what its agents show: the
most pressing of its terminals' marks, as their tabs have them ("?" or "!" while an
agent needs you, "✓" while a done report waits unseen, "✗" while a failed turn waits
unread, a spinner while one works). A dot on the switcher's button marks what another project has
waiting on you, in that mark's colour; projects only working don't light it. The list
grows to 560px before it scrolls.

Drag projects into any order, or move the focused one with Alt+Up and Alt+Down. Pin up to
nine with the pin beside a row's trash icon: pinned projects lead the list, and dragging
one across the rule below them pins or unpins it. While any are pinned, a bar under the
header shows them in that order, each as its number, its name and its mark (except the
spinner, so the bar stays still while agents work); the current one is underlined, and a
click switches to it. Drag a pin along the bar to reorder the pins, or focus one and
press Alt+Left or Alt+Right; drag one off the bar and let go to unpin it. Drag a project
out of the switcher and it becomes a pin, which you drag into place on the bar as you
would any pin; let it go off the bar, or press Esc, and nothing changes. The number is
its shortcut: `Ctrl+Shift+1` to `Ctrl+Shift+9` (`Cmd+1` to `Cmd+9` on macOS, in the
desktop app, since a browser keeps those for its tabs) switches to that pin, from
terminal input too. Shift keeps a bare `Ctrl+3` to `Ctrl+8` for the terminal, where they
send `Esc`, `Ctrl+\`, `Ctrl+^` and other control codes; `Ctrl+Shift+2`, a terminal's
`Ctrl+@`, is the pin's while there is a second, so use `Ctrl+Space` for that `NUL`.
Without a pin of that number the key reaches the terminal as usual, and it's left alone
while you rename a tab or type in another field. The bar slides in with the first pin and
out with the last, and Zen hides it. Pins that don't fit drop off its end, and the
switcher's dot covers them again. The order and the pins are kept by the runner, so they
survive clearing the browser's data; another client of the runner sees a change at its next
load, not as it happens. An arrangement an older version kept in this browser
(`novadeck.project-arrangement` in local storage) is sent to the runner at the next load
and then removed from storage.

The Inbox (the bell on the sidebar rail) lists everything
across every project and session that waits on you, each item its own row, of one of four
kinds: an Unblock ("!"), where the agent can't go on without you (a permission or plan
dialog, a message held for you to release, or an `ask` whose answer is an action only you
can do, such as a sign-in, access or a key); an Ask ("?"), a question from the harness or
sent through the agent's `ask` tool; Trouble, a failed turn, a usage limit or messages held
long; and an Update, an agent's `done` report or a `tell`. Click a
row to read it and answer in place, or reveal its terminal. An `ask` returns immediately so
the agent can keep working; your answer reaches that exact agent session later as a message. Its
ask clears when answered, withdrawn by the agent, or its session ends; an update clears when
marked read. Asks, tells, done reports and your replies remain in that terminal's Messages
pane, in the conversation **You**. A turn that ends without a `done` call or an ask makes no row; its tab
marks it (see above). A failed turn is a stored row that stays, across a reload and a runner
restart, until you read it (viewing its terminal reads it, or mark it read), and clears with
its terminal; it is trouble that counts only while it is the agent's latest end and the agent
isn't working, and an older one is a plain update with Mark read. A dialog or held messages
clear once answered or released, here or in the terminal. The bell, and Zen's dock, show a dot
toned by the most pressing item; how many wait on you is in its tooltip and the Inbox's
header. Updates, older failures and tells are not counted. A
usage limit is a state, not a stored row: it stays until the agent's next turn, so Continue is
there after the reset.

One rule decides when an item lands in the list: what concerns the terminal you are looking at
(the selected one, while Novadeck has your focus, in every view) doesn't land while you look,
since the agent is right there. If it is still unresolved when you look away it lands. Had you
looked at it for about a second, it lands quietly, counted on the bell but with no toast or
system ping, because you saw it where it happened; looked at for less, it lands and rings as any
item does. An update (a `done` report or a `tell`) is read once you have looked at its terminal
for about a second, whether it already landed or not; a glance while passing reads nothing, and
an update that arrived while you looked lands when you look away. This second applies to Inbox updates and quiet landings only: the tab's
unread marks of replies and failed turns clear as soon as you look. On a narrow window, while
the Inbox list covers the screen, no terminal counts as looked at, for either. Opening an item
by its id, as Answer in Messages or a click on a notification does, lands it at once, even while
its read is under way. If a read fails, the update lands so you can read it by hand. The tabs and windows read the Inbox's raw items,
so their "!" and "?" show at once, before the list lists them.

The rows that ask something of you keep the Inbox's own order (most pressing first, then the
longest waiting) until you drag one: they drag among each other into your order, or move a
place with Alt+↑/↓ on the focused row, while updates and settled asks stay below. Your order
is kept across a restart; a row that arrives later goes ahead of the rows you placed that are
as urgent as it or less, so one you put off stays below what comes after. Next, after an
answer, follows your order. With a card open, ← and → open the card before and after it (as j
and k do), not in a text field, and not on a list row, where → goes into the card.

To set one aside without answering it, snooze it: **S** on the row or in its open card, or the
bell-off button on the row or in the card's head. A snoozed row keeps its place and height,
with a gray wash, a dashed bar and a bell-off where its wait shows, and still drags with the
rest; Next, the arrows and j/k step past it, and the bell, its count, toasts and OS pings
leave it out. Snoozed from its card, the next card opens. S again, or the bell button, brings
it back, which rings nothing. A terminal whose every need is snoozed shows a gray bell-off for
its "!" or "?", the tab a gray wash and dashed bar and the window's head a wash, with no warning
line; a new prompt from it is marked at once. The project switcher's dot leaves snoozed needs
out. Snoozes are kept across a restart, each for the row it was made on: a message thread held
again later is a new row.

While Novadeck has your focus, a new item that needs you (an approval, a question, or trouble
that stopped an agent) shows as a toast over the header's right end after a 2 s grace. When
Novadeck is in the background, the OS ping rings instead, never both for one item. Up to three
stack, with the rest behind a "+N more" pill. A click opens the item in the Inbox, **×**
closes the toast, and it goes by itself after 8 s, unless the pointer rests on it. No toast
comes for the terminal you have selected or while the Inbox is open. While Preferences,
Search, the close confirmation, the crash-loop dialog or the terminal switcher you opened by
click is open, a new one waits and shows when it closes, if Novadeck still has your focus;
if you've left by then, the OS ping rings instead (where there are no desktop
notifications, as in the browser, it waits for you to come back). Toasts already showing
close when the Inbox opens, when you select their terminal or when one of those dialogs
opens; their items stay in the Inbox, as they do when you close or ignore a toast. A toast
also leaves once its item has been answered elsewhere, after the same grace. "Notify when an
agent needs you" in Preferences turns both off.

The project switcher removes a project from its row's trash icon, after
you confirm; its terminals close, and the folder on disk stays. The last project stays.
The runner forgets the project with its sessions, what its agents showed and the
windows undocked from them, and its agents' messages, so it stays gone after a reload. While the runner can't be reached, the app keeps asking until it
answers or the app quits; quitting waits briefly for it. A reload before the runner
answers leaves the project there, and it comes back.

## Restoring terminals

After a reboot, Novadeck opens each terminal where it was: in the directory its shell
was last in, with its earlier output shown above a fresh prompt, and with Claude Code,
Codex or Antigravity resumed in the session that was running once you connect that
agent.

- **Shell integration.** Each shell Novadeck starts loads your own startup files first,
  then reports its directory at every prompt: bash through `--init-file`, zsh through
  `ZDOTDIR`, fish through `--init-command`, PowerShell by dot-sourcing a script after
  your profile, and cmd through its `PROMPT`. Other shells start as they are. A new
  terminal and a restart open in the last reported directory. This comes from files in
  Novadeck's own data directory (a `shell` folder beside `workspace.sqlite`) and never
  touches your rc files.
- **Connecting agents.** The first-run welcome dialog includes an interactive preview
  of Focus, Grid, and Canvas, which shows each layout once until you pick one (never with
  reduced motion), plus a choice of agents, with every installed one chosen, and of
  transcripts, on. A chosen agent's preview terminal shows it connected.
  “Let’s build something” applies those choices; skipping, Escape, or clicking outside
  dismisses the dialog without connecting agents or changing transcripts. The preview is illustrative and
  starts no terminals. Preferences offers the same agents as immediate switches;
  an agent that is not installed cannot be selected. Connecting installs a small Novadeck plugin into
  it with the agent's own plugin commands (`claude plugin`, `codex plugin`,
  `agy plugin`, from a local marketplace or folder in Novadeck's data directory);
  turning it off uninstalls it. The plugin holds a single hook that tells the Novadeck
  terminal it runs in which session it is, and does nothing when the agent runs
  anywhere else. It adds nothing to the model's context but the messages other agents in
  Novadeck send it, wrapped as theirs (see [Agent messaging](agent-messaging.md)).
  Agents address each other by terminal handle: a word its session gives each terminal,
  never twice, such as `moth`, which Novadeck shows as `@moth` and which stays the
  terminal's when you rename it. A sidebar tab shows it beside Close where an agent runs
  or has run, or where an agent opened or leads the terminal; a window's header shows it
  in its switcher, under the pointer.
  An agent that opens terminals with a brief leads them, and a worker's window header says
  `led by @moth` while its lead runs. The sidebar shows every team without a word in the
  tabs: a dim wire on the border between the icon rail and the sidebar runs from the team's
  topmost tab to its bottommost, on into the list's edge where one is scrolled out of view,
  a block cursor on it marks the lead, and a tick reaches each worker's tab. Grid draws the
  same wires through its gutters, and Canvas between the windows. Selecting a member lights
  its team's wire: it grows in, the ticks reach out and the cursor blinks twice (on Canvas,
  only the cursor blinks). The team's other tabs take a faint tint of the accent and their
  handles light up, the lead's in a chip; the selected tab keeps its own look. A terminal
  that both works for a lead and leads shows the team it leads. The wire is only drawn:
  assistive technology hears the team in each member's tab description, whatever is selected, as
  a sentence after what else it says: "Led by @moth", "Leads @fox and @owl" (by handle,
  or by name where one has none; past four, the first three and how many more).
  Without a connected agent
  there is no resume, even for sessions it reported before: disconnecting forgets them,
  and the terminal comes back as a plain shell with its transcript.
- **Resuming.** When a terminal lost a connected agent, its fresh shell comes back
  with that session already running: the runner runs `claude --resume <id>`,
  `codex resume <id>` or `agy --conversation <id>` as the shell starts, after your rc
  files and prompt hooks, as if you had typed it at the first prompt, but nothing is
  typed and nothing goes into your shell history. When the agent exits you are at
  that shell's prompt. Typing before it starts, as while a slow rc file runs, cancels
  it, so the shell gets what you typed. A terminal without a known session gets a
  plain shell, never "continue the last session", a session resumes in one terminal
  only, never beside another running it, and a shell Novadeck cannot integrate shows
  its transcript instead. An rc file that replaces the shell, as with `exec fish` or
  `exec tmux`, resumes nothing. Terminals with an agent to resume start at once, in every session and
  hidden or not; the others start when their session is shown.
- **Transcripts.** Each terminal's recent output is kept, and a restored terminal shows
  it read-only above a separator and its fresh prompt (on Windows, scrolled up just above
  a fresh screen); a resumed agent shows its own history instead. Transcripts are on by default and can be turned off in Preferences,
  which also forgets the saved ones. A changed terminal's transcript is saved about every
  30 seconds, and when its shell exits or restarts. What looks like a secret (a known
  token prefix, a value named like a secret, a key, a long key-like run) is masked before
  the transcript is saved; anything else that was typed or printed may still be saved.
  The masked transcript is then encrypted with a key Novadeck keeps in your system's
  keychain (Keychain on macOS, DPAPI on Windows, and on Linux the Secret Service: GNOME
  Keyring, or KWallet where it offers the Secret Service).
  Where nothing protects that key (no keyring on Linux, an unlock you refuse or that fails,
  the standalone runner) no transcript is saved or shown, and any left unencrypted is
  forgotten at every start. Transcripts live in `workspace.sqlite`, readable by your
  account only, with up to 256 KiB kept per terminal; the key keeps the file alone from
  showing them, not other programs running as you on Windows or Linux.

Codex may ask you to review Novadeck's hooks ("Hooks need review") and records the
answer itself; it asks again when Novadeck changes how its hooks are registered, as when
they gained their time limit for agent messaging, and, from Codex 0.164.0, when any
file of Novadeck's plugin changes: switching between two Novadeck builds (an installed
app and a development build) asks each time, as each names its own launcher there.
Until you trust them (in Codex, `/hooks`), Novadeck's hooks don't run there, so
messages can't reach that session.
Interactive Codex normally runs its sessions, hooks included, in a shared background
server that cannot tell which terminal a session belongs to. So while Codex is
connected, Novadeck's shells run `codex` through a small shim that adds `--no-daemon`,
keeping the session in the terminal, and sets its terminal title's items to its state
and thread, which tells Novadeck when its prompt is up (Novadeck shows no terminal's own
title); `codex agents` and `--remote`, which need that server, go unchanged, and Codex
started by its full path bypasses the shim and does not resume. Sessions started this
way do not show in `codex agents`.
Antigravity runs the hook before each model call, and Codex with your first message,
so their sessions are known from then on; before that, Codex's title and Antigravity's
status line tell Novadeck that their prompt is up, so other agents' messages can wake
them. On Windows, Claude Code and Codex run the hook through PowerShell, Claude Code's
status line through Git Bash, as Claude Code runs every status line there, and
Antigravity through cmd, which can't run your own Antigravity status line after Novadeck's: there
Novadeck leaves yours as it is, and knows Antigravity's prompt is up only once you have
sent it something.

Uninstalling from Preferences disconnects the agents you connected first. Removing
Novadeck any other way (the script's `--uninstall`, a Homebrew uninstall, deleting the app)
does not remove plugins you left connected: switch agents off first, or remove the
`novadeck` plugin with the agent's own `plugin` command. A plugin left behind does nothing.

The runner saves each terminal's directory and agent sessions as they change, and its
output every few seconds and when the app quits, so a crash or a power cut loses little.
Once the runner starts shutting down it saves nothing more, so shells ending on the way
out cannot replace what it saved while they ran. On Windows, which doesn't tell which
program a terminal runs, the agent whose session the terminal reported is the one to
resume, until its shell has shown its prompt for a second: Windows ends the agents before
their shells as it shuts down, and an agent ended that way still resumes. The same second
keeps a worker led there: its lead ends only once its shell has outlived its agent for
that long, so a team comes back as a team after a reboot. A worker whose agent hadn't
started its first session yet, as one still at its trust screen, starts that agent again
with its task, still led.

## Zen mode

Choose **Enter Zen mode** in the top bar to hide the header, sidebar, rail, and footer
without leaving the current Focus, Grid, or Canvas view. The floating dock provides
New terminal, enabled view choices, and Exit Zen. It starts unfolded. Folded, it shows
New terminal and a small chevron, faint until the pointer or keyboard focus reaches it. Click or tap the chevron to toggle the remaining
controls, or activate it with Enter or Space. Clicking outside, leaving with keyboard focus,
or pressing Escape folds it.
Canvas navigation uses gestures and
keyboard shortcuts: +/− to zoom and 0 to fit all terminals.
Focus becomes an edge-to-edge terminal, while Grid and Canvas gain the available space.
In any view, click the terminal icon beside the name to open the terminal switcher.
Choose a terminal, or use Up/Down and Enter. Escape closes the switcher.
This also works outside Zen; double-click or double-tap the name still renames it.
Terminal names stay visible; header actions appear on hover or keyboard focus on desktop
and stay visible on touch devices. Search and terminal shortcuts remain available.

Zen preserves the active terminal and Canvas camera on entry. Exit Zen restores the
previous sidebar visibility and panel. Explicit sidebar shortcuts or Browse sessions
leave Zen to show the requested panel. Zen is temporary and resets on reload.

## Keyboard shortcuts

| Action                                            | macOS              | Windows and Linux                |
| ------------------------------------------------- | ------------------ | -------------------------------- |
| Find a terminal                                   | `Cmd+K`            | `Ctrl+Shift+K`                   |
| Recent terminals                                  | `Ctrl+Tab`         | `Ctrl+Tab`                       |
| Cycle backward through recent terminals           | `Ctrl+Shift+Tab`   | `Ctrl+Shift+Tab`                 |
| Toggle Focus and the previous Grid or Canvas view | `Cmd+Enter`        | `Ctrl+Shift+Enter`               |
| Toggle Zen                                        | `Cmd+Shift+Z`      | `Ctrl+Shift+Z`                   |
| Terminal in that direction, typing there          | `Cmd+Option+↑↓←→`  | `Ctrl+Shift+↑↓←→`                |
| New terminal                                      | `Cmd+T`            | `Ctrl+Shift+T`                   |
| New session in the current project                | `Cmd+Shift+N`      | `Ctrl+Shift+N`                   |
| Toggle terminal sidebar                           | `Cmd+Shift+E`      | `Ctrl+Shift+E`                   |
| Toggle session sidebar                            | `Cmd+Shift+S`      | `Ctrl+Shift+S`                   |
| Switch to pinned project 1 to 9                   | `Cmd+1` to `Cmd+9` | `Ctrl+Shift+1` to `Ctrl+Shift+9` |
| Open preferences                                  | `Cmd+,`            | `Ctrl+,`                         |
| Navigate the workspace                            | `Shift+Esc`        | `Shift+Esc`                      |

The keyboard's home is the selected terminal. A mouse click on the sidebar, a header or
the view switch leaves typing there, and the shortcuts above work from terminal input.
`Shift+Esc` leaves the terminal to navigate the workspace, in normal and Zen mode: a
ring marks the selected terminal, and outside Zen the footer says "Navigating". While
navigating:

| Key            | Action                                      |
| -------------- | ------------------------------------------- |
| `↑ ↓ ← →`      | Select the terminal in that direction       |
| `Shift+← / →`  | Previous / next view                        |
| `Enter`, `Esc` | Go back into the selected terminal¹         |
| `F2`           | Rename the active terminal                  |
| `Delete`       | Close the active terminal                   |
| `+` `−` `0`    | Zoom the Canvas in / out, fit all terminals |

¹ On Canvas, Esc first ends a visit to a terminal; an undocked window, which takes no
typing, keeps you navigating.

Typing a character, clicking, or moving focus anywhere but the view, as with Tab, also
ends navigating. Outside it, these keys do nothing on the workspace, so a key meant for
a terminal never acts on it; only the Canvas zoom keys also work whenever the Canvas
itself has focus, as after clicking its background.

Letters and other typed characters are never shortcuts: typed outside a terminal, they go into the selected terminal, which takes keyboard focus. With no
terminal selected they do nothing, and Space still presses the focused button. The Inbox is
the one exception, on its own list and open card: j and k move down and up it, and S snoozes.

Web addresses in a terminal, and the web hyperlinks programs print, open in your browser on
Ctrl-click (⌘-click on macOS); hovering one shows where it goes. A plain click still selects
text or reaches the program.

Pasting an image, such as a screenshot, into a terminal pastes the path of a file
holding it, as a native terminal does for a dropped file. A paste with any text stays
text, even with an image beside it, as cells copied from a spreadsheet come. On Windows,
as in Windows Terminal, Ctrl+V pastes as Ctrl+Shift+V does, and Ctrl+C copies the
selected text and clears the selection; with nothing selected, Ctrl+C reaches the
program. On Linux, Ctrl+V pastes a clipboard that holds an image and no text the same
way; with anything else on the clipboard, or one Novadeck can't read, it sends Ctrl+V to
the program as before, and what is typed meanwhile follows it, held for 2 seconds at most.
In a browser, Ctrl+V looks for an image only once the page may read the clipboard, as
after a first image pasted with Ctrl+Shift+V, so it never asks. On macOS ⌘V pastes and
Ctrl+V stays the program's. In the desktop app, a file or folder copied in a file
manager pastes its own path, whatever its size, so an agent edits the file itself; a
Windows name with anything but letters, digits, spaces and `.`, `_`, `-`, such as
`&`, `%` or the brackets of `Screenshot (1).png`, or with a space before a `-`, as in
`Report - Final.pdf`, goes as a copy instead. If a folder in your user path has characters like `&`, Novadeck puts quotes around a pasted upload's path so the shell reads it as one path; PowerShell can still split it when it passes the path to a `.cmd` program such as VS Code's `code`. On macOS that path may be in a folder the system protects, such as
Desktop, Documents or Downloads, so a program in the terminal may need macOS's
permission to read it, where a copy needed none. The runner saves a copy of anything else (a screenshot, an image from a
page, any file pasted in a browser) on its own machine, readable by its owner only, under a name of letters, digits and `.`, `_`, `-` or spaces, in an `uploads`
folder beside its database, or a temporary folder without one; each upload removes
those older than a week. Claude Code and Codex take a pasted
image's path as the image. The desktop app may read the clipboard for this; in a
browser, the first paste of an image asks for permission. A paste that fails, as of a
copy over 32 MB or with the clipboard unreadable, says why for a moment at the top of the
terminal; Ctrl+V says nothing of a clipboard it can't read.

The new-session shortcut creates and selects an empty session in the current project
and opens the Sessions sidebar.

Sidebar shortcuts open or switch to their panel; pressing the same shortcut again hides it.

Hold Ctrl while pressing Tab to choose a terminal, then release Ctrl to switch.
While navigating Grid and Canvas, the arrow keys select the nearest terminal on that
side as it appears on screen, keeping to the current row or column when anything is in
it, and stop at the edge. In Focus, where one terminal shows, every arrow steps through
sidebar order: Up and Left back, Down and Right forward, wrapping at either end. With a
terminal tab in the sidebar focused, Up and Down follow the list, navigating or not.
Selection pans Canvas or scrolls Grid just like clicking a tab.
From terminal input, Cmd+Option+arrow (Ctrl+Shift+arrow on Windows and Linux) moves the
same way without leaving the terminal and keeps typing in the one it reaches; at an
edge it does nothing, and the keys never reach the program.
Shift+Left and Shift+Right cycle through enabled views in Focus → Grid → Canvas order,
wrapping at either end and retaining the selected terminal; so do Left and Right on the
view switch.
Escape while navigating first returns a Canvas visit to where it began; otherwise it
goes back into the terminal. Terminal input, editors, and dialogs retain Escape.
Text inputs and open dialogs retain their own arrow behavior. Arrow keys no longer
pan the canvas camera. While the recent switcher is open, Up and Down cycle its list.
The new-terminal shortcut creates a terminal immediately and opens the desktop Terminals sidebar
when outside Zen. On narrow screens the sidebar stays closed so the new terminal is visible. The new terminal's input receives focus. These shortcuts are available in the desktop app; browsers may
reserve `Ctrl+Tab` for changing browser tabs. The Shortcuts tab in Preferences
groups bindings into Navigating and Anywhere for the current platform. On the Canvas
background, `+`/`−` zoom and `0` fits all terminals.
