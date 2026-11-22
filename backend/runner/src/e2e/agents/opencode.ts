import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { Sandbox } from "../keychain.js"
import { anthropic } from "../model/anthropic.js"
import { asked, text as everything } from "../model/script.js"
import { own, result } from "../scenarios.js"
import type { AgentSetup } from "./agent.js"

// A nested run of its own non-interactive mode, asked `prompt`.
const nested = (prompt: string): string => `opencode run '${prompt}'`

/**
 * Adds a free model of opencode's own to the sandbox's configuration, on the fake model as the
 * seeded one is: the tour runs on one (`opencode/<name>-free`), which opencode's list holds
 * only where its configuration names it, and the launch must never reach opencode's own.
 */
export const freeModel = async (sandbox: Pick<Sandbox, "env" | "home">): Promise<void> => {
  const folder = join(sandbox.env.XDG_CONFIG_HOME ?? join(sandbox.home, ".config"), "opencode")
  const path = join(folder, "opencode.json")
  const config = JSON.parse(await readFile(path, "utf8")) as {
    provider: Record<string, Record<string, unknown>>
  }
  config.provider.opencode = {
    ...config.provider.fake,
    name: "opencode",
    models: {
      "e2e-free": {
        name: "E2E Free",
        tool_call: true,
        reasoning: false,
        attachment: true,
        limit: { context: 200_000, output: 32_000 },
      },
    },
  }
  await writeFile(path, JSON.stringify(config))
  // Novadeck lists models from opencode's cached catalog of models.dev, which none has yet in a
  // sandbox: an empty one, whose providers the configuration then names alone.
  const cache = join(sandbox.env.XDG_CACHE_HOME ?? join(sandbox.home, ".cache"), "opencode")
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, "models.json"), "{}")
}

/**
 * opencode against the fake model: a global configuration in the sandbox's XDG config
 * folder (never `OPENCODE_CONFIG_CONTENT`, which Novadeck's shim sets to load its plugin and
 * a person's own content must survive) with a custom provider on its bundled
 * `@ai-sdk/anthropic`, which speaks the fake model's Anthropic dialect, and its updater, its
 * sharing and its model catalogue's fetch off. It has no login, onboarding or trust screen.
 * Its bash tool asks before every command but its own non-interactive run, so `approval`
 * has a command to refuse, and `shell` one it runs unasked.
 */
