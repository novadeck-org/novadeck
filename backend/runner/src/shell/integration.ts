import { delimiter, join } from "node:path"

import { shellLaunch as launch, type ShellLaunch } from "@novadeck/terminal/shell"

import type { InstalledShell } from "./install.js"
import { onPath } from "./open-shims.js"

/**
 * How to start a shell with Novadeck's integration; see the library's `shellLaunch`. Every
 * shell gets the hook's launcher in NOVADECK_HOOK, the MCP server's in NOVADECK_MCP (on
 * Linux and macOS, as `installShellFiles` gives it), and with `shims` the connected
 * harnesses whose shims, as Codex's, go first on PATH.
 *
 * The `startup` command is an agent's resume, plain words from the harness's `resume`, or
 * the command line a new terminal was opened with.
 */
/** What a scoped terminal's environment gains for the shims in `open`, from `env`'s own. */
const opening = (open: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  NOVADECK_OPEN: open,
  PATH: env.PATH ? `${open}${delimiter}${env.PATH}` : open,
  ...(!env.BROWSER && onPath("xdg-open", env.PATH) && { BROWSER: join(open, "xdg-open") }),
})

export const shellLaunch = (
  shell: string,
  paths: InstalledShell,
  env: NodeJS.ProcessEnv,
  {
    shims = [],
    startup,
    scoped,
  }: {
    readonly shims?: readonly string[]
    readonly startup?: { readonly command: string; readonly file: string } | undefined
    readonly scoped?: boolean | undefined
  } = {},
  platform: NodeJS.Platform = process.platform,
): ShellLaunch =>
  // Connected agents' hooks name the launcher through NOVADECK_HOOK; see `hookCommand`.
  // On Linux and macOS their MCP server starts from NOVADECK_MCP, so it is this
  // runner's relay whichever build connected them; see `mcpStart`.
  // With shims, their folder goes first on PATH, and the integration puts it back
  // there after the person's startup files. NOVADECK_SHIMS names the harnesses whose shims
  // apply; any other shim there runs its program unchanged.
  // In a scope of its own, as on Linux with the user's systemd, what `xdg-open`, `gio open` and
  // `BROWSER` open gets one of its own too (`openShims`): their folder goes first on PATH,
  // NOVADECK_OPEN names it, and BROWSER names its `xdg-open` where the person names no browser
  // of their own and a real one is there.
  launch({
    shell,
    scripts: paths,
    env: {
      ...env,
      NOVADECK_HOOK: paths.launcher,
      ...(paths.mcpLauncher !== undefined && {
        NOVADECK_MCP: paths.mcpLauncher,
      }),
      ...(shims.length > 0 && { NOVADECK_SHIMS: shims.join(" ") }),
      ...(scoped === true && platform === "linux" && opening(paths.open, env)),
    },
    pathFirst: shims.length > 0 ? paths.bin : undefined,
    startup,
    scoped,
    // On Windows cmd waits for its job through the relay, which waits for the scope's file.
    ...(platform === "win32" && { waiter: paths.relay }),
    platform,
  })
