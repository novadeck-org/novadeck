# Novadeck

A desktop terminal workspace for organizing projects, sessions, and parallel work.

Focus on one terminal, arrange several in a grid, or spread them across a zoomable
canvas. Keep related work together and switch between sessions from the sidebar.

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
the latest setup on Windows; see [docs/auto-update.md](docs/auto-update.md)). Those links point to the latest stable release; until
the first one is promoted, Novadeck's builds are prereleases on the
[Releases page](https://github.com/novadeck-org/novadeck/releases). See
[docs/auto-update.md](docs/auto-update.md) for how updates work.

In Canvas, scroll to zoom in or out, and drag the background or an inactive terminal
to pan. Click a terminal to activate it, then select its text, scroll its output,
or drag its header to move it. Activating a terminal brings it in front of the
others; Canvas retains that stacking order until you leave the view.
Double-click or double-tap a terminal header outside its name to smoothly center and zoom that terminal
to fit the canvas viewport. Repeat the gesture on the same terminal to return to the
previous camera position and zoom. Manual pan or zoom (including keyboard shortcuts),
Fit all, sidebar camera navigation, leaving Canvas, or switching sessions clears that
return point. Flying to a different terminal starts a new visit from the current camera.
Repeated double gestures during a flight are ignored. The header's arrow opens Focus view.

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
reports none. `frontend/core/src/process.ts` turns that into a program name,
resolving known Node CLIs from the script Node runs, so the Codex and Claude packages
show as `codex` and `claude` while other Node programs stay `node`. Where the process
cannot tell, as on Windows or for a Node CLI on macOS, a connected agent that reported
its session since the shell's last prompt names the program.

While a program holds the foreground, its profile decides how the terminal looks.
`frontend/ui/src/terminals/processes/profiles.ts` maps program names to a tab and
header icon and a body around the terminal's content; programs it does not list,
shells, and terminals starting or ended use Lucide's Terminal icon and no body. Every
terminal keeps the same `frontend/ui/src/terminals/WindowShell.tsx` window, so a
program starting or ending never replaces the header: a rename in progress, focus,
and the terminal switcher carry on. Claude and Codex have their own icons in
`frontend/ui/src/ui-toolkit/icons/` and their own bodies beside the profiles, where
their presentation can grow. To give another program its own look, add a profile
entry, with its own body if needed, and a launcher entry in `frontend/core/src/process.ts` if it
runs as a Node script. Profiles are presentation only: per-program behaviour goes beside
`programName` in `frontend/core/src/process.ts`, as `frontend/runner-adapter/src/resumable.ts` names the agents whose sessions resume.

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
page or plays sound reads `useShown()` (`ui-toolkit/shown.ts`), which Focus sets false
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

Use the terminal header's resize control to alternate between two sizes. In Canvas,
**Enlarge** matches the current Canvas viewport aspect ratio at a fixed area equivalent
to 1200×800, independent of zoom. **Compact** sets 600×400. Extreme ratios respect the
minimum terminal dimensions. Double-click the enlarged terminal header to fill more
of the viewport. Canvas grows or shrinks around the terminal's center
without changing the camera. In Grid, **Make full width** fills the available columns;
**Restore width** returns to the width at each breakpoint from before that click,
preserving terminal height.
Preset choices are remembered per terminal, session, and view. New terminals start
compact: 600×400 in Canvas and compact column width in Grid, with no placement preview.

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

When an agent finishes (its turn over, no subagent it started still running, nothing
waiting on you, and not stopped by your Escape) while you look at another terminal, or
at another window altogether, its terminal is marked done until you look: a small green
"●" and "done · unread" on its tab, its name in bold, and on its window a solid green
line under the header beside a "Done · reply unread" chip ("Done" on a compact one). A
command it left running, such as a dev server, doesn't hold that back. The mark clears
once that terminal is the selected one of the session on screen while Novadeck's window
has focus, or once its agent starts another turn. A completed turn is marked, and
announced, about 0.7 s after it ends, in case its harness then says your Escape stopped
it. The desktop app also shows one system
notification for each such finish, "@moth is done: <its name>", with the start of the
agent's last reply (Claude Code's and Codex's Stop hooks name it; Antigravity's
transcript records it); clicking it brings Novadeck to the front with that terminal
selected. **Notify when an agent finishes** in Preferences turns the notification off;
the mark stays. A turn that ended on an error is marked the same way in red, "error ·
unread" and "Stopped with an error · reply unread", and its notification says "@moth stopped
with an error: <its name>". Marks belong to the window that showed them: another window
keeps its own, and a reload or a restart forgets them. The browser build (`pnpm dev:web`)
shows no notifications. The behaviour
specs' demo (`?demo=agents`) finishes a prompt you give its Claude Code in Build.

