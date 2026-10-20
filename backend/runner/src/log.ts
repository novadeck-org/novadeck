import { consoleLogger, switchableLogger, type Logger } from "@novadeck/log"

/**
 * The runner's log. Modules take theirs when they load (`logs.for("messaging")`); lines go to
 * the console, warnings and errors alone, until the process that runs the runner gives it a
 * file with `useLogger`, as the desktop app does.
 */
export const logs = switchableLogger(consoleLogger())

/** Sends the runner's lines to `logger` from now on. */
export const useLogger = (logger: Logger): void => logs.use(logger)
