import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { followLines } from "../follow.js"
import { json, marketplace, plugin, type Harness, type Install } from "../harness.js"
import { decode } from "./decode.js"
import { transcriptEvents } from "./transcript.js"

const id = "novadeck@novadeck"

const home = ({ env, home: user }: Install) => env.CLAUDE_CONFIG_DIR || join(user, ".claude")

// The hooks `decode` reads: the session, its turns, and the requests waiting on the person.
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
]

const hook = (platform: NodeJS.Platform, event: string): string =>
  platform === "win32"
    ? `if ($env:NOVADECK_HOOK) { & $env:NOVADECK_HOOK claude ${event} }`
    : `[ -n "$NOVADECK_HOOK" ] && "$NOVADECK_HOOK" claude ${event} || true`

export const claude = {
  id: "claude",
  plugin: "claude",
  // Claude Code's local install is an alias in the user's rc file, not on PATH.
  fallback: (user) => join(user, ".claude", "local", "claude"),
  home,
  connected: async (install) => {
    try {
      const settings = JSON.parse(await readFile(join(home(install), "settings.json"), "utf8")) as {
        enabledPlugins?: Record<string, unknown>
      }
      return settings.enabledPlugins?.[id] === true
    } catch {
      return false
    }
  },
  connect: ({ plugin: directory }) => [
    // A marketplace left from an earlier connection is replaced, not added twice.
    { argv: ["claude", "plugin", "marketplace", "remove", "novadeck"], optional: true },
    { argv: ["claude", "plugin", "marketplace", "add", directory] },
    { argv: ["claude", "plugin", "install", id] },
  ],
  disconnect: [
    { argv: ["claude", "plugin", "uninstall", id], optional: true },
    { argv: ["claude", "plugin", "marketplace", "remove", "novadeck"], optional: true },
  ],
  hook,
  files: (platform) => [
    { path: join(".claude-plugin", "marketplace.json"), content: marketplace },
    { path: join("novadeck", ".claude-plugin", "plugin.json"), content: json(plugin) },
    {
      path: join("novadeck", "hooks", "hooks.json"),
      content: json({
        hooks: Object.fromEntries(
          events.map((event) => [
            event,
            [
              {
                hooks: [
                  {
                    type: "command",
                    command: hook(platform, event),
                    ...(platform === "win32" && { shell: "powershell" }),
                  },
                ],
              },
            ],
          ]),
        ),
      }),
    },
  ],
  resume: (session) => ["claude", "--resume", session],
  decode,
  // The transcript records what no hook reports: an interrupted turn.
  watch: (run, signal, emit) =>
    followLines(run.transcript, signal, (line) => {
      for (const event of transcriptEvents(line, run)) emit(event)
    }),
} satisfies Harness
