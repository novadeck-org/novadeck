import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes"
import type { IUnicodeVersionProvider, Terminal as HeadlessTerminal } from "@xterm/headless"
import type { Terminal } from "@xterm/xterm"

// Every emulator here counts a character's columns the same way, as a TUI's own (Ink's) count
// them, emoji sequences and CJK included. A screen one of them gives back replays on the same
// rows in another, and a row a TUI erased is the rows it means.

/** The Unicode version every emulator here measures with. */
export const unicodeVersion = "15-graphemes"

/**
 * Sets an emulator to count widths as every other one here does. It must be made with
 * `allowProposedApi`, which its `unicode` needs.
 */
export const applyWidths = (terminal: Terminal | HeadlessTerminal): void => {
  ;(terminal as Terminal).loadAddon(new UnicodeGraphemesAddon())
  terminal.unicode.activeVersion = unicodeVersion
}

// The emulator's own measure, without a terminal to hold it: the addon is activated on a
// stand-in that keeps the providers it registers, and the one the emulator activates is
// the one measured with.
const provider = ((): IUnicodeVersionProvider => {
  const providers = new Map<string, IUnicodeVersionProvider>()
  const unicode = {
    register: (each: IUnicodeVersionProvider) => providers.set(each.version, each),
    activeVersion: "",
  }
  new UnicodeGraphemesAddon().activate({ unicode } as unknown as Parameters<
    UnicodeGraphemesAddon["activate"]
  >[0])
  const found = providers.get(unicodeVersion)
  if (!found) throw new Error(`the Unicode addon registered no "${unicodeVersion}" provider`)
  return found
})()

// A character's packed properties, as the emulator keeps them: the lowest bit says it
// joins the character before it, the next two its width.
const joins = (properties: number): boolean => (properties & 1) !== 0
const widthOf = (properties: number): number => (properties >> 1) & 3

/**
 * How many columns the emulator draws a string in, as its `UnicodeService` counts them
 * (`getStringCellWidth`): a wide character (CJK, an emoji) takes two, a combining mark
 * none, and a sequence it joins (a ZWJ family, a flag, an emoji with a modifier) what it
 * draws the whole as. The string holds no tab or line break, which move the cursor.
 */
export const cells = (text: string): number => {
  let sum = 0
  let before = 0
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      index += 1
      // A high surrogate with nothing after it, or no low one, counts as itself.
      if (index >= text.length) return sum + provider.wcwidth(code)
      const low = text.charCodeAt(index)
      if (low >= 0xdc00 && low <= 0xdfff) code = (code - 0xd800) * 0x400 + low - 0xdc00 + 0x10000
      else sum += provider.wcwidth(low)
    }
    const properties = provider.charProperties(code, before)
    sum += widthOf(properties) - (joins(properties) ? widthOf(before) : 0)
    before = properties
  }
  return sum
}
