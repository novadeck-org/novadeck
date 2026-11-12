/**
 * How a shim holds the folder where agents' worktrees live (`machine.worktreesRoot`), which
 * it passes to its harness as `--add-dir=<folder>` once the folder exists. The `=` form
 * takes that one value: Claude Code's `--add-dir <directories...>` would take a prompt after
 * it for another folder.
 */

/** `value` as one word in sh: in single quotes, with each single quote closed and escaped. */
export const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** `value` where a batch file sets a variable in quotes: its percent signs doubled. */
export const cmdValue = (value: string): string => value.replaceAll("%", "%%")

/**
 * The lines of a POSIX shim that name the folder and set `novadeck_add` to the option, or
 * to nothing while the folder is no directory (or the machine names none).
 */
export const posixAdd = (root: string | undefined): string =>
  [
    `novadeck_root=${root === undefined ? "" : shQuote(root)}`,
    "novadeck_add=",
    '[ -n "$novadeck_root" ] && [ -d "$novadeck_root" ] && novadeck_add=--add-dir=$novadeck_root',
  ].join("\n")

/**
 * The same for cmd: `novadeck_add` holds the option, quoted for the program's command line,
 * or nothing. The test with a trailing backslash is one only a directory passes.
 */
export const cmdAdd = (root: string | undefined): string =>
  [
    'set "novadeck_add="',
    ...(root === undefined
      ? []
      : [
          `set "novadeck_root=${cmdValue(root)}"`,
          'if exist "%novadeck_root%\\" set novadeck_add=--add-dir="%novadeck_root%"',
        ]),
  ].join("\n")
