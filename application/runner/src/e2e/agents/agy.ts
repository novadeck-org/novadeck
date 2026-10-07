import { readdirSync, statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { gemini } from "../model/gemini.js"
import { asked, type Call } from "../model/script.js"
import { own } from "../scenarios.js"
import type { AgentSetup } from "./agent.js"

// The folder its commands run in, as its system prompt names it: a command must run there.
const workingDirectory = (call: Call): string => {
  const folder = /^Command Working Directory: (.+)$/m.exec(call.system)?.[1]
  if (!folder) throw new Error("Antigravity's system prompt names no command working directory")
  return folder
}

// What a subagent's system prompt holds and its root's doesn't (probed 2026-10-02, 1.2.14).
const subagent = "<subagent_reminder>"

/**
 * Antigravity against the fake model: its own folder in the sandbox's `~/.gemini`, seeded
 * past onboarding and its colour-scheme picker and trusting the project, and set to the
 * Gemini API with a key, as it runs without signing in. Signed in with Google it speaks
 * Code Assist instead, but takes its models only from an account's plan, which a fake
 * login can't name, so it never gets as far as a model call. Its updater is off.
 * Seeded with `folderTrusted: false`, it trusts no folder, and asks first. Its hooks need
 * no trust, so `hooksTrusted` changes nothing.
 */
export const agy: AgentSetup = {
  agent: "agy",
  name: "Antigravity",
  dialect: gemini,
  banner: "Antigravity CLI",
  bindsAtReady: false,
  // Its own status screen (probed 2026-10-04, 1.2.14).
  idleCommand: "/help",
  // Its feature flags and its telemetry.
  refused: ["antigravity-unleash.goog", "play.googleapis.com"],
  watch: {
    searched: [".gemini/antigravity-cli/settings.json"],
    // Its MCP servers' folder, which it rewrites each time it starts.
    listed: [".gemini/antigravity-cli/mcp"],
    // Where Novadeck installs its plugin, and its own plugin data and programs.
    stamped: [
      ".gemini/config/plugins",
      ".gemini/antigravity-cli/plugin_data",
      ".gemini/antigravity-cli/bin",
    ],
  },
  hosts: [
    "generativelanguage.googleapis.com",
    "cloudcode-pa.googleapis.com",
    "daily-cloudcode-pa.googleapis.com",
    "oauth2.googleapis.com",
    "accounts.google.com",
    "www.googleapis.com",
  ],
  // `run_command` asks before it runs anything no setting allows, as "Run this command?",
  // its first choice, running it, selected; its fourth, "No, cancel", is picked by its
  // number alone. A denial ends the turn.
  approval: {
    request: (call) => ({
      calls: [
        {
          name: "run_command",
          input: {
            CommandLine: "echo approved",
            Cwd: workingDirectory(call),
            WaitMsBeforeAsync: 5000,
            toolSummary: "Echo",
            toolAction: "Echoing",
          },
        },
      ],
    }),
    shows: /> 1\. Yes, run command/,
    deny: "4",
    denied: /User declined the tool call/,
  },
  // ask_question, which takes several options where it says so.
  asking: {
    multiSelect: true,
    questions: (_call, questions) => ({
      calls: [
        {
          name: "ask_question",
          input: {
            questions: questions.map((question) => ({
              question: question.question,
              options: question.options.map(({ label }) => label),
              is_multi_select: question.multiSelect,
            })),
            toolSummary: "Question",
            toolAction: "Asking",
          },
        },
      ],
    }),
  },
  // A plan is an artifact written for review (RequestFeedback), in the folder of the
  // conversation, the newest one under its `brain` (probed 2026-10-06, 1.2.14).
  planning: {
    rules: (sandbox, prompt) => [
      own((call) => {
        if (!asked(call, prompt)) return undefined
        const brain = join(sandbox.home, ".gemini", "antigravity-cli", "brain")
        const newest = readdirSync(brain)
          .map((name) => ({ name, at: statSync(join(brain, name)).mtimeMs }))
          .toSorted((a, b) => b.at - a.at)[0]
        if (!newest) throw new Error("Antigravity has no artifact folder yet")
        return {
          calls: [
            {
              name: "write_to_file",
              input: {
                TargetFile: join(brain, newest.name, "implementation_plan.md"),
                Overwrite: true,
                CodeContent: "# Plan\n\n1. Do the thing\n2. Test the thing\n",
                Description: "Writes the plan",
                ArtifactMetadata: {
                  Summary: "A plan to do and test the thing",
                  UserFacing: true,
                  RequestFeedback: true,
                },
                toolSummary: "Plan",
                toolAction: "Planning",
              },
            },
          ],
        }
      }),
      own((call) => (call.turns.at(-1)?.role === "tool" ? { text: "Planned." } : undefined)),
    ],
    approved: /\[Approved\] implementation_plan\.md/,
  },
  // `run_command` running its own print mode, which its settings allow (`command(agy -p)`).
  // It waits at most 10 s for the command, its range's top (500 to 10000 ms; 30000 waited
  // 10 s too, probed 2026-10-03, 1.2.14), then backgrounds it; a nested run takes under a
  // second.
  shell: {
    run: (call, command) => ({
      calls: [
        {
          name: "run_command",
          input: {
            CommandLine: command,
            Cwd: workingDirectory(call),
            WaitMsBeforeAsync: 10_000,
            toolSummary: "Run a command",
            toolAction: "Running",
          },
        },
      ],
    }),
    nested: (prompt) => `agy -p '${prompt}'`,
  },
  // `/fork` forks in place, its status line naming the fork, saying "Forked conversation"
  // and how to go back (probed 2026-10-03, 1.2.14).
  fork: { inPlace: "/fork" },
  // Escape mid-turn says so (probed 2026-10-02, 1.2.14).
  interrupted: () => /⎿ {2}Interrupted · What should Antigravity CLI do instead\?/,
  // A subagent of its own type `self` runs in a conversation of its own, its model calls
  // told by its system prompt. The root's turn ends while it runs, its Stop saying it isn't
  // fully idle, and the subagent's end wakes it with a message saying it went idle.
  background: {
    start: () => ({
      calls: [
        {
          name: "invoke_subagent",
          input: {
            Subagents: [
              { TypeName: "self", Role: "Background helper", Prompt: "Work in the background." },
            ],
            toolSummary: "Background helper",
            toolAction: "Starting a helper",
          },
        },
      ],
    }),
    owns: (call) => call.system.includes(subagent),
    // `run_command` waiting its least, 500 ms, then backgrounding the command: its Stop
    // says it isn't fully idle, its status line lists no subagent, and the command's end
    // wakes it with a message (probed 2026-10-04, 1.2.14).
    command: (call, command) => ({
      calls: [
        {
          name: "run_command",
          input: {
            CommandLine: command,
            Cwd: workingDirectory(call),
            WaitMsBeforeAsync: 500,
            toolSummary: "Run a command",
            toolAction: "Running",
          },
        },
      ],
    }),
  },
  // "Do you trust the contents of this project?", its status line initializing meanwhile,
  // with trusting it selected.
  trust: {
    folder: {
      shows: /> Yes, I trust this folder/,
      select: "",
      trusts: /> Yes, I trust this folder/,
    },
  },
  absent: {
    forms: "it shows no MCP elicitation form to answer (probed 2026-10-06, 1.2.14)",
    "fork.picker":
      "no command line forks a conversation: its flags only resume one (`--conversation`, `--continue`), and its fork is the in-place /fork (probed 2026-10-03, 1.2.14)",
    popup:
      "nothing shows after a turn on its Gemini API route, the screen still for 15 s, and its program holds no dialog for after one; its quota screens belong to the Code Assist route (probed 2026-10-02, 1.2.14)",
    rewind:
      "Esc-Esc opens nothing; its rewind is the typed /rewind command, which Untouched covers (probed 2026-10-02, 1.2.14)",
    "trust.hooks":
      "it runs a plugin's hooks with no review: every scenario's session binds unasked (1.2.14)",
  },
  prepare: async (sandbox, model, _installed, seed) => {
    const home = join(sandbox.home, ".gemini", "antigravity-cli")
    await mkdir(home, { recursive: true, mode: 0o700 })
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({
        onboardingComplete: true,
        trustedWorkspaces: seed?.folderTrusted === false ? [] : [sandbox.project],
        modelProvider: "gemini",
        // Novadeck's MCP tools run without asking, so a `send` needs no approval (its
        // plugin's server is namespaced after the plugin).
        // Its own print mode too, so `shell` runs a nested Antigravity unasked.
        permissions: { allow: ["mcp(novadeck_novadeck/*)", "command(agy -p)"] },
      }),
    )
    return {
      GEMINI_API_KEY: model.credential,
      GOOGLE_GEMINI_BASE_URL: model.url,
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    }
  },
}
