// jsdom parses every stylesheet it is given, and each screen xterm opens writes several, its
// theme alone some 800 rules (three for each of its 256 colours), written again whenever an
// option changes: most of what a test that opens screens takes, and seconds on a slow runner.
// For tests that read no stylesheet: a style element keeps its text and jsdom never sees it.
export const leaveStylesheetsUnparsed = (): void => {
  const text = new WeakMap<HTMLStyleElement, string>()
  Object.defineProperty(HTMLStyleElement.prototype, "textContent", {
    configurable: true,
    get(this: HTMLStyleElement) {
      return text.get(this) ?? ""
    },
    set(this: HTMLStyleElement, value: string) {
      text.set(this, value)
    },
  })
}
