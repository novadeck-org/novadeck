import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { chat } from "../model/chat.js"
import type { AgentSetup } from "./agent.js"

// A nested run of its own non-interactive mode, asked `prompt`.
const nested = (prompt: string): string => `pi -p '${prompt}'`

/** Its agent folder in the sandbox's home, where `~/.pi/agent` is for the person (never theirs). */
const agentFolder = (home: string): string => join(home, ".pi", "agent")

/**
 * pi against the fake model: the sandbox's `~/.pi/agent/models.json` names a provider on its
 * `openai-completions` API, which the fake model's chat completions dialect speaks, and its
 * `settings.json` picks that model, so it opens at its prompt with no sign-in, trust or update
 * screen (probed 2026-11-24, 1.6.0). `PI_OFFLINE` keeps its model catalogue, its update check
 * and its first-run download of `fd` from the network. Novadeck's own extension comes in through
 * the shim's `-e`, as for a person; nothing here writes it.
 *
 * Provisional until a first run on the fake model: the traits below are from the phase 1 probes.
 */
export const pi: AgentSetup = {
  agent: "pi",
  name: "pi",
  dialect: chat,
  // Its footer shows the model and thinking level (`fake-sonnet • medium`) from the first draw.
  banner: /fake-sonnet/,
  // Its extension's session start comes as it starts, before any prompt (to confirm).
  bindsAtReady: true,
  // What a delivery leaves in the session stays in its later model calls: a `custom_message`
  // entry of its transcript.
  keepsHookText: true,
  refused: [],
  watch: {
    searched: [".pi/agent/settings.json", ".pi/agent/models.json"],
    listed: [".pi/agent/sessions"],
    stamped: [],
  },
  // Where it would otherwise go: the providers it knows by name, and its own site.
  hosts: ["api.openai.com", "api.anthropic.com", "openrouter.ai", "pi.dev"],
  credentials: [],
  // The one Escape that aborts a turn prints `Operation aborted` in its transcript.
  interrupted: () => /Operation aborted/,
  // While a turn runs, its top rule holds a spinner and `Working`.
  running: /Working/,
  // A prompt given mid-turn shows dim above the box as `Steering: <prompt>`, until the turn's
  // tool calls end (probed 2026-11-24, 1.6.0, busy.probe.json `steerQueued`).
  queued: (prompt) => new RegExp(`Steering: ${prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  // Its `/session` prints the session's file, id and usage in the transcript, with no model call.
  idleCommand: "/session",
  // Its `/settings` opens a menu over the box, which the live-slice test closes with Escape.
  view: "/settings",
  shell: {
    run: (_call, command) => ({ calls: [{ name: "bash", input: { command } }] }),
    nested,
  },
  prepare: async (sandbox, model, installed) => {
    const folder = agentFolder(sandbox.home)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await writeFile(
      join(folder, "models.json"),
      JSON.stringify({
        providers: {
          fake: {
            name: "Fake",
            baseUrl: `${model.url}/v1`,
            api: "openai-completions",
            apiKey: model.credential,
            models: [
              {
                id: "fake-sonnet",
                name: "Fake Sonnet",
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 200_000,
                maxTokens: 8192,
                cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
              },
            ],
          },
        },
      }),
    )
    await writeFile(
      join(folder, "settings.json"),
      JSON.stringify({
        defaultProvider: "fake",
        defaultModel: "fake-sonnet",
        // No changelog banner for the version run.
        lastChangelogVersion: installed.version,
      }),
    )
    return {
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    }
  },
  // Its steering gives queued prompts one at a time, each answered before the next (its
  // default `steeringMode`, probed 2026-11-24, 1.6.0).
  oneByOne: true,
  absent: {
    approval:
      "it asks nothing before a tool runs: its docs say it does not ask for approval before every tool call, and an extension's dialog is the person's own (docs/security.md, 1.6.0)",
    questions: "it has no question tool of its own: an extension may draw a select (1.6.0)",
    multiSelect: "it has no question tool of its own (1.6.0)",
    plan: "it has no plan mode: its README says it skips sub-agents and plan mode (1.6.0)",
    forms: "it has no form dialogs of its own: its MCP client takes none (to confirm)",
    background: "it has no background subagents: it skips sub-agents (README, 1.6.0)",
    "background.command":
      "its bash tool takes `command` and `timeout` alone: it waits for the command (docs, 1.6.0)",
    "trust.hooks":
      "it loads Novadeck's extension, passed with `-e`, with no review: every scenario's session binds unasked (1.6.0)",
    "trust.folder":
      "it asks to trust a folder only where the project holds `.pi` resources; the e2e project holds none (probed 2026-11-24, 1.6.0)",
    pluginCopy:
      "it keeps no copy of Novadeck's extension in its home: the shim passes the runner's own file for each launch",
    image:
      "it attaches no image in its editor: a pasted image path stays text in the prompt (probed 2026-11-24, 1.6.0, image.probe.json)",
    popup: "nothing shows after a turn but its footer (probed 2026-11-24, 1.6.0)",
    rewind:
      "Escape at an idle prompt does nothing; its `/tree` and `/fork` are typed commands (docs, 1.6.0)",
    "fork.picker":
      "`--fork` takes a session id or path: there is no picker of sessions to choose from at start (docs/cli.md, 1.6.0)",
    "fork.inPlace":
      "its /fork and /clone open a picker of earlier messages that a second Enter confirms, which a scenario's one-line command can't give (docs/sessions.md, 1.6.0)",
  },
}
