import type { Terminal } from "@xterm/xterm"

/**
 * Writes `data` to the terminal, resolving once it is parsed. Rejects when parsing it threw,
 * as a buffer whose rows went missing does: what the screen shows is then in doubt, so its
 * owner draws it afresh. The patch makes xterm skip a chunk that threw, and hand the error to
 * that chunk's callback; unpatched, every write after it waited forever. The headless
 * screens' `written` resolves all the same.
 */
export const writeTo = (terminal: Terminal, data: string): Promise<void> =>
  new Promise((resolve, reject) =>
    terminal.write(data, ((error?: unknown) =>
      error === undefined ? resolve() : reject(error)) as () => void),
  )