When agents message each other (see [Agent messaging](docs/agent-messaging.md)), a
terminal's tab says in its tooltip how many messages wait for its agent: queued, being
delivered or held, never those delivered, and whether a thread is held for your release
or messaging is paused. A terminal that has had messages gets a **Messages** icon in its
taskbar, with that count, which opens its
threads in the companion pane: one per peer, latest first, each message with its
direction, time, state and the agent's text exactly as written, never formatted. A held
thread has **Release**, and the pane's header has **Pause all agents' messages**, one
switch for every project and session. It pauses only messages between agents; your Inbox
replies still go through. It all updates as messages move. The content preview
(`pnpm dev:previews`) shows a thread between its two agents; the behaviour specs' demo
(`?demo=messages`) has every state, a held thread and the pause.

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
agent waits on you, "✓" or "✗" while a finished agent's reply waits unread, a spinner
while one works). A dot on the switcher's button marks what another project has
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
switcher's dot covers them again. The order and the pins are kept in this browser or app
(`novadeck.project-arrangement` in local storage), not shared with other clients of the
runner.

The Inbox (the bell on the sidebar rail, on by default on the runner) lists everything
across every project and session that waits on you, one row per agent terminal: a dialog to
answer, a message between agents held for you to release, a turn that failed, a usage
limit, a question sent through the agent's `ask` tool, an update sent through `tell`,
and a turn that finished while you looked elsewhere. Click a row to read it and
answer in place, or reveal its terminal. An `ask` returns immediately so the agent can
keep working; your answer reaches that exact agent session later as mail. Its ask clears
when answered, withdrawn by the agent, or its session ends; a `tell` clears when marked
read. Ask, Tell and Your reply remain in that terminal's Messages pane under **You**.
Other rows clear once answered, once you view the terminal, or when the agent starts working again. A count badge on the bell, and on
Zen's dock, tells how many wait on you; finishes and tells are not counted. A usage limit stays until
the agent's next turn, so Continue is there after the reset. Where a backend has no Inbox,
the bell opens the Notifications panel, which lists the questions, permissions and plans
to review and the agents that finished while you looked elsewhere. With Murmur on, a
waiting question or plan shows a headline under its row, such as "Asks which database to
use", and a finish you haven't seen shows a short gist of its reply in place of the
reply's start, marked when the reply asks you something; the tooltip and the screen
reader's description keep the reply itself. Without Murmur every row reads as it always did.

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
  Novadeck send it, wrapped as theirs (see [Agent messaging](docs/agent-messaging.md)).
  Agents address each other by terminal handle: a word its session gives each terminal,
  never twice, such as `moth`, which Novadeck shows as `@moth` and which stays the
  terminal's when you rename it. A sidebar tab shows it beside Close where an agent runs
  or has run, or where an agent opened or leads the terminal; a window's header shows it
  in its switcher, under the pointer.
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
  it read-only above a separator and its fresh prompt; a resumed agent shows its own
  history instead. Transcripts are on by default and can be turned off in Preferences,
  which also forgets the saved ones. They can contain secrets that were typed or
  printed: they live in `workspace.sqlite`, readable by your account only, with up to
  256 KiB kept per terminal.

Codex may ask you to review Novadeck's hook ("Hooks need review") and records the
answer itself; it asks again only when Novadeck changes how its hook is registered, as
when the hook gained its time limit for agent messaging.
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
them. On Windows, Claude Code and Codex run the hook through PowerShell and Antigravity
through cmd, which can't run your own Antigravity status line after Novadeck's: there
Novadeck leaves yours as it is, and knows Antigravity's prompt is up only once you have
sent it something.

