import { restoreMouseEncoding, type MouseEncoding } from "./mouse.js"
import { serializerOf, type Screen } from "./screen.js"

/**
 * The screen serialized with as much scrollback as `fits` accepts, halving it until then:
 * the visible screen always stays. The serializer leaves out the mouse's encoding, so it
 * follows the screen: a fresh terminal restored without it would report the mouse to an
 * SGR program as X10. Undefined when not even the visible screen fits.
 */
export const snapshot = (
  screen: Screen,
  options: { fits: (data: string) => boolean; mouse: MouseEncoding },
): string | undefined => {
  const serializer = serializerOf(screen)
  let scrollback = screen.buffer.normal.baseY
  while (true) {
    const data = serializer.serialize({ scrollback }) + restoreMouseEncoding(options.mouse)
    if (options.fits(data)) return data
    if (scrollback === 0) return undefined
    scrollback = Math.floor(scrollback / 2)
  }
}
