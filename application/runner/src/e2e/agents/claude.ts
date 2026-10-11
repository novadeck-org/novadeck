import { readFileSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { anthropic } from "../model/anthropic.js"
import { asked, text as everything, type Call } from "../model/script.js"
import { gitBash } from "../sandbox.js"
import { own, result } from "../scenarios.js"
import type { AgentSetup } from "./agent.js"

// What the prompt of the background subagent a scenario starts holds, and nothing else.
const marker = "novadeck-e2e-background-work"

/**
 * Claude Code against the fake model: its own config folder in the sandbox, seeded past
 * onboarding, the theme picker, folder trust and the custom API key's approval, with
 * Novadeck's MCP tools allowed so a `send` asks nothing. Its permission mode is the
 * manual one, auto mode turned off: 2.1.287 defaults to auto mode, whose classifier
 * decides what asks, and shows a notice about its billing through a gateway, or with
 * `defaultMode` alone an offer to make it the default, either of which waits on Enter.
 */
export const claude: AgentSetup = {
  agent: "claude",
  name: "Claude Code",
  dialect: anthropic,
  // The name its first screen's header gives, beside its version.
  banner: "Claude Code",
  bindsAtReady: true,
  idleCommand: "/status",
  refused: [],
  watch: {
    searched: [
      ".claude/settings.json",
      ".claude/plugins/installed_plugins.json",
      ".claude/plugins/known_marketplaces.json",
    ],
    // Its projects, each named after its path with every other character a dash, which
    // keeps the sandbox's name whole: that holds only letters, digits and dashes.
    listed: [".claude/projects"],
    stamped: [],
  },
  hosts: ["api.anthropic.com", "claude.ai", "console.anthropic.com", "statsig.anthropic.com"],
  // A command that writes, which no setting allows: a read-only one such as `ls` runs
  // without asking. Its dialog's first option is selected as it shows, and "3", its "No",
  // refuses by its number alone, as Esc does, which also ends the turn: a key other than
  // Escape, so Novadeck must learn of the refusal from the harness, not the keystroke.
  approval: {
    request: () => ({
      calls: [
        {
          name: "Bash",
          input: { command: "touch approved.txt", description: "Make a file" },
        },
      ],
    }),
    shows: /❯ 1\. Yes/,
    deny: "3",
    denied: /Interrupted · What should Claude do instead\?/,
  },
  // AskUserQuestion, which takes several options of a question where it says so.
  asking: {
    multiSelect: true,
    questions: (_call, questions) => ({
      calls: [{ name: "AskUserQuestion", input: { questions } }],
    }),
  },
  // An MCP server registered in the project, which asks for a form through elicitation;
  // its tool is allowed, so only the form asks the person (probed 2026-10-06, 2.1.287).
  forms: {
    prepare: (sandbox, server) => {
      writeFileSync(
        join(sandbox.project, ".mcp.json"),
        JSON.stringify({ mcpServers: { elicit: { command: "node", args: [server] } } }),
      )
      const path = join(sandbox.home, ".claude", "settings.json")
      const settings = JSON.parse(readFileSync(path, "utf8")) as {
        permissions?: { allow?: string[] }
        enableAllProjectMcpServers?: boolean
      }
      settings.enableAllProjectMcpServers = true
      settings.permissions = {
        ...settings.permissions,
        allow: [...(settings.permissions?.allow ?? []), "mcp__elicit"],
      }
      writeFileSync(path, JSON.stringify(settings))
    },
    ask: () => ({ calls: [{ name: "mcp__elicit__elicit", input: {} }] }),
  },
  // Plan mode, as its settings seed it: the model writes the plan into the plans folder its
  // system prompt names, then calls ExitPlanMode, which asks "Would you like to proceed?".
  planning: {
    seed: (sandbox) => {
      const path = join(sandbox.home, ".claude", "settings.json")
      const settings = JSON.parse(readFileSync(path, "utf8")) as {
        permissions?: Record<string, unknown>
      }
      settings.permissions = { ...settings.permissions, defaultMode: "plan" }
      writeFileSync(path, JSON.stringify(settings))
    },
    rules: (_sandbox, prompt) => [
      own((call) => {
        const last = call.turns.at(-1)
        if (asked(call, prompt)) {
          // A POSIX path, or on Windows one with a drive and backslashes.
          const plans = everything(call).match(
            /(?:[A-Za-z]:)?[\\/][^\s"'`]*[\\/]plans[\\/][\w.-]+\.md/,
          )
          if (!plans) throw new Error("Claude Code's call names no plans file")
          return {
            calls: [
              {
                name: "Write",
                input: { file_path: plans[0], content: "# Plan\n\n1. Do the thing\n2. Test it\n" },
              },
            ],
          }
        }
        if (last?.role === "tool" && /File created|updated/.test(last.text))
          return { calls: [{ name: "ExitPlanMode", input: {} }] }
        return result(call) === undefined ? undefined : { text: "Planned." }
      }),
    ],
    approved: /User has approved your plan/,
  },
  // Escape before any reply came drops the turn and puts its prompt back in the box,
  // between the box's rules, with no word of the interruption (probed 2026-10-02, 2.1.287).
  interrupted: (prompt) =>
    new RegExp(`─\\n❯\\s+${prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n─`),
  // Esc-Esc opens its Rewind picker, a list with no text field, which swallows a paste
  // whole and stays as it was (probed 2026-10-02, 2.1.287).
  rewind: { shows: /Restore the code and\/or conversation to the point before/, swallows: true },
  // Its cost warning, a menu raised once a turn has ended with the session's cost at $5 or
  // more, which it shows a key's user only as a billing admin (seeded `popup: true`).
  // 300k output tokens cost Opus 5.5 over $5; its context meter counts input tokens alone,
  // so nothing compacts (probed 2026-10-02, 2.1.287).
  popup: {
    reply: (text) => ({ text, usage: { outputTokens: 300_000 } }),
    shows: /You've spent \$5 on the Anthropic API this session\.[\s\S]*❯ 1\. Got it, thanks!/,
  },
  // A subagent run in the background: its Stop lists it as a running background task, and
  // once it finishes Claude Code starts a turn by itself, with a task notification.
  background: {
    start: () => ({
      calls: [
        {
          name: "Agent",
          input: {
            description: "Background work",
            prompt: `${marker}: reply when done.`,
            subagent_type: "general-purpose",
            run_in_background: true,
          },
        },
      ],
    }),
    // Its conversation opens with that prompt; the root's never does, though its later
    // turns may quote it, as a task notification can.
    owns: (call: Call) =>
      !call.side &&
      (call.turns.find((turn) => turn.role === "user")?.text.includes(marker) ?? false),
    // Its Bash tool's own background run, which its Stop lists as a running `shell` task,
    // and whose end starts a turn with a task notification too (probed 2026-10-04, 2.1.289).
    command: (_call, command) => ({
      calls: [
        {
          name: "Bash",
          input: { command, description: "Run a command", run_in_background: true },
        },
      ],
    }),
  },
  // Its Bash tool, running its own print mode, which its settings allow (`Bash(claude -p:*)`).
  shell: {
    run: (_call, command) => ({
      calls: [{ name: "Bash", input: { command, description: "Run a command" } }],
    }),
    nested: (prompt) => `claude -p '${prompt}'`,
  },
  // `--resume --fork-session` picks the session to fork in its "Resume session" picker,
  // each session named by its first prompt. Its `/fork` copies the conversation into a
  // background session and keeps the terminal's (probed again 2026-10-03, 2.1.287): the
  // terminal stays bound to its session, Drafting after the command as after any Enter
  // that started no turn; the background session's own turn (`/fork <prompt>`) doesn't
  // rebind it, and a message sent then waits for the terminal's own. That session runs
  // under a daemon with no terminal, which outlives the deck, and its agents view's
  // ctrl+x didn't end it.
  fork: {
    picker: {
      command: "claude --resume --fork-session",
      picked: (prompt) => new RegExp(`❯ ${prompt}`),
    },
  },
  // Its folder-trust question shows "No, exit" selected, trusting the folder below it.
  trust: {
    folder: {
      shows: /Is this a project you created or one you trust\?/,
      select: "\x1b[B",
      trusts: /❯ Yes, I trust this folder/,
    },
  },
  absent: {
    "fork.inPlace":
      "its /fork doesn't fork in place: it copies the conversation into a background session and the terminal keeps its own, whose binding stays; that session's daemon outlives the terminal, so the suite can't run it (probed 2026-10-03, 2.1.287)",
    "trust.hooks":
      "it runs a plugin's hooks with no review: every scenario's session binds unasked (2.1.287)",
  },
  prepare: async (sandbox, model, installed, seed = {}) => {
    const config = join(sandbox.home, ".claude")
    await mkdir(config, { recursive: true, mode: 0o700 })
    // With CLAUDE_CONFIG_DIR set, Claude Code keeps its global state in the folder too.
    await writeFile(
      join(config, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: installed.version,
        lastReleaseNotesSeen: installed.version,
        theme: "dark",
        autoUpdates: false,
        officialMarketplaceAutoInstall: false,
        // It asks once about a key from the environment, by the key's last 20 characters.
        customApiKeyResponses: { approved: [model.credential.slice(-20)], rejected: [] },
        // An account with a billing admin's role, for whom it warns of the session's cost.
        ...(seed.popup && {
          oauthAccount: { organizationRole: "admin", workspaceRole: "workspace_admin" },
        }),
        // Keyed by the project's path, which on Windows it writes with forward slashes.
        projects: Object.fromEntries(
          [...new Set([sandbox.project, sandbox.project.replaceAll("\\", "/")])].map((path) => [
            path,
            {
              hasTrustDialogAccepted: seed.folderTrusted ?? true,
              hasCompletedProjectOnboarding: true,
              projectOnboardingSeenCount: 1,
              allowedTools: [],
            },
          ]),
        ),
      }),
    )
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify({
        permissions: {
          // Its own print mode, so `shell` runs a nested Claude Code unasked.
          allow: ["mcp__plugin_novadeck_novadeck", "Bash(claude -p:*)"],
          defaultMode: "default",
          disableAutoMode: "disable",
        },
      }),
    )
    // On Windows it runs its Bash tool in Git for Windows' bash, and won't start without.
    const bash = process.platform === "win32" ? gitBash() : undefined
    if (process.platform === "win32" && bash === undefined)
      throw new Error("Claude Code on Windows needs Git for Windows' bash, beside git on PATH")
    return {
      ...(bash !== undefined && { CLAUDE_CODE_GIT_BASH_PATH: bash }),
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_BASE_URL: model.url,
      ANTHROPIC_API_KEY: model.credential,
      DISABLE_AUTOUPDATER: "1",
      DISABLE_UPDATES: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    }
  },
}
