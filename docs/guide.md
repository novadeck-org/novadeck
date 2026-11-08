# Using Novadeck

The basics. Everything else is in the [reference](reference.md).

## Install

macOS and Linux:

```sh
curl -fsSL https://novadeck.dev/install.sh | sh
```

Windows: run the
[installer](https://github.com/novadeck-org/novadeck/releases/latest/download/novadeck-win-x64-setup.exe).
No admin rights needed.

Want to try it first? There are portable builds on
[novadeck.dev/download](https://novadeck.dev/download).

The installed app updates itself when you quit. It never restarts on its own.

## Connect your agents

On first run, pick the agents to connect: Claude Code, Codex, Antigravity. Novadeck adds a small
plugin to each, so it can follow their sessions and pass messages between them.

Codex may ask you to trust Novadeck's hooks. Do it (`/hooks` in Codex), or messages won't reach
it.

Then start agents the usual way, with `claude`, `codex` or `agy` in any terminal.

## Views

- **Focus:** one terminal.
- **Grid:** all of them side by side.
- **Canvas:** arrange them freely. Scroll to zoom, drag to pan.

Zen mode (`Ctrl+Shift+Z`, or `Cmd+Shift+Z` on macOS) hides everything but the terminals.

## Inbox

The bell on the left. When an agent wants a permission, a plan approved or an answer, it shows
up here. Click it and answer with a button. If that's not possible, it takes you to the
terminal. `S` snoozes it.

Agents that finish leave a short report here too.

## Teams

Each terminal has a handle, like `@moth`. Agents use it to message each other, and one agent can
start others and lead them. Lines on screen show who leads whom.

## After a restart

Terminals reopen where they were, and agents pick up their sessions. Closed terminals stay in
History for 30 days.

## Shortcuts

| Action                 | Windows and Linux                | macOS              |
| ---------------------- | -------------------------------- | ------------------ |
| Find a terminal        | `Ctrl+Shift+K`                   | `Cmd+K`            |
| New terminal           | `Ctrl+Shift+T`                   | `Cmd+T`            |
| Recent terminals       | `Ctrl+Tab`                       | `Ctrl+Tab`         |
| Move between terminals | `Ctrl+Shift+↑↓←→`                | `Cmd+Option+↑↓←→`  |
| Inbox                  | `Ctrl+Shift+B`                   | `Cmd+Shift+B`      |
| Zen                    | `Ctrl+Shift+Z`                   | `Cmd+Shift+Z`      |
| Pinned project 1–9     | `Ctrl+Shift+1` to `Ctrl+Shift+9` | `Cmd+1` to `Cmd+9` |
| Preferences            | `Ctrl+,`                         | `Cmd+,`            |

The full list is in the [reference](reference.md#keyboard-shortcuts).
