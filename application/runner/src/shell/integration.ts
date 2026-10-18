import { shellLaunch as launch, type ShellLaunch } from "@novadeck/terminal/shell"

import type { InstalledShell } from "./install.js"

/**
 * How to start a shell with Novadeck's integration; see the library's `shellLaunch`. Every
 * shell gets the hook's launcher in NOVADECK_HOOK, the MCP server's in NOVADECK_MCP (on
 * Linux and macOS, as `installShellFiles` gives it), and with `shims` the connected
 * harnesses whose shims, as Codex's, go first on PATH.
 *
 * The `startup` command is an agent's resume, plain words from the harness's `resume`, or
 * the command line a new terminal was opened with.
 */
export const shellLaunch = (
  shell: string,
  paths: InstalledShell,
  env: NodeJS.ProcessEnv,
  {
    shims = [],
    startup,
  }: {
    readonly shims?: readonly string[]
    readonly startup?: { readonly command: string; readonly file: string } | undefined
  } = {},
): ShellLaunch =>
  // Connected agents' hooks name the launcher through NOVADECK_HOOK; see `hookCommand`.
  // On Linux and macOS their MCP server starts from NOVADECK_MCP, so it is this
  // runner's relay whichever build connected them; see `mcpStart`.
  // With shims, their folder goes first on PATH, and the integration puts it back
  // there after the user's startup files. NOVADECK_SHIMS names the harnesses whose shims
  // apply; any other shim there runs its program unchanged.
  launch({
    shell,
    scripts: paths,
    env: {
      ...env,
      NOVADECK_HOOK: paths.launcher,
      ...(paths.mcpLauncher !== undefined && { NOVADECK_MCP: paths.mcpLauncher }),
      ...(shims.length > 0 && { NOVADECK_SHIMS: shims.join(" ") }),
    },
    pathFirst: shims.length > 0 ? paths.bin : undefined,
    startup,
  })
