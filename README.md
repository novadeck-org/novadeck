<p align="center">
  <a href="https://novadeck.dev/?utm_source=readme">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg" />
      <img src="docs/assets/logo-light.svg" alt="Novadeck" height="56" />
    </picture>
  </a>
</p>

<p align="center">
  <strong>A desktop terminal for Claude Code, Codex and Antigravity.</strong><br />
  When an agent needs you, its question comes to one Inbox, and you answer it right there.
</p>

<p align="center">
  <a href="https://novadeck.dev/download?utm_source=readme"><strong>Download</strong></a> ·
  <a href="https://try.novadeck.dev">Try it in your browser</a> ·
  <a href="https://novadeck.dev/?utm_source=readme">Website</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-1f2328?style=flat-square" alt="Runs on macOS, Windows and Linux" />
  <a href="https://github.com/novadeck-org/novadeck/releases/latest"><img src="https://img.shields.io/github/v/release/novadeck-org/novadeck?style=flat-square&label=release&color=1f2328" alt="Latest release" /></a>
  <a href="https://github.com/novadeck-org/novadeck/commits/main"><img src="https://img.shields.io/github/commit-activity/w/novadeck-org/novadeck?style=flat-square&label=commits&color=1f2328" alt="Commits per week" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-1f2328?style=flat-square" alt="License: GPL-3.0-or-later" /></a>
</p>

<p align="center">
  <a href="https://youtu.be/m3utO-zBN-k">▶ Watch the 2-minute tour</a>
</p>

Novadeck is a desktop app for running several coding agents at once. Each agent runs as its
own CLI in a real terminal. When one stops to ask you something, the question shows up in an
Inbox, so you don't have to go looking for its terminal. It's free, open source and needs no
account.

## Inbox

<p align="center">
  <img src="docs/assets/highlights/inbox.webp" alt="In the Grid, Checkout tests, a Claude Code agent, asks to run pnpm test:e2e. The ask opens in the Inbox under what the agent did first, with Allow, always allow and Deny. Allow is picked, and the agent's tests run and pass." width="100%" />
</p>

Permission prompts, plans and questions from all your agents land in one list, with the
agent's own options as buttons. Pick one and the agent continues. When Novadeck can't offer a
prompt's options, it takes you to the terminal instead. New items show up as a toast, or as a
system notification when Novadeck isn't in front.

## Teams

<p align="center">
  <img src="docs/assets/highlights/teams.webp" alt="Orders API, a Claude Code lead, with its teammates wired to it in the terminal list, Pricing endpoint on Codex and Stock endpoint on Antigravity among them. Its Messages pane opens Cart endpoint's conversation: the brief, the teammate's question about which API version to call, and the lead's answer." width="100%" />
</p>

Every terminal has a handle, like `@lynx`. Agents can message each other by handle and start
new agents with a brief, so you can ask Claude to get Codex to review its change. Claude Code,
Codex and Antigravity can be on the same team. A line connects a lead to its teammates, and
each agent's Messages pane shows its conversations.

## Focus, Grid and Canvas

<p align="center">
  <img src="docs/assets/highlights/views.webp" alt="One project's terminals in Focus, one big; then tiled in the Grid; then all ten at once on the Canvas." width="100%" />
</p>

Focus shows one terminal, Grid tiles them, and Canvas lets you place them anywhere. They're the
same terminals in every view, so switching doesn't interrupt anything.

## Companion pane

<p align="center">
  <img src="docs/assets/highlights/companion.webp" alt="Order status page, a Claude Code agent, shows its order page in the pane beside its terminal, then a screenshot of three takes on the page's Track package button." width="100%" />
</p>

An agent can open a web page, an image or its changes in a pane next to its terminal.

## Restore

<p align="center">
  <img src="docs/assets/highlights/restore.webp" alt="Novadeck starts again. Its splash counts the terminals as it attaches them, says Deck online, and cuts back to the deck as it was, in Focus on Cart drawer, its Claude Code session where it left off." width="100%" />
</p>

After a restart, terminals reopen in the same folders with their recent output, and Claude
Code, Codex and Antigravity resume their sessions.

## Bring your own harness

Novadeck doesn't wrap or reimplement the agents. It starts the CLIs you already have
installed, with your config, signed in to your own accounts. It adds a small plugin to each
agent to follow its sessions and pass messages, and removes it when you turn the agent off.

## Install

```sh
curl -fsSL https://novadeck.dev/install.sh | sh
```

On macOS and x86_64 Linux. For Windows and portable builds, see
[novadeck.dev/download](https://novadeck.dev/download?utm_source=readme).

If you want to come back to this later, star the repo. It also helps other people find it.

## Docs

- [Guide](docs/guide.md): a short tour of how Novadeck works. The [reference](docs/reference.md) has every detail.
- [Development](docs/development.md): setup, repository map, tests and releases.
- [Contributing](CONTRIBUTING.md) · [Code style](CODING.md) · [Security](SECURITY.md)
- Found a bug or want something? [Open an issue](https://github.com/novadeck-org/novadeck/issues).

## License

[GPL-3.0-or-later](LICENSE). Copyright © 2026 Mateusz Pietrzak and contributors.
Contributions come in under the [CLA](CLA.md).
