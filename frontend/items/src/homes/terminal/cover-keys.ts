// The keys of a pane that covers its terminal (see pane.css). The person can't see what
// they'd send there, so Escape and Enter only uncover it, and never reach the terminal,
// whose program takes Escape as an interrupt; any other key uncovers it and goes on into
// the terminal, so a reply typed blind brings it back with its first key.

// Where the pane's own content takes text: an editor, a field, a page. Its keys are its own.
const editable =
  'input:not([type="radio"], [type="checkbox"], [type="button"], [type="submit"], [type="reset"], [type="range"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], webview, iframe'

// What a key does by itself on the pane's surface, so a character typed there is not a reply.
const operable = 'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"]'

const modifiers = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Fn",
  "FnLock",
])

export type CoverKey = {
  // Whether the pane is on top of the terminal now.
  readonly covering: () => boolean
  readonly terminal: Element
  readonly pane: Element
  readonly uncover: () => void
  // Types a key pressed on the pane's surface into the terminal, as the same key.
  readonly type: (event: KeyboardEvent) => void
}

// Holds a swallowed Escape or Enter back until it is released: held down, its repeats must
// not reach the terminal once the pane is gone, which may be before they start.
const swallowRepeats = (key: string): void => {
  const repeat = (event: KeyboardEvent): void => {
    if (event.key !== key || !event.repeat) return
    event.preventDefault()
    event.stopPropagation()
  }
  const stop = (): void => {
    document.removeEventListener("keydown", repeat, true)
    document.removeEventListener("keyup", release, true)
    window.removeEventListener("blur", stop)
  }
  const release = (event: KeyboardEvent): void => {
    if (event.key === key) stop()
  }
  document.addEventListener("keydown", repeat, true)
  document.addEventListener("keyup", release, true)
  // A key released while the window was away is never heard.
  window.addEventListener("blur", stop)
}

const character = (event: KeyboardEvent): boolean =>
  event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey

// A keydown, heard before the terminal gets it: uncovers the pane, and for Escape and
// Enter keeps the key from the terminal.
export const coverKey = (event: KeyboardEvent, context: CoverKey): void => {
  const { target } = event
  if (!(target instanceof Element) || event.defaultPrevented || !context.covering()) return
  // A composition's keys are the input method's until it ends.
  if (event.isComposing || event.keyCode === 229) return
  if (context.pane.contains(target)) {
    // Fields take their own keys, Escape among them.
    if (target.closest(editable)) return
    if (event.key === "Escape") return context.uncover()
    if (!character(event)) return
    if (target.closest(operable)) {
      // A control keeps Space, and the app takes the character on to the terminal.
      if (event.key !== " ") context.uncover()
      return
    }
    // The pane's surface: the character is a reply, typed into the terminal.
    event.preventDefault()
    context.uncover()
    context.type(event)
    return
  }
  if (target === document.body || target === document.documentElement) {
    // Typing with focus nowhere goes to the selected terminal, which the app focuses once
    // the key has passed: it's covered if that is this one.
    if (character(event))
      setTimeout(() => {
        if (context.terminal.contains(document.activeElement)) context.uncover()
      })
    return
  }
  if (!context.terminal.contains(target) || modifiers.has(event.key)) return
  if (event.key === "Escape" || event.key === "Enter") {
    event.preventDefault()
    event.stopPropagation()
    swallowRepeats(event.key)
  }
  context.uncover()
}
