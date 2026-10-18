import type { Screen } from "./screen.js"
import { serializerOf } from "./screen.js"

/**
 * The screen and scrollback as text that draws them again, within `maxChars` characters:
 * older scrollback goes first. The alternate screen and terminal modes stay out, so
 * showing it again cannot leave a fresh screen in a full-screen program's state. Null
 * when the screen is blank, or not even its visible rows fit.
 */
export const transcript = (screen: Screen, maxChars: number): string | null => {
  const serializer = serializerOf(screen)
  let scrollback = screen.buffer.normal.baseY
  while (true) {
    const text = serializer.serialize({ scrollback, excludeAltBuffer: true, excludeModes: true })
    if (text.length <= maxChars) return text.trim() ? text : null
    if (scrollback === 0) return null
    scrollback = Math.floor(scrollback / 2)
  }
}

const written = (screen: Screen, data: string): Promise<void> =>
  new Promise((resolve) => screen.write(data, resolve))

/**
 * Draws a transcript on a fresh screen before anything else, followed by the separator,
 * if given, on the line below the last one it drew, wherever its cursor was left. The
 * separator is written as it is, styling included.
 */
export const replay = async (screen: Screen, text: string, separator?: string): Promise<void> => {
  await written(screen, text)
  if (separator === undefined) return
  const buffer = screen.buffer.active
  let last = buffer.length - 1
  while (last > 0 && !buffer.getLine(last)?.translateToString(true).trim()) last -= 1
  const row = Math.max(0, last - buffer.baseY)
  await written(screen, `\x1b[0m\x1b[${row + 1};1H\r\n${separator}\r\n`)
}
