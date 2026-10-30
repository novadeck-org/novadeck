import { serializeWithin, written, type Screen } from "./screen.js"

/**
 * The screen and scrollback as text that draws them again, within `maxChars` characters:
 * older scrollback goes first. The alternate screen and terminal modes stay out, so
 * showing it again cannot leave a fresh screen in a full-screen program's state. Null
 * when the screen is blank, or not even its visible rows fit.
 */
export const transcript = (screen: Screen, maxChars: number): string | null => {
  const text = serializeWithin(
    screen,
    (serializer, scrollback) =>
      serializer.serialize({ scrollback, excludeAltBuffer: true, excludeModes: true }),
    (candidate) => candidate.length <= maxChars,
  )
  return text?.trim() ? text : null
}

/**
 * Draws a transcript on a fresh screen before anything else, followed by the separator,
 * if given, on the line below the last one it drew, wherever its cursor was left. The
 * separator is written as it is, styling included. With `scrolled`, both then go up into
 * the scrollback, leaving the screen blank with the cursor at its top: a program that
 * places its cursor at rows counted from the top of a screen it takes as its own, as a
 * Windows pseudoconsole does, would otherwise draw over them.
 */
export const replay = async (
  screen: Screen,
  text: string,
  separator?: string,
  scrolled = false,
): Promise<void> => {
  await written(screen, text)
  if (separator === undefined && !scrolled) return
  const buffer = screen.buffer.active
  let last = buffer.length - 1
  while (last > 0 && !buffer.getLine(last)?.translateToString(true).trim()) last -= 1
  const row = Math.max(0, last - buffer.baseY)
  // On the line below the last one drawn, within margins reset to the whole screen.
  let after = `\x1b[0m\x1b[r\x1b[${row + 1};1H\r\n`
  if (separator !== undefined) after += `${separator}\r\n`
  // From any row, a screen's height less one line feeds scroll exactly the lines above the
  // cursor away, and no blank one below it.
  if (scrolled) after += `${"\n".repeat(screen.rows - 1)}\x1b[H`
  await written(screen, after)
}
