import { createView, type Renderers, type View } from "@novadeck/emulator/browser"

import { linkOptions } from "./links"

// How every backend's screens open their emulator: in the font and theme the views pass, with
// the page's WebGL pool and its links. With `screenReader`, the terminal keeps a screen
// reader's tree and live region while its input has focus, and only then: an emulator
// announces whatever is written to it, so terminals out of focus, which go on printing,
// would talk over the one the person is in.
export const openEmulator =
  ({ renderers, screenReader = false }: { renderers: Renderers; screenReader?: boolean }) =>
  (
    element: HTMLElement,
    open: Pick<Parameters<typeof createView>[1], "fontSize" | "fontFamily" | "theme">,
  ): View => {
    const view = createView(element, {
      ...open,
      // Programs and agents pick their own colours, often greys meant for another ground;
      // xterm darkens or lightens any that would read under 4.5:1 against the background.
      minimumContrastRatio: 4.5,
      scrollback: 1000,
      links: linkOptions(),
      renderers,
    })
    const input = view.terminal.textarea
    if (!screenReader || !input) return view
    const reading = (on: boolean) => (): void => {
      view.terminal.options.screenReaderMode = on
    }
    const focus = reading(true)
    const blur = reading(false)
    input.addEventListener("focus", focus)
    input.addEventListener("blur", blur)
    if (element.ownerDocument.activeElement === input) focus()
    return {
      ...view,
      dispose: () => {
        input.removeEventListener("focus", focus)
        input.removeEventListener("blur", blur)
        view.dispose()
      },
    }
  }
