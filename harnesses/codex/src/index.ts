import { readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  hookSeconds,
  json,
  marketplace,
  mcpServer,
  mcpVariables,
  plugin,
  type MessagingProfile,
  type Harness,
  type Install,
} from "@novadeck/harness-core/harness"
import { hookCommand, type Dialect } from "@novadeck/harness-core/hook-command"

import { box } from "./box.js"
import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { readModels } from "./models.js"
import { followRollout, followSubagent, rolloutPlans } from "./rollout.js"
import { cmdShim, posixShim } from "./shim.js"
import { startedSession, title, titleWorking } from "./title.js"
import { transcripts } from "./transcripts.js"
import { hooksTrusted } from "./trust.js"

const id = "novadeck@novadeck"

const home = ({ env, home: user }: Install) => env.CODEX_HOME || join(user, ".codex")

// The hooks `decode` reads: the session, its turns, and the requests waiting on the person.
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
  "PreToolUse",
  "PostToolUse",
]

// Codex runs an Interrupt hook for 3 seconds at most, and warns at every start of a plugin
// that asks for longer (0.159.3, `normalize_command_hook`), which hides its first screen's
// logo behind the warning's banner. The hook reports an Interrupt within 2 seconds.
const interruptSeconds = 3

// On Windows Codex runs a hook command in its shell there, PowerShell (7 where installed),
// not cmd (probed 2026-10-09, 0.159.3), with -NoProfile.
const hookDialect = (platform: NodeJS.Platform): Dialect =>
  platform === "win32" ? "powershell" : "sh"

// Without Novadeck it needs nothing printed. Codex asks the person to review its hooks
// again whenever this text changes, so `hooks.test.ts` pins it.
const hook = (platform: NodeJS.Platform, event: string): string =>
  hookCommand(hookDialect(platform), { agent: "codex", event })

// A Stop's reason continues the turn as a user-role hook prompt, which the delivery's
// wrapper still attributes to its sender; a prompt's context is a developer message, and
// so is a PostToolUse's, which the model reads on its next request.
const messaging: MessagingProfile = {
  asks: { Stop: "stop", UserPromptSubmit: "prompt", PostToolUse: "tool" },
  silent: { "*": "" },
  stop: (delivery) => `${JSON.stringify({ decision: "block", reason: delivery })}\n`,
  prompt: (delivery) =>
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: delivery },
    })}\n`,
  call: (delivery, event) =>
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: delivery } })}\n`,
  reinjectPerCall: false,
  root: "binding",
  queueKey: "\t",
  silentOnFailure: true,
  // A spawned agent running, the root idle, it took a typed prompt (fixture
  // `background-prompt.probe.json`, probed 2026-10-19, 0.163.0).
  promptsInBackground: true,
  // It holds a command-line prompt behind its trust and startup screens.
  initialPrompt: (line) => Promise.resolve(["codex", line]),
  start: ["codex"],
  // Its cache of the models it lists, in its home; the effort is a config override, left
  // bare (codex reads a value that isn't TOML as a string), so it has no quotes of its own.
  models: (install) => readModels(home(install)),
  choose: ({ model, effort }) => [
    ...(model !== undefined ? ["--model", model] : []),
    ...(effort !== undefined ? ["-c", `model_reasoning_effort=${effort}`] : []),
  ],
}

export const codex = {
  id: "codex",
  plugin: "codex",
  home,
  connected: async (install) =>
    /\[plugins\."novadeck@novadeck"\][^[]*?\benabled\s*=\s*true/.test(
      await readFile(join(home(install), "config.toml"), "utf8").catch(() => ""),
    ),
  connect: ({ plugin: directory }) => [
    { argv: ["codex", "plugin", "marketplace", "remove", "novadeck"], optional: true },
    { argv: ["codex", "plugin", "marketplace", "add", directory] },
    { argv: ["codex", "plugin", "add", id] },
  ],
  disconnect: [
    { argv: ["codex", "plugin", "remove", id], optional: true },
    { argv: ["codex", "plugin", "marketplace", "remove", "novadeck"], optional: true },
  ],
  hookDialect,
  hook,
  files: (platform, launchers) => [
    { path: join(".claude-plugin", "marketplace.json"), content: marketplace },
    {
      path: join("novadeck", ".codex-plugin", "plugin.json"),
      content: json({ ...plugin, hooks: "./hooks/hooks.json", mcpServers: "./.mcp.json" }),
    },
    // Its MCP server. Codex starts MCP servers without the terminal's environment, so
    // the variables that name the terminal are passed on by name.
    {
      path: join("novadeck", ".mcp.json"),
      content: json({
        mcpServers: {
          novadeck: { ...mcpServer(launchers), env_vars: [...mcpVariables] },
        },
      }),
    },
    {
      path: join("novadeck", "hooks", "hooks.json"),
      content: json({
        hooks: Object.fromEntries(
          events.map((event) => [
            event,
            [
              {
                ...(event === "SessionStart" && { matcher: "startup|resume|clear|compact|fork" }),
                // Only the two tools that ask the person without a PermissionRequest.
                ...(event === "PreToolUse" && {
                  matcher: "request_user_input|request_permissions",
                }),
                hooks: [
                  {
                    type: "command",
                    command: hook(platform, event),
                    timeout: event === "Interrupt" ? interruptSeconds : hookSeconds(platform),
                  },
                ],
              },
            ],
          ]),
        ),
      }),
    },
  ],
  // Interactive Codex runs its sessions, and their hooks, in a shared background server
  // that knows nothing of the terminal it was started from; see `./shim.ts`.
  shims: (platform) =>
    platform === "win32"
      ? [{ path: "codex.cmd", content: cmdShim }]
      : [{ path: "codex", content: posixShim, mode: 0o700 }],
  resume: (session) => ["codex", "resume", session],
  transcripts,
  plans: rolloutPlans,
  // Its hooks and rollout; see docs/harness-coverage.md.
  // Nothing it starts wakes it once its turn has ended (probed 2026-10-02, 0.159.3): a
  // subagent or a command left running finishes with the root idle.
  wakes: false,
  records: true,
  coverage: {
    session: "partial",
    activity: "partial",
    attention: "partial",
    actors: "partial",
    transcripts: "partial",
    planning: "partial",
    usage: "unsupported",
    limits: "complete",
    context: "partial",
  },
  decode,
  dialogs,
  title,
  titleWorking,
  startedSession,
  hooksTrusted,
  // Where it keeps its threads' locks and its configuration, and how it is found.
  environment: ["PATH", "HOME", "CODEX_HOME"],
  messaging,
  box,
  // The rollout records the session's tokens and the account's rate-limit windows, each
  // turn's mode and the plans it proposes.
  watch: followRollout,
  // A subagent's rollout records Esc on its request, which no hook reports.
  watchActor: followSubagent,
} satisfies Harness
