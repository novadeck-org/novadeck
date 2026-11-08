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
  <img src="docs/assets/inbox.webp" alt="Three agents ask at once: a command to run, a plan to approve and a question. The Inbox lists all three, and each is answered from its sheet until nothing needs you." width="100%" />
</p>

<p align="center">
  Three agents ask at once. Each answer is a click in the Inbox, without opening their terminals.<br />
  <a href="https://youtu.be/m3utO-zBN-k">▶ Watch the 2-minute tour</a>
</p>

## Why

Run a few agents and you spend the day tabbing between terminals, looking for the one that's
been sitting on a `[y/N]` for twenty minutes. Novadeck keeps them all in one window and brings
their questions to you instead. It's free, open source, and needs no account.

## What you get

- **One Inbox for every agent.** Permission prompts, plans and questions from Claude Code,
  Codex and Antigravity land in one list. Most you can answer right there, with the
  agent's own options as buttons.
- **Bring your own harness (BYOH).** Novadeck runs the real CLIs on your machine, signed in to
  your own accounts and plans, set up the way you already have them. Nothing is wrapped or
  rebuilt: each agent runs as its maker ships it.
- **Agents that work as a team.** Agents message each other by handle (`@moth`), a lead can
  open teammates and brief them, and Canvas draws who leads whom.
- **Focus, Grid and Canvas.** One terminal at a time, all of them side by side, or arranged
  freely on a board.
- **Back where you were after a reboot.** Every terminal reopens in its folder with its output,
  and Claude Code, Codex and Antigravity resume the session they were in.
- **Closing isn't final.** Closed terminals wait in History for 30 days.
- **Done means done.** An agent that finishes reports it: a mark on its tab, a notification,
  and its short report in the Inbox.

## A closer look

<p align="center">
  <img src="docs/assets/team-canvas.webp" alt="Canvas view: the lead Orders API, marked leads 3, joined by lit wires to its teammates Cart endpoint, Pricing endpoint and Stock endpoint, each marked led by @lynx." width="100%" />
</p>

A lead and the three teammates it opened, wired together on the Canvas.

<p align="center">
  <img src="docs/assets/grid.webp" alt="Grid view: Claude Code and Codex agents side by side, each in its real terminal, with the sidebar listing every agent and its handle." width="100%" />
</p>

Claude Code and Codex side by side in Grid, each in its own real terminal.

## How it's different

Already using something like it? The short version:

- **Orca:** both run Claude Code, Codex and Antigravity on your own plans. In Orca you go to each
  agent to answer it; in Novadeck their questions come to one Inbox.
  [Novadeck vs Orca](https://novadeck.dev/vs/orca?utm_source=readme)
- **Herdr:** Herdr shows which agent needs you; Novadeck shows what it's asking, with the
  answers as buttons. [Novadeck vs Herdr](https://novadeck.dev/vs/herdr?utm_source=readme)
- **T3 Code:** T3 Code runs agents headless, behind its own chat; Novadeck runs them in real
  terminals, as their makers ship them.
  [Novadeck vs T3 Code](https://novadeck.dev/vs/t3code?utm_source=readme)

## Install

```sh
curl -fsSL https://novadeck.dev/install.sh | sh
```

On macOS and x86_64 Linux. For Windows and portable builds, see
[novadeck.dev/download](https://novadeck.dev/download?utm_source=readme).

Want to find this again? A ⭐ keeps Novadeck in your GitHub stars, and helps other developers
find it.

## Docs

- [Guide](docs/guide.md): how Novadeck works, in detail.
- [Development](docs/development.md): setup, repository map, tests and releases.
- [Contributing](CONTRIBUTING.md) · [Code style](CODING.md) · [Security](SECURITY.md)
- Found a bug or want something? [Open an issue](https://github.com/novadeck-org/novadeck/issues).

## License

[GPL-3.0-or-later](LICENSE). Copyright © 2026 Mateusz Pietrzak and contributors.
Contributions come in under the [CLA](CLA.md).
