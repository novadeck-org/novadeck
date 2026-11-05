/**
 * The line the person is typing, followed from the keys sent to the terminal, to tell a
 * submitted line that is an exit command. Characters add to it, Backspace removes one, and
 * Ctrl+U, Ctrl+C and Ctrl+W empty it. Any other control key or escape sequence may bring
 * text in that the keys don't show (history, completion, a menu, a paste), so the line is
 * unknown (null) until the next Enter. A best match: a miss only costs the grace an end
 * waits (see `endWaitMs`).
 */
export const afterTyped = (
  typed: string | null,
  data: string,
): { readonly typed: string | null; readonly entered: string | null } => {
  let line = typed
  let entered: string | null = null
  for (const char of data) {
    if (char === "\r" || char === "\n") {
      entered = line
      line = ""
    } else if (char === "\u007f" || char === "\b") line = line === null ? null : line.slice(0, -1)
    else if (char === "\u0015" || char === "\u0003" || char === "\u0017") line = ""
    else if (char < " " || char === "\u007f") line = null
    else if (line !== null) line += char
  }
  return { typed: line, entered }
}
