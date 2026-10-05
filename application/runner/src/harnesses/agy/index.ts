import { access } from "node:fs/promises"
import { join } from "node:path"

import {
  hookSeconds,
  json,
  mcpServer,
  plugin,
  type MessagingProfile,
  type Harness,
  type Install,
} from "../harness.js"
import { decode, shown } from "./decode.js"
import { statusLineSettings, trustsFolder } from "./settings.js"
import { transcripts, typedEntry } from "./transcripts.js"

// Antigravity keeps its own state beside other Google tools in ~/.gemini.
const gemini = (home: string) => join(home, ".gemini")
const cli = ({ home: user }: Install) => join(gemini(user), "antigravity-cli")

// Antigravity reads every hook's answer as JSON, even outside Novadeck's shells. It
// denies a tool whose PreToolUse answer says nothing, so registering PreToolUse needs an
// answer of "ask" here too, in a form cmd passes on intact; none is registered yet.
const hook = (platform: NodeJS.Platform, event: string): string =>
  platform === "win32"
    ? `if defined NOVADECK_HOOK (%NOVADECK_HOOK% agy ${event}) else (echo {})`
    : `if [ -n "$NOVADECK_HOOK" ]; then "$NOVADECK_HOOK" agy ${event}; else echo '{}'; fi`

// A Stop continued with a reason gets it as a lasting system step. A message injected at
// a model call lasts only for that call, so a turn's delivery is injected again on each
// of its later calls. Every other answer is an empty object.
const messaging: MessagingProfile = {
  asks: { Stop: "stop", PreInvocation: "prompt" },
  silent: { PreToolUse: '{"decision":"ask"}\n', "*": "{}\n" },
  stop: (delivery) => `${JSON.stringify({ decision: "continue", reason: delivery })}\n`,
  prompt: (delivery) => `${JSON.stringify({ injectSteps: [{ ephemeralMessage: delivery }] })}\n`,
  reinjectPerCall: true,
  root: "status-line",
  silentOnFailure: false,
  // `-i` submits its prompt about 0.9 s after it starts, even while its "Do you trust
  // this folder?" dialog is up, so only in a folder it already trusts.
  initialPrompt: async (line, { install, cwd }) =>
    install && (await trustsFolder(cli(install), cwd)) ? ["agy", "-i", line] : undefined,
  start: ["agy"],
  // Its hooks name no prompt, but its transcript tells what was typed (a USER_EXPLICIT
  // USER_INPUT step) from what woke it: a subagent's message, a Stop hook's continuation
  // or a notice are SYSTEM_MESSAGE steps, and injected messages EPHEMERAL_MESSAGE ones.
  typedEntry,
}

// A handler for one of its events, with the time it may take.
const handler = (platform: NodeJS.Platform, event: string) => ({
  type: "command",
  command: hook(platform, event),
  timeout: hookSeconds,
})

export const agy = {
  id: "agy",
  // Antigravity installs a plugin folder, which its name must match.
  plugin: join("agy", "novadeck"),
  home: cli,
  connected: ({ home }) =>
    access(join(gemini(home), "config", "plugins", "novadeck", "plugin.json")).then(
      () => true,
      () => false,
    ),
  connect: ({ plugin: directory }) => [
    { argv: ["agy", "plugin", "uninstall", "novadeck"], optional: true },
    { argv: ["agy", "plugin", "install", directory] },
  ],
  disconnect: [{ argv: ["agy", "plugin", "uninstall", "novadeck"], optional: true }],
  hook,
  // Antigravity runs PreInvocation hooks before each model call, the first time with the
  // conversation's first message, Stop once the turn ends, and PostToolUse after each
  // tool, which names the artifacts it writes, as a plan.
  files: (platform, launchers) => [
    { path: "plugin.json", content: json({ name: plugin.name }) },
    // Its MCP server, which Antigravity takes from the plugin and starts with the
    // terminal's environment.
    {
      path: "mcp_config.json",
      content: json({ mcpServers: { novadeck: mcpServer(launchers) } }),
    },
    {
      path: "hooks.json",
      content: json({
        novadeck: {
          PreInvocation: [handler(platform, "PreInvocation")],
          Stop: [handler(platform, "Stop")],
          // Tool events take matcher groups: only the tool that writes artifacts.
          PostToolUse: [{ matcher: "write_to_file", hooks: [handler(platform, "PostToolUse")] }],
        },
      }),
    },
  ],
  // Its status line tells what no hook does: working or idle, a confirmation waiting on
  // the person, and its context and quotas.
  settings: statusLineSettings(cli),
  resume: (session) => ["agy", "--conversation", session],
  transcripts,
  // Its hooks and status line, which name no subagents; see docs/harness-coverage.md.
  // A background subagent's end wakes it with a message saying it went idle.
  wakes: true,
  coverage: {
    session: "partial",
    activity: "partial",
    attention: "partial",
    actors: "unsupported",
    transcripts: "partial",
    planning: "partial",
    usage: "unsupported",
    limits: "partial",
    context: "partial",
  },
  decode,
  shown,
  messaging,
} satisfies Harness
