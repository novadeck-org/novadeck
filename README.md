<p align="center">
  <a href="https://novadeck.dev/?utm_source=readme">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg" />
      <img src="docs/assets/logo-light.svg" alt="Novadeck" height="56" />
    </picture>
  </a>
</p>

<p align="center">
  <strong>An agentic development environment for Claude Code, Codex, Antigravity, OpenCode and Pi.</strong><br />
  Run a bunch of agents at once, in real terminals, and actually keep up with them.<br />
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
  <a href="docs/guide.md#connect-your-agents"><img src="https://novadeck.dev/badge/agents.svg" alt="Agents: Claude Code, Codex, Antigravity, OpenCode and Pi" /></a>
  <br />
  <a href="https://novadeck.dev/download?utm_source=readme"><img src="https://novadeck.dev/badge/runs-on.svg" alt="Runs on macOS, Windows and Linux" /></a>
  <a href="https://novadeck.dev/privacy?utm_source=readme"><img src="https://novadeck.dev/badge/privacy.svg" alt="Privacy: no account, no telemetry" /></a>
  <a href="LICENSE"><img src="https://novadeck.dev/badge/license.svg" alt="License: GPL-3.0-or-later" /></a>
</p>

<p align="center">
  <a href="https://youtu.be/m3utO-zBN-k">▶ Watch the 2-minute tour</a>
</p>

I run like four or five coding agents a day. The agents are fine. Keeping up with them was NOT.
Tab, tab, tab to find the one that's waiting, copy-pasting answers between them, no idea which
branch had what. So now I use Novadeck.

It runs the agent CLIs you already have, on your own accounts. And it's not tmux with extra
steps: Novadeck knows what each agent is doing, so it can tell you who's waiting and pass their
messages around. All it adds is a small plugin to each agent. Your settings stay yours, and
outside Novadeck the plugin does nothing.

On macOS and x86_64 Linux:

```sh
curl -fsSL https://novadeck.dev/install.sh | sh
```

For Windows and portable builds, see
[novadeck.dev/download](https://novadeck.dev/download?utm_source=readme).

## See who needs you

<p align="center">
  <img src="docs/assets/highlights/glance.webp" alt="The terminal list marks each agent working, asking, failed or done. Then the same terminals in Focus, one big; on the Canvas, all at once; and tiled in the Grid." width="100%" />
</p>

Every terminal says if its agent is working, asking, failed or done. I see who wants me without
opening anything. Focus for one, Canvas for all of them, Grid to tile.

## Answer them where you are

<p align="center">
  <img src="docs/assets/highlights/inbox.webp" alt="Three asks land on the Canvas: a command to run, a plan to approve and a question. Each shows in the Inbox. Opened from there, the command gets Yes, the plan Yes, manually approve edits, and the question its recommended answer, the customer's account. Each agent goes back to work." width="100%" />
</p>

Permission prompts, plans, questions. They all land in the Inbox. I answer from there, usually in
one click, and the agent's back at it.

## Stop being the meat proxy

<p align="center">
  <img src="docs/assets/highlights/teams.webp" alt="Orders API, a Claude Code lead, opens three teammates, wired to it on the Canvas. Cart endpoint asks which API version to call, in the Inbox and to its lead. The lead answers first, and the ask leaves the Inbox on its own. Pricing endpoint reports done, to its lead and to the Inbox." width="100%" />
</p>

Half the stuff they ask me is really for another agent. Here they message each other by handle,
and one can start its own teammates and lead them. The lead gets their questions too and usually
answers before I even look. Claude Code, Codex, Antigravity, OpenCode and Pi, all on one team.

## Keep their work apart

<p align="center">
  <img src="docs/assets/highlights/worktrees.webp" alt="The Worktrees panel lists every agent's worktree with its pull request, checks and handle. Orders API's three teammates hang under it. A check turns green, and Cart endpoint's pull request opens." width="100%" />
</p>

Each agent makes its own git worktree, so nobody edits over anybody, and my checkout stays mine,
which tbh was the main thing. The Worktrees panel has the PR, the checks and who's on it, and
cleans up after the merge.

## See what they're changing

<p align="center">
  <img src="docs/assets/highlights/files.webp" alt="The Files panel shows the project's tree while the agents write: each file marked with the agent writing it, new files arriving as they're made." width="100%" />
</p>

The Files panel shows all their changes in one tree, live, each file marked with who's on it.
Two of them going for the same file? I know before git does.

## Where'd it save that?

<p align="center">
  <img src="docs/assets/highlights/show.webp" alt="Order status page, an agent, shows its page in the pane beside its terminal, then its changes as diffs, then an image, a video, a PDF invoice, a 3D model, a CSV as a table and a folder of screenshots." width="100%" />
</p>

Whatever an agent makes opens right next to its terminal. A page, a diff, an image, a video, a PDF,
a 3D model, a CSV, a whole folder even. No more digging for where it saved stuff.

## Drop me a ⭐

> [!IMPORTANT]
> It's just me out here. No team, no ad budget, not much sleep. Building all of this anyway.\
> Stars are how anyone finds it, and they keep me going. Think it's preem? You know what to do.
>
> Stay nova, choom ✦

## License

[GPL-3.0-or-later](LICENSE). Contributions come in under the [CLA](CLA.md).
