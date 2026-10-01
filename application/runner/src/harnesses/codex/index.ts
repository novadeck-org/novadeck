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
} from "../harness.js"
import { decode } from "./decode.js"
import { followRollout } from "./rollout.js"
import { cmdShim, posixShim } from "./shim.js"
import { startedSession, title } from "./title.js"
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
  "PostToolUse",
]

const hook = (platform: NodeJS.Platform, event: string): string =>
  platform === "win32"
    ? `if defined NOVADECK_HOOK %NOVADECK_HOOK% codex ${event}`
    : `[ -n "$NOVADECK_HOOK" ] && "$NOVADECK_HOOK" codex ${event} || true`

// A Stop's reason continues the turn as a user-role hook prompt, which the delivery's
// wrapper still attributes to its sender; a prompt's context is a developer message.
const messaging: MessagingProfile = {
  asks: { Stop: "stop", UserPromptSubmit: "prompt" },
  silent: () => "",
  stop: (delivery) => `${JSON.stringify({ decision: "block", reason: delivery })}\n`,
  prompt: (delivery) =>
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: delivery },
    })}\n`,
  reinjectPerCall: false,
  root: "binding",
  queueKey: "\t",
  silentOnFailure: true,
  // It holds a command-line prompt behind its trust and startup screens.
  initialPrompt: (line) => Promise.resolve(["codex", line]),
  start: ["codex"],
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
          novadeck: { ...mcpServer(platform, launchers), env_vars: [...mcpVariables] },
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
                hooks: [{ type: "command", command: hook(platform, event), timeout: hookSeconds }],
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
  // Its hooks and rollout; see docs/harness-coverage.md.
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
  title,
  startedSession,
  hooksTrusted,
  // Where it keeps its threads' locks and its configuration, and how it is found.
  environment: ["PATH", "HOME", "CODEX_HOME"],
  messaging,
  // The rollout records the session's tokens and the account's rate-limit windows, each
  // turn's mode and the plans it proposes.
  watch: followRollout,
} satisfies Harness
