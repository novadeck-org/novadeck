import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { json, marketplace, plugin, type Harness, type Install } from "../harness.js"
import { decode } from "./decode.js"
import { cmdShim, posixShim } from "./shim.js"

const id = "novadeck@novadeck"

const home = ({ env, home: user }: Install) => env.CODEX_HOME || join(user, ".codex")

const hook = (platform: NodeJS.Platform, event: string): string =>
  platform === "win32"
    ? `if defined NOVADECK_HOOK %NOVADECK_HOOK% codex ${event}`
    : `[ -n "$NOVADECK_HOOK" ] && "$NOVADECK_HOOK" codex ${event} || true`

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
  files: (platform) => [
    { path: join(".claude-plugin", "marketplace.json"), content: marketplace },
    {
      path: join("novadeck", ".codex-plugin", "plugin.json"),
      content: json({ ...plugin, hooks: "./hooks/hooks.json" }),
    },
    {
      path: join("novadeck", "hooks", "hooks.json"),
      content: json({
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume|clear|compact",
              hooks: [{ type: "command", command: hook(platform, "SessionStart") }],
            },
          ],
        },
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
  decode,
} satisfies Harness
