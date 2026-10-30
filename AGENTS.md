# Read First

Before changing this repository, read each file in this list:

- [README.md](README.md) for what Novadeck is.
- [docs/development.md](docs/development.md) for setup, the repository map and releases.
- [CODING.md](CODING.md) for code and test style.
- [CONTRIBUTING.md](CONTRIBUTING.md) for issues and pull requests.
- [SECURITY.md](SECURITY.md) for credentials and security findings.

# Harness Parity

Every agent feature works the same in Claude Code, Codex and Antigravity. When one
harness lacks the signal a feature relies on, find and probe that harness's own
equivalent: a hook, its transcript or rollout, its status line, or the screen. Don't
ship a feature for some harnesses and leave the others behind. A gap no source can close
is a blocker to raise with the person, not an exception to record and move past.

# Demo Debug Panel

Every state a feature adds to the UI MUST be reachable on the demo backend, so it can be
seen and checked in isolation without a runner: through normal use, a `?demo=` variant,
or the demo's debug panel (`pnpm dev:previews`, the Debug handle in the footer's middle).
When the demo can't produce a new state yet — a dialog, an error, a badge, a tab or
window phase, a backend field it never sets — add it in the same change:

- Terminal, waiting-agent and picker states go in `frontend/demo-debug/src/states.ts`,
  with pure action builders in `frontend/demo-debug/src/terminals.ts`; an Inbox row of a kind no demo agent
  makes goes in `frontend/demo/src/inbox-fixtures.ts`, with its action in
  `frontend/demo-debug/src/inbox.ts`. A new tab or window phase also
  joins the "Every state at once" gallery there.
- An agent's state is one of `demoTurns`' verbs (`work`, `ask`, `finish`, `rest`, `usage`), never a
  status the panel dispatches, so the chat, the screen and the Inbox
  follow it: add a verb or an option there, and an action that calls it: in the panel's "Agent"
  group on the group's target, or, for a setting such as usage, in "Agent fixtures" on
  the selected terminal. Only a display-only fixture, as an unheard agent,
  patches the terminal's metadata, and any action that sets a terminal's state other than
  through a verb calls `verbs.release(key)` first, so no timer of its agent undoes it.
- Startup, boot-failure, runner (connection, crash loop) and sandbox states go in `frontend/demo-debug/src/shell-groups.ts`.
- Every group names its `section` (Terminals, Agents or App), and an action that boots
  the demo again sets `reboots: true` instead of saying so in its hint.
- Give each action a hint that names what appears, and keep "Debug panel" in docs/development.md
  current.

# Architecture Briefs

Before changing, reviewing or explaining a part of the code, run
`pnpm -s atlas:brief <subject>` for a short brief of it: an area token such as
`backend/runner/terminals`, a procedure, a UI action or a table (no subject: the index). Name
areas by those tokens when you report or plan. See [tools/atlas/AGENTS.md](tools/atlas/AGENTS.md).

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