Uninstalling from Preferences disconnects the agents you connected first. Removing
Novadeck any other way (the script's `--uninstall`, a Homebrew uninstall, deleting the app)
does not remove plugins you left connected: switch agents off first, or remove the
`novadeck` plugin with the agent's own `plugin` command. A plugin left behind does nothing.

The runner saves each terminal's directory and agent sessions as they change, and its
output every few seconds and when the app quits, so a crash or a power cut loses little.
Once the runner starts shutting down it saves nothing more, so shells ending on the way
out cannot replace what it saved while they ran.

## Zen mode

Choose **Enter Zen mode** in the top bar to hide the header, sidebar, rail, and footer
without leaving the current Focus, Grid, or Canvas view. The floating dock provides
New terminal, enabled view choices, and Exit Zen. At rest it folds to New terminal and a
small chevron. Click or tap the chevron to toggle the remaining controls, or activate
it with Enter or Space. Clicking outside, leaving with keyboard focus, or pressing Escape folds it again.
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
terminal selected they do nothing, and Space still presses the focused button.

Web addresses in a terminal, and the web hyperlinks programs print, open in your browser on
Ctrl-click (⌘-click on macOS); hovering one shows where it goes. A plain click still selects
text or reaches the program.

Pasting an image, such as a screenshot, into a terminal pastes the path of a file
holding it, as a native terminal does for a dropped file. A paste with any text stays
text, even with an image beside it, as cells copied from a spreadsheet come. On Linux
and Windows, Ctrl+V pastes a clipboard that holds an image and no text the same way;
with anything else on the clipboard, or one Novadeck can't read, it sends Ctrl+V to the
program as before, and what is typed meanwhile follows it, held for 2 seconds at most.
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

## Development

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
and hands the same token to the UI dev server. A browser has no desktop host, so it shows
no notification when an agent finishes; its terminals are still marked done. For UI-only work, use
`pnpm --filter @novadeck/host exec vite --host 127.0.0.1 --mode web` with `VITE_NOVADECK_RUNNER_URL` and
`VITE_NOVADECK_RUNNER_TOKEN` pointing at a runner you started; the web entry reads
`.env.web` (in `frontend/ui/`) rather than `.env.development`.

Novadeck has no database migrations before its first release. A runner that opens a
`workspace.sqlite` an earlier build wrote, whose tables or schema version differ from its
own, sets it aside as `workspace.sqlite.earlier-<time>` (with its `-wal` and `-shm`) and
starts a new one, so your projects, sessions and kept terminals start over; the old file
stays for you to delete. A standalone runner keeps it at
`~/.local/share/novadeck/workspace.sqlite` unless `NOVADECK_DATABASE` is set; the
desktop app keeps it in its data folder, `novadeck` on every platform:
`~/.config/novadeck/workspace.sqlite` on Linux, `~/Library/Application
Support/novadeck/workspace.sqlite` on macOS and `%APPDATA%\novadeck\workspace.sqlite` on
Windows (`novadeck-dev` in place of `novadeck` for `pnpm dev`). Novadeck never
deletes or rewrites it for you.

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
  right, with a draggable divider; a narrow window stacks them.
- **Canvas** attaches the plan as a sheet beside the node, which pans and zooms
  with it; the canvas frames both as it opens.

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
moves through it. Each gets an icon in the taskbar, as an OS taskbar has, with
several of a kind (images, files, pages, or plans) stacked under one; only Messages
never stack. A markdown file the agent shows reads as a document, formatted like a plan
with its outline, but read-only: it's the agent's file, not a plan to edit or note (the
demo's Codex has shown `docs/brand-voice.md`). The mark under an icon says whether it's
new, showing, or seen: something new gets a dot, quietly, and nothing opens on its own
unless you asked for it. Hover an icon to peek: a card per thing behind it, each a
preview, its name and the same mark, with no copy. Once you've peeked, what was new is
seen, without opening it. Click an icon or a card to open it, click the icon
again (or press Escape) to hide the pane, and close from a card's corner button or the
icon's right-click. Closing a plan or Messages on its own terminal's bar hides it: the
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
`companions` capability (`frontend/core/src/companion.ts`): its content as it changes, and a save
that writes the user's edits and notes into the plan file unless it changed since, in
which case the pane merges and saves again. Edits save once typing pauses and when focus
leaves the plan. The runner reads content from disk and can't write plans yet, so its
plans are read-only; the content-preview demo writes them, with sample agents in
`frontend/demo/src/showcase/` that revise their plans over the file as the user left it and
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
demo with hardcoded Inbox items, which no other variant has) or `welcome`. The
switcher in the panel's header changes between them without reloading (pressing the
current one boots it again), and the browser
tab remembers the last one chosen. `&turnMs=` sets how long a demo agent's turn works
(1500 ms unless given), as a spec does that must act on the screen before the turn ends.

The search field at the top filters actions by label, hint and group. Groups start folded,
under three sections (Terminals, Agents, App), and the panel remembers which you opened in
this tab. A ↺ beside an action marks one that boots the demo again.

Terminals:

- **Selected terminal:** put the selected terminal in each of its states: starting, loading
  output, back at the prompt, running a long program, Claude Code or Codex, a failed
  paste, and each way to end (clean exit, exit code, killed, failed to start). Each one
  that changes the state calls off what the terminal's agent had pending, so a finish
  due later doesn't bring the agent back.
- **New terminals:** "Every state at once" adds one terminal per state, named after it, so
  the tabs and the windows in Grid and Canvas show attention, done, error, ended and the
  rest side by side; you stay on one that needs permission, and the done marks land on
  the others. Its shell an agent opened and its shell an agent exited from keep their
  handles on their tabs; its other plain shells show none. Also a burst of 30, a quick
  failure, a spawn failure and the terminal limit.
- **Projects and sessions:** mark the selected terminal running, then start a fresh
  session, to see the sessions panel count it; or make the next folder pick fail.

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
  notification. Completes, Fails, Interrupted and Ends without reply work for 3 s, then end
  the turn the way asked: with its reply, a short one for Interrupted (no unread mark), none
  for Ends without reply. Background work (2 tasks counted) and Background, uncounted end the
  turn and leave work running; Finishing subagents keeps the agent working until its 2
  subagents finish. Rest leaves it at its prompt with everything answered and read.
- **Agent fixtures:** what no turn produces: an unheard agent (Claude Code whose hooks say
  nothing), and context and limits or tokens alone, in the tooltip and status; those two set
  only the usage of the selected terminal's agent, so a turn, request or queued prompt stays.
