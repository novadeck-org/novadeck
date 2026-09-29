import { access } from "node:fs/promises"
import { join } from "node:path"

import { json, plugin, sessionStart, type Harness } from "../harness.js"

// Antigravity keeps its own state beside other Google tools in ~/.gemini.
const gemini = (home: string) => join(home, ".gemini")

const hook = (platform: NodeJS.Platform): string =>
  platform === "win32"
    ? "if defined NOVADECK_HOOK (%NOVADECK_HOOK% agy) else (echo {})"
    : `if [ -n "$NOVADECK_HOOK" ]; then "$NOVADECK_HOOK" agy; else echo '{}'; fi`

export const agy = {
  id: "agy",
  // Antigravity installs a plugin folder, which its name must match.
  plugin: join("agy", "novadeck"),
  home: ({ home }) => join(gemini(home), "antigravity-cli"),
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
  // conversation's first message.
  files: (platform) => [
    { path: "plugin.json", content: json({ name: plugin.name }) },
    {
      path: "hooks.json",
      content: json({
        novadeck: { PreInvocation: [{ type: "command", command: hook(platform) }] },
      }),
    },
  ],
  resume: (session) => ["agy", "--conversation", session],
  // A PreInvocation payload names no source: it only says the conversation runs.
  continuity: sessionStart,
} satisfies Harness
