import { ownProgram } from "@novadeck/harness-pi/bundled"
import { programWord } from "@novadeck/terminal/shell"

/**
 * A startup command that starts Novadeck's own pi by its word (`ownProgram`, as the runner stores
 * it), with that word turned into its launcher's path in the form `shell` runs (`programWord`); any
 * other command is as it was.
 */
export const ownPiStartup = (command: string, shell: string, launcher: string): string =>
  command === ownProgram || command.startsWith(`${ownProgram} `)
    ? `${programWord(shell, launcher)}${command.slice(ownProgram.length)}`
    : command
