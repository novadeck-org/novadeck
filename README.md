<p align="center">
  <a href="https://novadeck.dev/?utm_source=readme">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg" />
      <img src="docs/assets/logo-light.svg" alt="Novadeck" height="56" />
    </picture>
  </a>
</p>

<p align="center">
  <strong>A desktop terminal for Claude Code, Codex, Antigravity, opencode and pi.</strong><br />
  When an agent needs you, its question comes to one Inbox, and you answer it right there.<br />
  Free and open source, no account.
</p>

<p align="center">
  <a href="https://novadeck.dev/download?utm_source=readme"><strong>Download</strong></a> ·
  <a href="https://try.novadeck.dev">Try it in your browser</a> ·
  <a href="https://novadeck.dev/?utm_source=readme">Website</a>
</p>

<p align="center">
  <a href="https://github.com/novadeck-org/novadeck/releases/latest"><img src="https://novadeck.dev/badge/latest.svg" alt="Latest release" /></a>
  <a href="https://github.com/novadeck-org/novadeck/commits/main"><img src="https://novadeck.dev/badge/commits.svg" alt="Commits this week" /></a>
  <a href="docs/guide.md#connect-your-agents"><img src="https://novadeck.dev/badge/agents.svg" alt="Agents: Claude Code, Codex, Antigravity, opencode and pi" /></a>
  <br />
  <a href="https://novadeck.dev/download?utm_source=readme"><img src="https://novadeck.dev/badge/runs-on.svg" alt="Runs on macOS, Windows and Linux" /></a>
  <a href="https://novadeck.dev/privacy?utm_source=readme"><img src="https://novadeck.dev/badge/privacy.svg" alt="Privacy: no account, no telemetry" /></a>
  <a href="LICENSE"><img src="https://novadeck.dev/badge/license.svg" alt="License: GPL-3.0-or-later" /></a>
</p>

<p align="center">
  <a href="https://youtu.be/m3utO-zBN-k">▶ Watch the 2-minute tour</a>
</p>

One coding agent is easy to keep up with. Run three or four and the job changes: you flip between
tabs to find the one that's waiting, carry answers from one agent to another, and lose track of
which branch holds what. Novadeck is a terminal for running several at once.

## Keep the agents you have

<p align="center">
  <img src="docs/assets/highlights/agents.webp" alt="The terminal list's rows, one per harness: Claude Code, Codex, Antigravity, opencode and pi, each named as it lands." width="100%" />
</p>

Novadeck runs the CLIs you already use, with your config and your own accounts. Nothing is wrapped
or rebuilt, so there's nothing to set up again.

## See who needs you

<p align="center">
  <img src="docs/assets/highlights/glance.webp" alt="The terminal list marks each agent working, asking, failed or done. Then the same terminals in Focus, one big; on the Canvas, all at once; and tiled in the Grid." width="100%" />
</p>

Start a few. The list marks each one working, asking, failed or done, so you stop clicking through
tabs to check. Look at one in Focus, at all of them on the Canvas, or side by side in the Grid.

## Answer them where you are

<p align="center">
  <img src="docs/assets/highlights/inbox.webp" alt="Three asks land on the Canvas: a command to run, a plan to approve and a question. Each shows in the Inbox. Opened from there, the command gets Yes, the plan Yes, manually approve edits, and the question its recommended answer, the customer's account. Each agent goes back to work." width="100%" />
</p>

When an agent stops to ask, its permission prompt, plan or question lands in one Inbox. Most you
answer with a click, and the agent goes back to work.

## Stop being the meat proxy

<p align="center">
  <img src="docs/assets/highlights/teams.webp" alt="Orders API, a Claude Code lead, opens three teammates, wired to it on the Canvas. Cart endpoint asks which API version to call, in the Inbox and to its lead. The lead answers first, and the ask leaves the Inbox on its own. Pricing endpoint reports done, to its lead and to the Inbox." width="100%" />
</p>

Often an agent's question is really for another agent. Here they message each other by handle and
start their own teammates, so you stop copying answers between them. Claude Code, Codex,
Antigravity, opencode and pi can share a team.

## Read along as a chat

<p align="center">
  <img src="docs/assets/highlights/chat.webp" alt="In Preferences, Show agents as is switched from Terminal to Chat. The Grid's terminals turn into chats: Cart drawer's steps, and Search index's review of its change as a message." width="100%" />
</p>

Once they talk to each other, you'll want to follow. Agent Chat shows the same agents as a chat,
their messages to each other included. Pick it in Preferences.

## Keep their work apart

<p align="center">
  <img src="docs/assets/highlights/worktrees.webp" alt="The Worktrees panel lists every agent's worktree with its pull request, checks and handle. Orders API's three teammates hang under it. A check turns green, and Cart endpoint's pull request opens." width="100%" />
</p>

Several agents in one repository trip over each other's changes. Here each one works in its own
worktree, out of your checkout. The Worktrees panel lists them with their pull requests, checks and
who's on what.

## See what they're changing

<p align="center">
  <img src="docs/assets/highlights/files.webp" alt="The Files panel shows the project's tree while the agents write: each file marked with the agent writing it, new files arriving as they're made." width="100%" />
</p>

With several agents writing at once, it's hard to tell who touched what. The Files panel marks
each file with the agent changing it, as it happens.

## Where'd it save that?

<p align="center">
  <img src="docs/assets/highlights/show.webp" alt="Order status page, an agent, shows its page in the pane beside its terminal, then its changes as diffs, then an image, a video, a PDF invoice, a 3D model, a CSV as a table and a folder of screenshots." width="100%" />
</p>

When an agent makes something, it shows it to you. Pages, diffs, images, videos, PDFs, 3D models,
CSVs and folders open right next to its terminal, so you don't go looking for them.

## Back where you left off

Close Novadeck at the end of the day. Next time, terminals reopen where they were and agents pick
up their sessions.

## Install

On macOS and x86_64 Linux:

```sh
curl -fsSL https://novadeck.dev/install.sh | sh
```

For Windows and portable builds, see
[novadeck.dev/download](https://novadeck.dev/download?utm_source=readme).

Leave a ⭐ on your way out. It's your way back here, and someone else's way in.

## Docs

- [Guide](docs/guide.md): a short tour of how Novadeck works. The [reference](docs/reference.md) has every detail.
- [Development](docs/development.md): setup, repository map, tests and releases.
- [Contributing](CONTRIBUTING.md) · [Code style](CODING.md) · [Security](SECURITY.md)
- Found a bug or want something? [Open an issue](https://github.com/novadeck-org/novadeck/issues).

## License

[GPL-3.0-or-later](LICENSE). Contributions come in under the [CLA](CLA.md).
