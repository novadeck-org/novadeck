<p align="center">
  <a href="https://novadeck.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg" />
      <img src="docs/assets/logo-light.svg" alt="Novadeck" height="56" />
    </picture>
  </a>
</p>

<h3 align="center">You’re a runner, not a babysitter.</h3>

<p align="center">
  Run Claude Code, Codex and Antigravity side by side, in one window.<br />
  When one needs you, it asks in your Inbox.
</p>

<p align="center">
  <a href="https://novadeck.dev/download"><b>Download</b></a> ·
  <a href="https://try.novadeck.dev">Try it in your browser</a> ·
  <a href="https://novadeck.dev">Website</a> ·
  <a href="docs/guide.md">Guide</a>
</p>

<p align="center">
  <a href="https://try.novadeck.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://try.novadeck.dev/poster-dark-2560.webp" />
      <img src="https://try.novadeck.dev/poster-light-2560.webp" alt="Novadeck's Focus view: a storefront project with four terminals in the sidebar, Claude Code planning a checkout page in the main pane, and Codex reviewing in another terminal." width="100%" />
    </picture>
  </a>
</p>

No more tabbing through agents to find the one that’s been stuck on a `[y/N]` for twenty
minutes. Novadeck is a desktop terminal workspace for the coding agents you already use. It
runs them all in one window, brings what they ask you to one Inbox, and lets them work
together as a team, on the subscriptions you already pay for.

Free and open source. No account, no telemetry.

## Install

**macOS and Linux**

```sh
curl -fsSL https://novadeck.dev/install.sh | sh
```

Run it as yourself, not with `sudo`. Run it again to upgrade.

**Windows:** [download the installer](https://novadeck.dev/download/windows). It installs for
your account, with no administrator prompt.

**Just looking?** Each system has a portable build that runs from wherever you put it. If you
like it, hit **Install Novadeck** inside it and your setup comes along. Portable builds,
the macOS disk image and every other option are on
[novadeck.dev/download](https://novadeck.dev/download).

Installed copies update themselves. The [guide](docs/guide.md#install) has the details:
where things go, the Linux sandbox profile, and how to uninstall.

## A day with your crew

**Answer them where you are.** Kick off four agents and go do your own thing. When one has a
question or wants your OK to run something, you get a ping, and the question waits in your
Inbox with the answers as buttons. Pick one and the agent carries on, no terminal needed.
The other agents just keep working.

**Stop being the meat proxy.** Tell Claude “get Codex to review this” or “split this across
three more agents” and they sort it out between themselves. Claude, Codex and Antigravity
work in one team, each with its own handle, and a line on screen shows who leads whom. An
agent’s Messages pane shows what they said to each other.

**Run one, a few, or the whole crew.** Zoom in on one in **Focus**, tile a few in **Grid**, or
spread them all across a zoomable **Canvas**. Same terminals in every view, so switching
never kills a run.

**Where’d it save that?** When an agent writes a plan or takes a screenshot, it lands right
next to its terminal. You read it there, and then you get back to work.

**And tomorrow?** Restart your machine and everything comes back. Every terminal returns with
its folder, its scrollback and the agent session it was running.

## Bring your own harness

Novadeck doesn’t ship its own agent. It runs yours.

- **It’s the CLI you already use.** Same binary, same version, same skills, hooks and MCP
  servers. When Claude Code or Codex ships a feature, you get it the same day.
- **Hit a limit? Hand off and keep going.** When Claude runs out of usage, tell Codex to pick
  up where it left off, in the same folder.
- **Walk away any time.** Novadeck never writes to your repos or touches your shell. Each
  agent gets one small plugin, and it uninstalls clean.

Works with **Claude Code**, **Codex** and **Antigravity** today, with opencode, Cursor CLI and
Pi coming next. You sign in to each one the way you already do.

## Getting around

| To                                     | macOS             | Windows and Linux  |
| -------------------------------------- | ----------------- | ------------------ |
| Open a new terminal                    | `Cmd+T`           | `Ctrl+Shift+T`     |
| Find a terminal                        | `Cmd+K`           | `Ctrl+Shift+K`     |
| Jump between recent terminals          | `Ctrl+Tab`        | `Ctrl+Tab`         |
| Flip between Focus and Grid or Canvas  | `Cmd+Enter`       | `Ctrl+Shift+Enter` |
| Move to the terminal in that direction | `Cmd+Option+↑↓←→` | `Ctrl+Shift+↑↓←→`  |
| Hide everything but the terminals      | `Cmd+Shift+Z`     | `Ctrl+Shift+Z`     |

The rest are in the [guide](docs/guide.md#keyboard-shortcuts).

## Questions

<details>
<summary><b>Is it really free?</b></summary>

Yep, for personal and commercial use. No account, no trial, no card. It’s open source under the
GPL.

</details>

<details>
<summary><b>Do I have to change my setup?</b></summary>

Nope. Your config, skills, hooks and MCP servers come along as they are.

</details>

<details>
<summary><b>Why not just tmux or terminal tabs?</b></summary>

Keep tmux if you love it. Novadeck adds what panes can’t: a status on every agent, an Inbox
that collects what they ask you, plans and screenshots next to the terminal, and everything
back after a reboot. No `.tmux.conf` required.

</details>

<details>
<summary><b>How is it different from Cursor or the Claude and Codex apps?</b></summary>

Those apps want you living in them. The Claude and Codex apps run one company’s agent, and the
Cursor editor runs on a Cursor account. Novadeck runs Claude Code, Codex and the rest side by
side on the subscriptions you already have, brings their questions to one Inbox and lets them
work together. And because it’s the real CLI, your terminal setup comes too.

</details>

<details>
<summary><b>Will it break if Anthropic or OpenAI change the rules?</b></summary>

Novadeck won’t be the reason. You sign in to the official CLIs yourself, and Novadeck never
calls a vendor’s API on your behalf. You’re using each agent exactly how its maker ships it.

</details>

<details>
<summary><b>Does it send my code anywhere?</b></summary>

No. Novadeck itself only goes online to check for updates, to send a note when you press Send
in its feedback card, and, if you turn them on, to download its local models, which then run
on your machine. Update checks are counted, without any ID, and a note is anonymous. The
[privacy page](https://novadeck.dev/privacy) lists exactly what’s kept. Your agents talk to
their own providers, same as in your terminal.

</details>

## Docs

- [Guide](docs/guide.md): everything Novadeck does, in detail: views, terminals, the Inbox,
  restoring, Zen mode and every shortcut.
- [Agent messaging](docs/agent-messaging.md): the design behind agents messaging each other
  and working as a team.
- [Theming](docs/theming.md): how Graphite and the Phosphor themes are built.
- [Updates](docs/auto-update.md): how installed copies keep themselves up to date.

## Contributing

Novadeck is a TypeScript monorepo: an Electron app over a runner that owns every terminal.
To build it, start with [docs/development.md](docs/development.md) for setup, the repository
map, tests and releases. Then read [CONTRIBUTING.md](CONTRIBUTING.md) for issues and pull
requests and [CODING.md](CODING.md) for the code style. Security findings go through
[SECURITY.md](SECURITY.md).

## License

Novadeck is free software under the [GNU General Public License, version 3 or later](LICENSE)
(`GPL-3.0-or-later`), all of it. Use it anywhere, at home or at work, and change it as you
like. If you give a copy to others, changed or not, it goes under the same license, and you
make its source available. Copyright © 2026 Mateusz Pietrzak and contributors.
Contributions come in under the [Contributor License Agreement](CLA.md); see
[CONTRIBUTING.md](CONTRIBUTING.md#license).
