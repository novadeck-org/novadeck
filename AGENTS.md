# Read First

Before changing this repository, read each file in this list:

- [README.md](README.md) for the project's scope and setup.
- [CODING.md](CODING.md) for code and test style.
- [CONTRIBUTING.md](CONTRIBUTING.md) for issues and pull requests.
- [SECURITY.md](SECURITY.md) for credentials and security findings.

# Harness Parity

Every agent feature works the same in Claude Code, Codex and Antigravity. When one
harness lacks the signal a feature relies on, find and probe that harness's own
equivalent: a hook, its transcript or rollout, its status line, or the screen. Don't
ship a feature for some harnesses and leave the others behind. A gap no source can close
is a blocker to raise with the person, not an exception to record and move past.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
