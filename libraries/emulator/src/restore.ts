import type { Screen } from "./screen.js"

// What xterm's serializer leaves out of a screen's text, and a fresh screen needs to behave as
// this one does: the background that blank rows below the text were painted with, the scroll
// region, whether the cursor is hidden, and the cursor's own place. It is appended after the
// serialized screen, so a program that scrolls a region it set once, hides the cursor once or
// paints a ground by erasing finds the screen as it left it.

// The parts of xterm's core this reads: the active buffer's scroll region and the cursor's
// visibility, which its public API doesn't tell.
type Core = {
  readonly buffer: { readonly scrollTop: number; readonly scrollBottom: number }
  readonly coreService: { readonly isCursorHidden: boolean }
}

const coreOf = (screen: Screen): Core =>
  // eslint-disable-next-line no-underscore-dangle -- xterm keeps these to itself.
  (screen as unknown as { _core: Core })._core

/**
 * The text that, written after the screen's serialized text on a fresh screen of the same size,
 * leaves it with the screen's blank rows' backgrounds, scroll region, cursor visibility and
 * cursor position (but for a pending wrap, see below). The scroll region is set before the cursor is placed, as setting it homes
 * the cursor; with origin mode on the cursor's row counts from the region's top.
 */
export const restoreState = (screen: Screen): string => {
  const core = coreOf(screen)
  const buffer = screen.buffer.active
  const { scrollTop, scrollBottom } = core.buffer
  const region =
    scrollTop === 0 && scrollBottom === screen.rows - 1
      ? ""
      : `\u001b[${scrollTop + 1};${scrollBottom + 1}r`
  const row = buffer.cursorY - (screen.modes.originMode ? scrollTop : 0) + 1
  // A cursor past the last column has a wrap pending, which no cursor move can make: the
  // serialized text left it there if it ended on that row, and only setting the region moves it.
  const pending = buffer.cursorX >= screen.cols && region === ""
  return (
    region +
    (core.coreService.isCursorHidden ? "\u001b[?25l" : "") +
    (pending ? "" : `\u001b[${row};${buffer.cursorX + 1}H`)
  )
}