export const opencode: AgentSetup = {
  agent: "opencode",
  name: "opencode",
  dialect: anthropic,
  // Its header shows no name: its first screen holds its logo and the box's hint.
  banner: /Ask anything|opencode/,
  bindsAtReady: false,
  keepsHookText: true,
  // It tries to install its plugin package into each configuration folder it loads from
  // (probed 2026-11-22, 1.19.6); the fake model's proxy refuses the tunnel.
  refused: ["registry.npmjs.org"],
  watch: {
    searched: [".config/opencode/opencode.json"],
    listed: [".local/share/opencode", ".local/state/opencode"],
    stamped: [],
  },
  // Where it would otherwise go: Anthropic, its own site and its model catalogue.
  hosts: ["api.anthropic.com", "opencode.ai", "models.dev"],
  credentials: [],
  // A command no rule allows asks as "△ Permission required", its first choice, "Allow
  // once", selected; ←/→ move between the three and Enter takes one. Reject is the third:
  // Right twice. It ends the turn, with no word of its own on the screen beyond the dialog
  // going and the turn's footer (`▣ Build · Fake Sonnet`) staying (probed 2026-11-22, 1.19.6).
  approval: {
    request: () => ({
      calls: [{ name: "bash", input: { command: "touch approved.txt" } }],
    }),
    shows: /△ Permission required/,
    yes: /^Allow once$/,
    no: /^Reject$/,
    deny: "\x1b[C\x1b[C",
    denied: /^(?![\s\S]*Permission required)[\s\S]*▣ +Build · Fake Sonnet/,
  },
  // Its `question` tool, which takes several options where it says `multiple`.
  asking: {
    multiSelect: true,
    questions: (_call, questions) => ({
      calls: [
        {
          name: "question",
          input: {
            questions: questions.map(({ question, header, options, multiSelect }) => ({
              question,
              header,
              options,
              multiple: multiSelect,
            })),
          },
        },
      ],
    }),
  },
  // Its plan agent (Tab switches to it) may only read; with its experimental plan mode the
  // model writes the plan into the data folder's `plans` (named in its prompt) and calls
  // `plan_exit`, which asks whether to build it, as a question (probed 2026-11-22, 1.19.6).
  planning: {
    enter: async (terminal) => {
      await terminal.press("\t")
    },
    rules: (_sandbox, prompt) => [
      own((call) => {
        const last = call.turns.at(-1)
        if (asked(call, prompt)) {
          // A POSIX path, or on Windows one with a drive and backslashes.
          const plans = everything(call).match(
            /(?:[A-Za-z]:)?[\\/][^\s"'`]*[\\/]plans[\\/][\w.-]+\.md/,
          )
          if (!plans) throw new Error("opencode's call names no plans file")
          return {
            calls: [
              {
                name: "write",
                input: { filePath: plans[0], content: "# Plan\n\n1. Do the thing\n2. Test it\n" },
              },
            ],
          }
        }
        if (last?.role === "tool" && /Wrote file successfully/.test(last.text))
          return { calls: [{ name: "plan_exit", input: {} }] }
        return result(call) === undefined ? undefined : { text: "Planned." }
      }),
    ],
    approved: /User has approved this plan/,
  },
  // Its bash tool, running its own non-interactive mode, which a rule of the seed allows. It
  // waits for the command (its `timeout` is optional).
  shell: {
    run: (_call, command) => ({ calls: [{ name: "bash", input: { command } }] }),
    nested,
  },
  // A pasted image file's path becomes `[Image 1]` in the box and an image of the prompt, which
  // the model takes where its entry says it reads images (`modalities`), as the seed does.
  image: { shows: "[Image 1]", inline: false, alone: true },
  // Its status dialog, which submits nothing to the model.
  idleCommand: "/status",
  // A prompt given mid-turn shows as sent, with a `QUEUED` badge under it, once its hooks ran
  // (probed 2026-11-22, 1.19.6, with a prompt hook slowed to 4 s: nothing showed of the prompt,
  // the box empty, until the hook ended; so no screen says its hooks are running: no `queueing`).
  queued: (prompt) =>
    new RegExp(`┃ +${prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n\\s*┃ +QUEUED`),
  interrupted: () => /▣ .*· interrupted/,
  prepare: async (sandbox, model, _installed, seed) => {
    const config = join(sandbox.env.XDG_CONFIG_HOME ?? join(sandbox.home, ".config"), "opencode")
    await mkdir(config, { recursive: true, mode: 0o700 })
    await writeFile(
      join(config, "opencode.json"),
      JSON.stringify({
        autoupdate: false,
        share: "disabled",
        model: "fake/fake-sonnet",
        small_model: "fake/fake-sonnet",
        // Nothing of Novadeck's: its plugin adds its MCP tools' rule. Every command asks but
        // its own non-interactive run, which a later rule allows (the last match wins).
        permission: { bash: { "*": "ask", "opencode run *": "allow" } },
        provider: {
          fake: {
            npm: "@ai-sdk/anthropic",
            name: "Fake",
            options: { baseURL: `${model.url}/v1`, apiKey: model.credential },
            models: {
              "fake-sonnet": {
                name: "Fake Sonnet",
                tool_call: true,
                reasoning: false,
                attachment: true,
                modalities: { input: ["text", "image"], output: ["text"] },
                limit: { context: 200_000, output: 32_000 },
              },
            },
          },
        },
      }),
    )
    return {
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_EXPERIMENTAL_PLAN_MODE: "1",
      // Novadeck's plugin never loads: the case of a person who left its hooks off.
      ...(seed?.hooksTrusted === false && { OPENCODE_PURE: "1" }),
    }
  },
  absent: {
    background:
      "it has no background subagents: its `task` tool's schema takes no background flag and its call runs inside the turn (probed 2026-11-22, 1.19.6)",
    "background.command":
      "its bash tool's schema is `command`, `timeout` and `workdir`, with no background run: it waits for the command (probed 2026-11-22, 1.19.6)",
    pluginCopy:
      "it keeps no copy of Novadeck's plugin in its home: the shim names the runner's own file for each launch (1.19.6)",
    forms:
      'its MCP client answers an elicitation request with "Method not found" (-32601) and shows no form (probed 2026-11-22, 1.19.6)',
    "fork.picker":
      "`--fork` (with `--session <id>` or `--continue`) forks that session at once: there is no picker of sessions to choose from (probed 2026-11-22, 1.19.6)",
    "fork.inPlace":
      "its /fork opens a \"Fork session\" dialog (the full session, or from a message) that a second Enter confirms, which a scenario's one-line command can't give (probed 2026-11-22, 1.19.6)",
    rewind:
      "Esc-Esc at an idle prompt opens nothing: its Escape interrupts a running turn, and its undo is the typed /undo (1.19.6)",
    "trust.folder": "it asks to trust no folder: any project opens at its prompt (1.19.6)",
    "trust.hooks":
      "it loads Novadeck's plugin with no review: every scenario's session binds unasked (1.19.6)",
    popup:
      "nothing shows after a turn but its footer, and its program raises no menu by itself (1.19.6)",
  },
}