- **Notifications:** "Fill notifications" has up to 12 terminals across
  the projects ask for you (questions, permissions, plans), and after 3 s finish done or
  failed, so the Notifications panel lists every kind and the rail badge reads 9+. It
  adds terminals to the current session if the workspace has too few, without selecting
  them or leaving the Notifications panel, and leaves the selected terminal alone, since
  a finish only counts while you look elsewhere. "Clear notifications" rests every agent,
  which answers every request, reads every finish and calls off those still to come, and
  has a terminal back at its prompt work for a moment and leave, for the empty panel. Its
  second round of kinds carries what Murmur would write (a headline on the question and the
  plan, a gist on the done and the failed finish, the done one asking), so the rows can be
  seen without Murmur installed. The notices for finishes need the Preferences switch
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
- **Agent connections:** make the next connect in Preferences fail, refresh the agents, or
  connect Antigravity with the note Preferences shows where its own status line keeps
  Novadeck's out, as on Windows.

App:

- **Inbox:** the actions show up in the `inbox` variant, whose Inbox holds hardcoded items. Each action adds one item of its kind to the Inbox,
  waiting from now and in place of the one of its kind already there: a stuck agent, Codex's
  command permission, an unreadable dialog, a held message, a decision with options, a
  detected question, an ask while its agent keeps working, a login request, the 5-hour limit, a usage limit Novadeck can't resume (no switch), a request whose dialog never read, a
  failed turn with no error, a held message whose sender is gone, a plan approval
  (its bypass-permissions yes a quiet link), a failed turn, a free-text ask, a permission
  whose Deny is a plain no, a heads-up and a finished turn. "Fail the next answer" makes
  the next answer to any item fail, so its sheet shows why and keeps the item and draft for retry. Ask, Tell and Your reply
  also appear in the terminal's Messages pane under You; replies show queued and delivered states.
  "Stale next answer" makes the next answer report that the ask is no longer available,
  keeping the draft. "Ask withdrawn" and "Ask session ended" remove the sample preview ask
  and keep its outcome in Messages. "Next reply not delivered" queues the next reply, then
  shows the delivery failure in its Inbox confirmation and Messages history. Reply boxes
  hint at about 4,000 characters, fewer with emoji or some languages, and stop at 4,096. Pausing messages between agents leaves
  your replies going through. "Usage limit, reset passed" adds the limit Novadeck can't resume, with its
  window reset, offering Continue now. "Command hiding lines" adds a permission whose command
  buries a line under blank lines and spaces; its card counts the lines and marks what draws
  as nothing. "A new item arrives" adds the next kind not there
  yet, and "Clear the Inbox" empties it.
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
- **Runner:** show Reconnecting for 5 s, then Reconnected; go offline until you toggle it
  back; or count four crashes, which shows the footer and the dialog and fails the selected
  terminal's session's terminals (Try again clears the count and restarts them).
- **Sandbox:** boot as a host running without Electron's sandbox, for the footer's No
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
  it takes effect after a restart, fades after a few seconds and leaves Installed on the chip;
  Novadeck never restarts itself. "Install never finishes" holds the Installing card and the
  chip's Installing…. "Newer install exists" and "Install fails" arm the other ends: a card
  saying a newer Novadeck is already installed, or one giving the reason with Try again.
  "Already installed" is a window opened again after installing: no card, the chip reads
  Installed. "Slow host" makes the host take four seconds to say it is portable, to check
  the No sandbox chip does not flash meanwhile. "Installed copy" boots as one. With "No
  sandbox" set under Sandbox, the No sandbox chip stays away on a portable and the card adds
  a line about it. For specs, `?portable=` opens any of these by key (`no-release`, `update`,
  `never`, `newer`, `failed`, `installed`, `slow-host`, `installed-copy`); `&installMs=` sets
  how long an install takes (none by default), and `&update=` adds an update scenario.
- **Uninstall:** boot as a host that offers the About row's Uninstall…, and end the run as
  armed. "Not offered" has no row (a portable copy, or no host); "Homebrew copy" shows the
  brew command with Copy and no button; "Ready, no data folder" has no Keep my projects checkbox, as when the app runs with its own data folder; "Removed" goes through Removing… to Novadeck is
  uninstalled with Quit, and "Removed, leftover" adds the command to copy (the Linux sandbox
  profile when no password prompt was available); "Removal fails" keeps the dialog open with
  the reason; "Fails after terminals ended" ends on a reason telling you to quit and open Novadeck
  again, which every retry repeats, and "Trash refused" fails once on macOS' App Management and
  then succeeds; "Windows uninstaller" reads Continue and ends on Novadeck closing for its
  uninstaller, and "Windows uninstaller fails" ends on the reason. Connect agents in
  Preferences first to see them named in the dialog; Agents' "Fail next" makes a disconnect
  fail before the run. `?uninstall=` opens `unavailable`, `manual`, `removed`, `leftover`,
  `failed`, `stopped`, `trash`, `windows`, `windows-failed` or `no-data` for specs.
- **Updates:** Download counts the floating progress bar above the footer's right end up in
  steps, shows it ready for a few seconds, then fades it; Download, held stops it at 40% to
  look at. Download failed holds the bar at 40% for a moment, or fails one already running, and
  drops it with nothing in the footer, as the host tries again by itself (`retrying`). Release
  to fetch shows the Update available chip alone, which opens the release page (nothing opens
  in a browser). Ready at
  launch offers an update downloaded before this run, which shows nothing, as at a launch.
  Finish restart reloads the demo, as the app comes back on the new version. Early builds on
  and off set the channel Preferences' Updates switch shows once Preferences is reopened.
  For specs, `?update=` opens any of these by key (`download`, `held`, `failed`, `available`,
  `ready`). Both panels and the spec keys come from one record, `frontend/demo-debug/src/scenarios.ts`.

