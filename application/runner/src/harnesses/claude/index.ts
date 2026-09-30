import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { followLines } from "../follow.js"
import { json, marketplace, plugin, type Harness, type Install } from "../harness.js"
import { decode } from "./decode.js"
import { posixShim } from "./shim.js"
import { transcriptEvents } from "./transcript.js"
import { transcripts } from "./transcripts.js"

const id = "novadeck@novadeck"

/** Claude Code's configuration folder, which also keeps its plans in `plans`. */
export const configFolder = ({ env, home: user }: Pick<Install, "env" | "home">): string =>
  env.CLAUDE_CONFIG_DIR || join(user, ".claude")

// The hooks `decode` reads: the session, its turns, and the requests waiting on the person.
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
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
  home: configFolder,
  connected: async (install) => {
    try {
      const settings = JSON.parse(
        await readFile(join(configFolder(install), "settings.json"), "utf8"),
      ) as {
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
    // The settings NovaDeck's shim adds: its hook as the status line, which passes on the
    // person's own (see shell/hook.ts).
    ...(platform === "win32"
      ? []
      : [
          {
            path: "statusline.json",
            content: json({
              statusLine: { type: "command", command: hook(platform, "StatusLine"), padding: 0 },
            }),
          },
        ]),
  ],
  // The status line NovaDeck's shim adds, where its shells run Claude Code; Windows keeps
  // the person's own until the shim and its status line are proven there.
  shims: (platform) =>
    platform === "win32" ? [] : [{ path: "claude", content: posixShim, mode: 0o700 }],
  resume: (session) => ["claude", "--resume", session],
  transcripts,
  // Its hooks, transcript and status line; see docs/harness-coverage.md.
  coverage: {
    session: "partial",
    activity: "partial",
    attention: "partial",
    actors: "partial",
    transcripts: "partial",
    planning: "partial",
    usage: "unsupported",
    limits: "partial",
    context: "partial",
  },
  decode,
  // The transcript records what no hook reports: an interrupted turn.
  watch: (run, signal, emit) =>
    followLines(run.transcript, signal, (line) => {
      for (const event of transcriptEvents(line, run)) emit(event)
    }),
} satisfies Harness
