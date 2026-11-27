import { programWord } from "@novadeck/terminal/shell"

import { novaProgram } from "./launcher.js"

/**
 * A startup command that starts Nova by its word (`novaProgram`, as the runner stores it), with
 * that word turned into its launcher's path in the form `shell` runs (`programWord`); any other
 * command is as it was.
 */
export const novaStartup = (command: string, shell: string, launcher: string): string =>
  command === novaProgram || command.startsWith(`${novaProgram} `)
    ? `${programWord(shell, launcher)}${command.slice(novaProgram.length)}`
    : command
