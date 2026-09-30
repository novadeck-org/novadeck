import { access } from "node:fs/promises"
import { join } from "node:path"

import { json, plugin, type Harness, type Install } from "../harness.js"
import { decode } from "./decode.js"
import { statusLineSettings } from "./settings.js"

// Antigravity keeps its own state beside other Google tools in ~/.gemini.
const gemini = (home: string) => join(home, ".gemini")
const cli = ({ home: user }: Install) => join(gemini(user), "antigravity-cli")

// Antigravity reads every hook's answer as JSON, even outside NovaDeck's shells. It
// denies a tool whose PreToolUse answer says nothing, so registering PreToolUse needs an
// answer of "ask" here too, in a form cmd passes on intact; none is registered yet.
const hook = (platform: NodeJS.Platform, event: string): string =>
  platform === "win32"
    ? `if defined NOVADECK_HOOK (%NOVADECK_HOOK% agy ${event}) else (echo {})`
    : `if [ -n "$NOVADECK_HOOK" ]; then "$NOVADECK_HOOK" agy ${event}; else echo '{}'; fi`

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
  // conversation's first message, and Stop once the turn ends.
  files: (platform) => [
    { path: "plugin.json", content: json({ name: plugin.name }) },
    {
      path: "hooks.json",
      content: json({
        novadeck: {
          PreInvocation: [{ type: "command", command: hook(platform, "PreInvocation") }],
          Stop: [{ type: "command", command: hook(platform, "Stop") }],
        },
      }),
    },
  ],
  // Its status line tells what no hook does: working or idle, a confirmation waiting on
  // the person, and its context and quotas.
  settings: statusLineSettings(cli),
  resume: (session) => ["agy", "--conversation", session],
  // Its hooks and status line, which name no subagents; see docs/harness-coverage.md.
  coverage: {
    session: "partial",
    activity: "partial",
    attention: "partial",
    actors: "unsupported",
    transcripts: "unsupported",
    planning: "partial",
    usage: "unsupported",
    limits: "partial",
    context: "partial",
  },
  decode,
} satisfies Harness