### Visitor build

A clickable, public version of the demo, for a website. `pnpm dev:try` serves its entry
(`apps/try/`) in vite mode `try` (http://127.0.0.1:5190); `pnpm build:try` writes static files to
`apps/try/dist` (the desktop app's own `apps/desktop/dist/` is what it packages), with relative
paths and a hash router, so any static host serves them from any path, and
`pnpm preview:try` serves them on http://127.0.0.1:5191. The [Try
workflow](.github/workflows/try.yml) deploys a release's build to Cloudflare Pages at
https://try.novadeck.dev, beside the website, so the demo always shows a published
version. Until launch, Release runs it for each version it publishes, prereleases
included; at launch it moves to Promote to Stable, so the demo shows what Download gives
people. Run workflow deploys a tag by hand. Quality builds it on every pull request. The
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
every woff2 font they declare, 1,100 kB, and the demo with its terminal emulator, which
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
ships or deploys: the desktop host, the visitor build and the content preview; `frontend/`
the UI, split into packages (the model, the two backend adapters, the terminal views, the
specs and the test kit); `backend/` the runner and the relay; `contract/` the protocol and
the runner client; `engines/` holds the native inference engines Novadeck downloads once
installed, and the build they share; `harnesses/` holds the agent harness adapters and the
contract they share; `libraries/` holds the mechanics that never import app code (see
[libraries/README.md](libraries/README.md)); `tools/` holds the apps' build helpers and the
atlas.

| Package                   | Responsibility                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `frontend/ui`             | React frontend built with Vite, Tailwind CSS, and Lucide icons.                        |
| `frontend/core`           | The UI's model: types, reducer, stores, and the port to a backend.                     |
| `frontend/runner-adapter` | The UI's backend for a runner, over a WebSocket or the desktop host.                   |
| `frontend/terminal-views` | The xterm mount both backends draw terminals with.                                     |
| `frontend/demo`           | The demo backend: a scripted workspace and simulated terminals.                        |
| `frontend/demo-debug`     | The demo's debug panel and rehearsals.                                                 |
| `frontend/test-kit`       | What the UI's tests render and drive the app with.                                     |
| `frontend/specs`          | Behaviour specs: the whole app in a real browser, over the demo.                       |
| `apps/desktop`            | Electron host that starts the runner and loads the packaged UI.                        |
| `apps/try`                | The visitor build of the demo, which the website embeds.                               |
| `apps/previews`           | The content preview: the demo with its debug panel.                                    |
| `backend/runner`          | The runner: shells and metadata, served over WebSocket or port.                        |
| `backend/relay`           | Rust relay for agents' Novadeck MCP server and hooks.                                  |
| `contract/protocol`       | Shared Zod contracts the runner and its clients agree on.                              |
| `contract/runner-client`  | The `connectRunner` client UIs reach a runner with.                                    |
| `engines/whisper`         | Voice engine: whisper.cpp built for download (`build:engine`).                         |
| `engines/murmur`          | Murmur engine: llama.cpp built for download (`build:engine`).                          |
| `engines/ggml-build`      | The engine build both of those share.                                                  |
| `harnesses/core`          | The harness adapters' contract and the helpers they share.                             |
| `harnesses/claude`        | The Claude Code adapter: hooks, transcripts, dialogs, input box.                       |
| `harnesses/codex`         | The Codex adapter, same shape.                                                         |
| `harnesses/agy`           | The Antigravity adapter, same shape.                                                   |
| `libraries/emulator`      | The terminal emulator: xterm.js pinned and patched, the character-width rule, helpers. |
| `libraries/terminal`      | Hosting terminals: a pty, a headless screen, a resumable stream, the browser view.     |
| `libraries/tui-input`     | Typing into a full-screen program and checking that the text landed.                   |
| `libraries/viewers`       | Content viewers behind one contract: code, image, markdown and web pages.              |
| `libraries/wire`          | RPC calls and streams between processes over a WebSocket or a MessagePort.             |
| `libraries/sandbox`       | An isolated environment for tests and benchmarks that run real shells and programs.    |
| `tools/build-kit`         | The apps' Vite helpers: CSP sources, hosting headers, noindex, fonts, bundle checks.   |
| `tools/atlas`             | Dev-only code map: `pnpm atlas`; agent briefs: `pnpm -s atlas:brief`.                  |
| `scripts`                 | Repository checks and automation.                                                      |

Build an engine locally with `pnpm --filter @novadeck/whisper build:engine` or
`pnpm --filter @novadeck/murmur build:engine`; the archive and `engine.json` land in
the package's `dist/`.

The UI runs real shells through the runner. Projects, sessions and their terminals
live in the runner's SQLite metadata, and each session saves its terminals' order and
layouts there too; preferences (the light, dark or system mode among
them) and sidebar settings are stored locally. Unit tests
and behaviour specs run on the demo adapter's sample data instead.

See the [terminal backend plan](docs/backend-plan.md) for the proposed runner
architecture and typed API.

The standalone backend now supports authenticated, real terminal processes and
persistent project/session metadata. The Electron host runs it in a utility process,
but the interface above is **not connected yet** and still uses mock data. See the
[backend API guide](docs/backend-api.md) for configuration, client examples, and
backend-only tests.

### Working on the UI

The UI is split into packages: `frontend/core`, `frontend/ui`, `frontend/runner-adapter`,
`frontend/terminal-views`, `frontend/demo`, `frontend/demo-debug`, `frontend/test-kit` and
`frontend/specs`, and the apps `apps/desktop`, `apps/try` and `apps/previews`. `frontend/ui`
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
| `frontend/demo/src/`                                            | The demo adapter for the website, tests and specs: sample projects and simulated terminals.                                    |
| `frontend/demo/src/showcase/`                                   | The content preview's sample agents: plans, artifacts, and their simulated work.                                               |
| `frontend/runner-adapter/src/`                                  | The runner adapter: connection, seed from the runner, saves, and its terminals.                                                |
| `frontend/terminal-views/src/`                                  | The xterm mount both adapters draw terminals with: theme, renderers, links, styles.                                            |
| `frontend/core/src/`                                            | Pure domain: types, reducer, store, seed, layout rules in `layout/`, the backend port.                                         |
| `frontend/core/src/companion.ts`                                | Companion items, their content, the `companions` port, and the plan note format.                                               |
| `frontend/core/src/companion-bar.ts`                            | A bar as the person arranged it: order, hidden plans and Messages, the open tab.                                               |
| `frontend/core/src/messages.ts`                                 | The contract for agents' messages: threads, states, the pause, and a tab's count.                                              |
| `frontend/core/src/conversation.ts`                             | The contract for an agent's conversation: transcript items, requests, the port.                                                |
| `frontend/core/src/inbox.ts`                                    | The contract for the Inbox: items by source, their type and urgency, answers, the port.                                        |
| `frontend/core/src/conversation-turns.ts`                       | A conversation grouped into blocks, tool calls summed up in a line, the turn's status.                                         |
| `frontend/core/src/roster.ts`                                   | A session's terminals and undocked windows, laid out as tiles, their order and status.                                         |
| `frontend/core/src/layout/workspace-layout.ts`                  | Where each terminal sits and how big it is in each view.                                                                       |
| `terminals/`                                                    | Terminal frame, tabs, rename state, and the recent-terminal switcher.                                                          |
| `terminals/companion/`                                          | Taskbar and pane: the panes' store, `bar.ts` rules, viewers, `plan-editor/` (notes).                                           |
| `terminals/drag-session.ts`                                     | What's dragged off a taskbar, the views' drop spaces, and the windows it's over.                                               |
| `terminals/chat/`                                               | The agent's chat: its blocks, markdown reader, tool rows, requests and the composer.                                           |
| `layouts/canvas/`, `grid/`, `focus/`                            | View adapters and colocated library styles.                                                                                    |
| `layouts/` (top level)                                          | Helpers shared by views: view transitions, background gestures, visibility.                                                    |
| `notifications/`                                                | The notification center: what asks for the person across the workspace, and its panel.                                         |
| `inbox/`                                                        | The Inbox: what agents ask of the person, its sidebar rows and the sheet that answers.                                         |
| `shell/`                                                        | Header, rail, panels, zen dock, sidebar, and shell state transitions.                                                          |
| `sidebar/`, `projects/`, `preferences/`, `search/`              | Feature components.                                                                                                            |
| `interaction/`                                                  | Shortcut records, the keymap, and shared DOM focus/overlay contracts.                                                          |
| `ui-toolkit/`                                                   | Reusable controls, direct Ark UI imports, and the shared recipes they draw with.                                               |
| `test/`                                                         | The command harness: the real stores, navigator and commands, for tests.                                                       |
| `frontend/test-kit/src/`                                        | A jsdom render helper, the port contract suite, and test phase timing.                                                         |
| `assets/`                                                       | Static files referenced from CSS.                                                                                              |
| `theme/`                                                        | Tailwind's layout-only theme, token defaults, Graphite and Phosphor, `apply.ts`.                                               |
| `styles.css`                                                    | The cascade order, every recipe, theme and vendor sheet in its layer, Tailwind sources.                                        |
| `frontend/specs/src/`                                           | Behaviour specs for the whole UI, and the spec backend over the demo.                                                          |
| `entries/start.tsx`                                             | How every app starts: applies the theme, renders the app it is given.                                                          |
| `apps/try/src/`, `apps/previews/src/`, `apps/desktop/renderer/` | Each app's pages and entry: it picks its backend and renders `App` with `start`. The desktop app's `src/` is its main process. |

Imports point down the layers. The core, `frontend/core`, imports nothing else: no UI layer,
no React, and among packages only the protocol's data-only entries (`/harnesses`, `/pages`,
`/text`), which `frontend/core/src/architecture.test.ts` checks. Everything outside it reaches
it as `@novadeck/core/*`, the package's exports; inside it files import one another by
relative path. `theme/` imports nothing but itself and the core's types; every layer that
composes the page may use it, though no backend does (the entries hand them the page's
theme), and [docs/theming.md](docs/theming.md) is its contract with components.
Each backend adapter, `frontend/runner-adapter` and `frontend/demo`, builds only on the core
and `frontend/terminal-views`, never on the app's chrome; the package graph holds that, as a
package imports only what its `package.json` declares. The demo's debug panel is a package
of its own, `frontend/demo-debug`, the one with React and Lucide. `interaction/` builds on
the core and imports no packages;
features add `ui-toolkit/`; `terminals/` may use `sidebar/`; `layouts/` may use
`terminals/`; `notifications/` builds on the base layers, `sidebar/` and
`terminals/unread-state.ts`; `inbox/` builds on the base layers, `sidebar/` and the
chat's markdown reader and answers; `shell/` may use `layouts/`, `projects/`,
`notifications/` and `inbox/`. `app/` composes every feature layer, `notifications/` and `inbox/`.
Only an app imports a backend adapter, each its own: `apps/desktop` takes the runner adapter,
`apps/try` the demo, and `apps/previews` the demo with its debug panel (tests and specs may
import the demo's spec entry). Each starts the UI through `entries/start.tsx`. `app/commands/`
has no direct React or package imports, though
routing still loads React Router at runtime: it builds on the core,
`interaction/keymap.ts`, the UI store, routing, selectors,
the Canvas handle type in `layouts/canvas/types.ts`, and the pure state modules
of `shell/` and `terminals/` (unread finishes among them), the companion panes' store and the chat's modes among them. Vendor
libraries stay in their adapters: XYFlow in `layouts/canvas/`, React Grid Layout
in `layouts/grid/`, Allotment in `shell/`, dnd kit in `terminals/`, Ark UI in
`ui-toolkit/`, React Router in `app/` and `shell/`, and React DOM in
`layouts/transition.ts` and `entries/start.tsx`; and the runner client and
the emulator's view in `frontend/runner-adapter/`, the demo's terminals
(`frontend/demo/src/views.ts`, `frontend/demo/src/screen/`) and `frontend/terminal-views/`,
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
as the backend reports them, and how the person arranged each bar (`frontend/core/src/companion-bar.ts`),
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
companion panes' store in `terminals/companion/state.ts` holds what the panes load,
by item: each plan as the person edits it, what each item last loaded, and the secret
files the person chose to see; it follows the backend's companions and messages from an
effect. What an item loaded stays 30 seconds after nothing shows it, then goes, so a
large image doesn't stay in memory. What a taskbar shows is derived from it and the workspace in
`terminals/companion/bar.ts`, never stored.
`WorkspaceProvider` creates the backend, the stores, the drag session
(`terminals/drag-session.ts`), the navigator, and the commands once per App, in a pure
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
stream the demo writes as terminal output (`frontend/demo/src/views.ts`). Its screen
(`frontend/demo/src/screen/`) keeps an append-only transcript (the program's sample output or
the agent's opening, the commands typed and their replies, the agent's conversation) and
redraws a live tail in place (the dialog an agent waits on, its status, the prompt), as Claude
Code and Codex redraw their bottom; a resize draws it whole at the new width. Keys come back
through a line editor (`frontend/demo/src/line-editor.ts`). The engine keeps each terminal's
command line and output with one subscription each, so output does not trigger
workspace-wide renders. A terminal's
presentation can unmount during view or session changes without losing that
state; closing the terminal removes it. `frontend/core/src/registry.ts` provides this
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

Keep direct Ark UI imports in `ui-toolkit/`; features own their content and state.
Use Tailwind utilities in TSX only to arrange elements: layout, spacing, sizes, and
the size and flow of type. How a component looks comes from its recipe, a stylesheet
beside it that reads theme tokens; see [docs/theming.md](docs/theming.md), which
`theme/contract.test.ts` enforces. See [CODING.md](CODING.md) for broader
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
Run a single spec with `pnpm --filter @novadeck/specs exec vitest run --project behaviour src/canvas.spec.tsx`,
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
(`frontend/runner-adapter/src/scripted-server.ts`): the whole contract served by oRPC over an in-memory
port, so a procedure the contract adds is a type error there. It is the one spec that may
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

- UI: `VITE_API_URL` sets, at build time, the API origin that the Content Security
  Policy permits; by default only the same origin. The UI does not call the API yet.
- Browser UI: `VITE_NOVADECK_RUNNER_URL` (a `ws:` or `wss:` URL ending in `/api/rpc`)
  and `VITE_NOVADECK_RUNNER_TOKEN` name the runner a browser build (the web entry,
  `--mode web`) connects to; the CSP permits that origin. The desktop app ignores them and
  uses its own runner.

  > **Warning:** a browser build made with `VITE_NOVADECK_RUNNER_TOKEN` embeds the
  > token in its JavaScript. Anyone who can load that bundle can run shells on the
  > runner as its user. Keep such builds private: never deploy or share them.

- Runner: `HOST`, `PORT`, and `CORS_ORIGINS` control the listener and allowed frontend origins.
- Terminal API: `NOVADECK_TOKEN` enables authenticated WebSocket RPC;
  `NOVADECK_DATABASE` optionally selects the SQLite metadata file. Without a token,
  only the existing HTTP status API is available.
- Electron: the host runs the runner in a utility process and hands each window a
  MessagePort through a sandboxed preload bridge. It also serves the status endpoint
  on a local, OS-selected port. Package `.env` files are not used.

For a separately hosted frontend, set `VITE_API_URL` to the public HTTPS API URL
before building and add the frontend origin to `CORS_ORIGINS`. The generated
Content Security Policy permits the configured API origin. Local `.env` files
are ignored; never commit credentials.

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
smaller CI runners enough to time out. What each task waits for, and why, is in [docs/build-graph.md](docs/build-graph.md).
Tests use Vitest: UI behaviour specs run in Vitest Browser Mode on Chromium, and
MSW covers HTTP behavior. The PR workflows run formatting, lint, typechecking,
builds, and PR metadata checks on Linux. The Test jobs run all package and repository
tests on Linux, macOS, and Windows, including for draft PRs. Each runs UI tests in
Chromium alongside backend API, real PTY, and built-CLI tests. The required `Test`
check passes only when the entire Quality matrix succeeds. Once it has, a PR ready for review
packages and smoke-tests the app on Linux, macOS, and Windows, through the
[Package](.github/workflows/package.yml) workflow releases use too, which Quality calls: no
runner waits for the checks. It does so only when the change
can affect the packaged app (`scripts/package/plan`: the host and every package it's built from,
apart from their tests and prose, the dependency pins and patches, and the workflows that
package). Draft PRs skip packaging; PR checks never create tags or publish releases.
Quality checks run on PR opening, reopening, and commits. A PR reads only its own and
its base branch's caches, so the [Warm Caches](.github/workflows/warm.yml) workflow fills main's test
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
  [scripts/install](scripts/install) with the repository filled in.
- macOS universal: `novadeck-mac-universal.dmg`, the disk image to drag the app to
  Applications from, and `novadeck-mac-universal.zip`, which updates install from.
- Windows x64: `novadeck-win-x64-setup.exe`, a one-click installer that installs for the
  current user without an administrator prompt.

None of the names carries a version, so `releases/latest/download/<name>` is always the
newest stable build. The ZIP and the AppImage are not advertised: `install.sh` installs
the AppImage, which replaces itself in place once installed, and the app from the ZIP.

Local builds are unsigned, so Gatekeeper or SmartScreen may warn. The application ID is `dev.mzpk.novadeck`.
Releases are signed and notarized once the signing credentials are set up; see
[docs/release-signing.md](docs/release-signing.md).

Builds also write `latest*.yml` update metadata and `.blockmap` files beside the packages,
which releases upload so installed apps can update themselves; see
[docs/auto-update.md](docs/auto-update.md).

Each package ships the relay agents start for Novadeck's MCP server and hooks, built
from source with the rest of the app.

The [release workflow](.github/workflows/release.yml) publishes immutable GitHub
prereleases from qualifying changes on `main`, with notes, checksums, and native
packages. It smoke-tests each packaged application before upload, installs the AppImage and
the macOS app through `install.sh` served from a local copy of the release, and fails when
the installed AppImage runs without Electron's sandbox. The workflow feeds
its own repository into the update feed baked into each app and into `install.sh`, so
moving the repository needs no edit. Conventional
Commits determine release eligibility; versions are currently limited to patch
increments. Documentation-only changes do not trigger a release. See
[.release-it.json](.release-it.json) for the release configuration.

Bump `engineInterface` in `engines/whisper/scripts/build.ts` (voice) or
`engines/murmur/scripts/build.ts` (murmur) with any change to the server flags the
runner passes, the requests it makes of the server, the patched HTTP surface or, for
murmur, the `--list-devices` output: during an update the runner uses an older engine only
if it speaks the same interface. Both engines are built by the shared
`engines/ggml-build`.

There are two channels. Every release from `main` is a prerelease, the early channel. The
stable channel is GitHub's latest release that is not a prerelease, which installs, the
`releases/latest/download/` links and, by default, installed apps follow. Promote a tested
prerelease by running the [Promote to Stable](.github/workflows/promote.yml) workflow from
the Actions tab, with a version such as `1.2.3` or none for the newest prerelease. It
checks that the release is published, is a prerelease, carries every package, `latest*.yml`
and `install.sh`, and is newer than the current stable release, then clears **Set as a
pre-release** and sets it as the latest. No rebuild happens, and GitHub still lets those
two flags change on an immutable release. For an interrupted release, inspect the latest
workflow first. An unpublished draft or orphaned version tag must be cleaned up before
rerunning the latest release workflow; published immutable releases must remain intact.

## Contributing

Start with [AGENTS.md](AGENTS.md) for the required reading,
[CONTRIBUTING.md](CONTRIBUTING.md) for the issue and PR workflow, and
[CODING.md](CODING.md) for code and test conventions. Follow
[SECURITY.md](SECURITY.md) for credentials and vulnerability reports.
