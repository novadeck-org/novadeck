# Using Novadeck

A short tour of how Novadeck works. Every detail, edge case and setting is in the
[reference](reference.md).

## Install

On macOS and x86_64 Linux:

```sh
curl -fsSL https://novadeck.dev/install.sh | sh
```

Run it as yourself, not with `sudo`. On Windows, run
[`novadeck-win-x64-setup.exe`](https://github.com/novadeck-org/novadeck/releases/latest/download/novadeck-win-x64-setup.exe);
it installs for your user, with no administrator prompt. To try Novadeck without installing
anything, grab a portable build from [novadeck.dev/download](https://novadeck.dev/download).

An installed Novadeck keeps itself up to date. A downloaded update installs when you next
quit, and a **Restart to update** chip in the footer tells you what a restart would do first.
Novadeck never restarts on its own. A portable build only checks for new releases and offers to install Novadeck.
To remove Novadeck, press **Uninstall…** under About in Preferences (a Homebrew install shows
its `brew uninstall` command there instead).

## Connect your agents

On first run, Novadeck offers to connect the agents it finds installed: Claude Code, Codex and
Antigravity. Connecting one installs a small Novadeck plugin through the agent's own plugin
command. It tells Novadeck which session the agent is in, so Novadeck can resume it after a
restart, and it carries agents' messages to each other. Turn an agent off in Preferences and
its plugin is uninstalled.

Codex asks you to review Novadeck's hooks ("Hooks need review"), and asks again when a
Novadeck update changes them. Trust them in Codex with `/hooks`; until you do, they don't
run, so other agents' messages can't reach that Codex session.

After that, run the agent as usual: open a terminal and type `claude`, `codex` or `agy`. It's
the real CLI, signed in to your own account, with your own settings.

## Views

Switch views from the top bar:

- **Focus** shows one terminal at a time.
- **Grid** puts every terminal side by side.
- **Canvas** lets you place terminals freely on a board. Scroll to zoom, drag the background to
  pan, and double-click a terminal's header, away from its name, to zoom in on it. Do it again
  to go back. Double-clicking the name renames the terminal.

**Zen mode** (`Cmd+Shift+Z` on macOS, `Ctrl+Shift+Z` elsewhere) hides everything but your
terminals and a small dock.

Terminals are grouped into projects and sessions. The project switcher is at the top left, and
a mark next to a project shows when one of its agents needs you.

## The Inbox

The Inbox, the bell on the left rail, collects everything your agents are waiting on, from
every project:

- **Unblock (!):** the agent can't go on without you, for example a permission to run a
  command or a plan to approve.
- **Ask (?):** a question.
- **Trouble:** a failed turn, a usage limit, or messages held too long.
- **Update:** an agent reporting it's done, or telling you something.

Click a row to read it. Most questions you can answer right there, with the agent's own options
as buttons. When the Inbox can't offer the answer, it takes you to the terminal. Press **S** to
snooze a row you want to leave for later.

When something new needs you, a toast appears if Novadeck is in front, or a system
notification if it isn't. Nothing rings for the terminal you're looking at. You can turn both
off in Preferences.

## Agents working together

Every terminal gets a handle, such as `@moth`, and agents use it to message each other. An agent
can open more agents and brief them, and it then leads that team. Novadeck draws a wire
between a lead and its teammates in the sidebar, Grid and Canvas.

A terminal that has had messages gets a **Messages** icon, which shows its conversations. To
stop all messages between agents for a while, use **Pause all agents' messages** at the top of
that pane.

When an agent finishes its task, it reports it: a green ✓ on its tab, its short report in the
Inbox, and a notification if Novadeck is in the background.

## After a restart

Restart your computer and Novadeck puts every terminal back in the folder it was in, with its
earlier output above a fresh prompt. Claude Code, Codex and Antigravity come back in the session
they were running.

Closing a terminal isn't final either. It moves to **History** on the left rail, where you can
restore it for 30 days.

## Keyboard shortcuts

| Action                       | macOS              | Windows and Linux                |
| ---------------------------- | ------------------ | -------------------------------- |
| Find a terminal              | `Cmd+K`            | `Ctrl+Shift+K`                   |
| New terminal                 | `Cmd+T`            | `Ctrl+Shift+T`                   |
| Recent terminals             | `Ctrl+Tab`         | `Ctrl+Tab`                       |
| Terminal in that direction   | `Cmd+Option+↑↓←→`  | `Ctrl+Shift+↑↓←→`                |
| Switch Focus and Grid/Canvas | `Cmd+Enter`        | `Ctrl+Shift+Enter`               |
| Toggle the Inbox             | `Cmd+Shift+B`      | `Ctrl+Shift+B`                   |
| Toggle Zen                   | `Cmd+Shift+Z`      | `Ctrl+Shift+Z`                   |
| Pinned project 1 to 9        | `Cmd+1` to `Cmd+9` | `Ctrl+Shift+1` to `Ctrl+Shift+9` |
| Preferences                  | `Cmd+,`            | `Ctrl+,`                         |

`Shift+Esc` steps out of the terminal so the arrow keys move between terminals. `Enter` or `Esc`
takes you back in. The full list, copy and paste included, is in the
[reference](reference.md#keyboard-shortcuts).
