/**
 * The JavaScript of Novadeck's opencode TUI plugin, which opencode loads in its terminal
 * interface beside the server plugin (`plugin-source.ts`) through a `tui.json` the shim names
 * for the launch (`OPENCODE_TUI_CONFIG`). The server plugin hears opencode's events, but
 * `/new` (and its alias `/clear`) is a route change of the interface alone: it goes home, and no
 * session exists until the next prompt, so no event tells the terminal's session ended (probed
 * 2026-11-22, 1.19.6: none came). The interface's plugin API holds the route (`api.route.current`,
 * `{ name: "home" }` or `{ name: "session", params: { sessionID } }`, probed on 1.19.6 with
 * the route read every 100 ms), so this one reports `SessionLeft` for the session the route
 * left when it goes home. It does nothing at start, where the route is home with nothing left.
 * It reports each session shown since the route was last home, a subagent's view among them, and
 * the runner ends a binding only for the session it names.
 */

/** What one rendering holds. */
export type TuiPluginConfig = {
  /** Novadeck's hook command for `SessionLeft`, in the platform's shell. */
  readonly hook: string
  /** How long the hook may run before the plugin stops waiting, in milliseconds. */
  readonly hookMs: number
}

/** The TUI plugin's module for `config`, as opencode imports it. */
export const tuiPluginSource = (config: TuiPluginConfig): string =>
  `// Novadeck's TUI plugin for opencode. Written by Novadeck into its own data directory and
// overwritten on each start; opencode loads it only in Novadeck's terminals, for one launch.
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const config = ${JSON.stringify(config)}
${body}`

const body = String.raw`
// Where it marks a session left, for the server plugin, which runs in another thread of the same
// process: it binds that session again when the person goes back to it (plugin-source.ts, bind).
const left = join(dirname(fileURLToPath(import.meta.url)), "left")

// Runs the hook command with the session left on its input; nothing outside Novadeck's terminals.
const report = (id) => {
  if (!process.env.NOVADECK_HOOK) return
  try {
    mkdirSync(left, { recursive: true })
    writeFileSync(join(left, id), "")
  } catch {}
  try {
    const child = spawn(config.hook, { shell: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
    }, config.hookMs)
    child.on("close", () => clearTimeout(timer))
    child.on("error", () => clearTimeout(timer))
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionLeft", session_id: id, cwd: process.cwd() }))
  } catch {}
}

export default {
  id: "novadeck",
  tui: async (api) => {
    try {
      // Every session shown since the route was last home: a subagent's view (Ctrl-X Down) is
      // a session route of its own, so going home from there leaves its root too, which the
      // runner tells apart, as it ends only the binding of the session it names.
      let shown = new Set()
      const look = () => {
        try {
          const route = api.route.current
          if (route?.name === "session" && typeof route.params?.sessionID === "string") {
            shown.add(route.params.sessionID)
          } else if (route?.name === "home" && shown.size > 0) {
            const gone = [...shown]
            shown = new Set()
            for (const id of gone) report(id)
          }
        } catch {}
      }
      look()
      const timer = setInterval(look, 150)
      api.lifecycle?.onDispose?.(() => clearInterval(timer))
    } catch {}
  },
}
`
