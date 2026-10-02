import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { gemini } from "../model/gemini.js"
import type { Call } from "../model/script.js"
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
  // Its feature flags and its telemetry.
  refused: ["antigravity-unleash.goog", "play.googleapis.com"],
  watch: {
    searched: [".gemini/antigravity-cli/settings.json"],
    // Its MCP servers' folder, which it rewrites each time it starts.
    listed: [".gemini/antigravity-cli/mcp"],
    // Where NovaDeck installs its plugin, and its own plugin data and programs.
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
        // NovaDeck's MCP tools run without asking, so a `send` needs no approval (its
        // plugin's server is namespaced after the plugin).
        permissions: { allow: ["mcp(novadeck_novadeck/*)"] },
      }),
    )
    return {
      GEMINI_API_KEY: model.credential,
      GOOGLE_GEMINI_BASE_URL: model.url,
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    }
  },
}
