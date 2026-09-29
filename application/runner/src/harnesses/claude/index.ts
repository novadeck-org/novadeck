import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { json, marketplace, plugin, type Harness, type Install } from "../harness.js"
import { decode } from "./decode.js"

const id = "novadeck@novadeck"

const home = ({ env, home: user }: Install) => env.CLAUDE_CONFIG_DIR || join(user, ".claude")

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
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: hook(platform, "SessionStart"),
                  ...(platform === "win32" && { shell: "powershell" }),
                },
              ],
            },
          ],
        },
      }),
    },
  ],
  resume: (session) => ["claude", "--resume", session],
  decode,
} satisfies Harness
