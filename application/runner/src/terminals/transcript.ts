import type { SerializeAddon } from "@xterm/addon-serialize"
import type { Terminal } from "@xterm/headless"

/**
 * The screen and scrollback as text that draws them again, within `limit` characters:
 * older scrollback goes first. The alternate screen and terminal modes stay out, so
 * showing it again cannot leave a fresh shell in a full-screen program's state.
 */
export const transcriptOf = (
  screen: Terminal,
  serializer: SerializeAddon,
  limit: number,
): string | null => {
  let scrollback = screen.buffer.normal.baseY
  while (true) {
    const text = serializer.serialize({ scrollback, excludeAltBuffer: true, excludeModes: true })
    if (text.length <= limit) return text.trim() ? text : null
    if (scrollback === 0) return null
    scrollback = Math.floor(scrollback / 2)
  }
}

const dim = (text: string): string => `\x1b[0;2m${text}\x1b[0m`

const written = (screen: Terminal, data: string): Promise<void> =>
  new Promise((resolve) => screen.write(data, resolve))

/**
 * Shows a transcript on a fresh screen before its shell's output, followed by a
 * separator on the line below the last one it drew, wherever its cursor was left.
 */
export const replay = async (
  screen: Terminal,
  transcript: string,
  savedAt: Date | null,
): Promise<void> => {
  await written(screen, transcript)
  const buffer = screen.buffer.active
  let last = buffer.length - 1
  while (last > 0 && !buffer.getLine(last)?.translateToString(true).trim()) last -= 1
  const row = Math.max(0, last - buffer.baseY)
  const when = savedAt ? ` · saved ${savedAt.toLocaleString()}` : ""
  await written(
    screen,
    `\x1b[0m\x1b[${row + 1};1H\r\n${dim(`── restored transcript${when} ──`)}\r\n`,
  )
}
