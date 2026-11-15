/**
 * The line by which a shim tells Novadeck it is starting its agent: the private OSC 6973 that
 * libraries/terminal reads (`launchOf` in its shell/osc.ts), naming the terminal it runs in and
 * the program. It finds an agent typed in a shell where the platform names no foreground
 * process, as on Windows, where ConPTY names only the shell, and on macOS, where an installed
 * Claude Code is named by its version. A shim says it only as it starts a session, never for
 * the harness's other commands.
 */

/**
 * For a POSIX shim: the report on the terminal itself, never on stdout, which a pipe may be
 * reading, and only with the person's keys on stdin, as an agent's own tool shell has none.
 * `2>/dev/null` comes first, so a terminal that can't be opened says nothing.
 */
export const posixLaunch = (program: string): string =>
  `[ -t 0 ] && printf '\\033]6973;launch;%s;${program}\\033\\\\' "$NOVADECK_TERMINAL_ID" 2>/dev/null >/dev/tty`

/**
 * For a cmd shim: the same on the console, `con`, with no line break, as `set /p` prints its
 * prompt alone; the ESCs are written into the file as they are. cmd can't tell whether its
 * input is the person's, so Novadeck takes only the first report after a prompt. `2>nul` comes
 * first here too, so a process with no console says nothing.
 */
export const cmdLaunch = (program: string): string =>
  `<nul set /p "=\u001b]6973;launch;%NOVADECK_TERMINAL_ID%;${program}\u001b\\" 2>nul >con`
