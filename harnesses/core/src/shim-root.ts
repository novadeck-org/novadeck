/**
 * How a shim holds the folder where agents' worktrees live (`machine.worktreesRoot`), which
 * Antigravity's passes to it as `--add-dir=<folder>` once the folder exists (Claude Code's names
 * it in its settings instead, `harnesses/claude/src/shim.ts`, and Codex's gives it as its
 * writable roots, `harnesses/codex/src/shim.ts`). The `=` form
 * takes that one value: Claude Code's `--add-dir <directories...>` would take a prompt after
 * it for another folder.
 *
 * Antigravity orders its workspaces, its own folder and those added, by path, byte for byte and
 * case and all, and tells the model the first is the working directory its commands run in, so
 * an added folder that sorts first takes the session's place (probed 2026-11-23, 1.5.13,
 * e2e/probes/agy-worktrees-folder.e2e.ts: `~/.novadeck/worktrees` ahead of a project in the
 * home, and always ahead of a worktree in it, as a folder sorts before what it holds). So the
 * folder goes in only where it sorts after the folder agy starts in, never from inside it;
 * elsewhere a session writing there is asked, as outside its workspace. Its own case stays: the
 * check of whether a file is in a workspace heeds case too, so a folder named in another case
 * holds none of the paths an agent is given.
 */

/** `value` as one word in sh: in single quotes, with each single quote closed and escaped. */
export const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** `value` where a batch file sets a variable in quotes: its percent signs doubled. */
export const cmdValue = (value: string): string => value.replaceAll("%", "%%")

/**
 * The lines of a POSIX shim that name the folder and set `novadeck_add` to the option, or
 * to nothing while the folder is no directory (or the machine names none), or doesn't sort after
 * the folder agy starts in (`$PWD`, which Go's working directory reads), as from inside it.
 */
export const posixAdd = (root: string | undefined): string =>
  [
    `novadeck_root=${root === undefined ? "" : shQuote(root)}`,
    "novadeck_add=",
    'if [ -n "$novadeck_root" ] && [ -d "$novadeck_root" ] && [ "$PWD" != "$novadeck_root" ] &&',
    `  [ "$(printf '%s\\n%s\\n' "$PWD" "$novadeck_root" | LC_ALL=C sort | head -n 1)" = "$PWD" ]; then`,
    "  novadeck_add=--add-dir=$novadeck_root",
    "fi",
  ].join("\n")

/**
 * The same for cmd: `novadeck_add` holds the option, quoted for the program's command line,
 * or nothing. The test with a trailing backslash is one only a directory passes. cmd orders
 * strings by the locale's rules, not bytes, so Novadeck's relay beside the shims' folder
 * answers whether the folder sorts after the shim's own (`novadeck-relay after`), and where it
 * can't answer, the folder isn't given.
 */
export const cmdAdd = (root: string | undefined): string =>
  [
    'set "novadeck_add="',
    ...(root === undefined
      ? []
      : [
          `set "novadeck_root=${cmdValue(root)}"`,
          'if exist "%novadeck_root%\\" "%~dp0..\\novadeck-relay.exe" after "%novadeck_root%" "%CD%" >nul 2>nul && set novadeck_add=--add-dir="%novadeck_root%"',
        ]),
  ].join("\n")
