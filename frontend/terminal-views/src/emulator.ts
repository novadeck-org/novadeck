import { createView, type Renderers, type View } from "@novadeck/emulator/browser"

import { ligaturesOn, watchLigatures } from "./ligatures"
import { linkOptions } from "./links"

// How every backend's screens open their emulator: in the font and theme the views pass, with
// the page's WebGL pool and its links. With `screenReader`, the terminal keeps a screen
// reader's tree and live region while focus is anywhere in it, its input or the tree's rows a
// reader moves into, and only then: an emulator announces whatever is written to it, so
// terminals out of focus, which go on printing, would talk over the one the person is in.
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
    // Ligatures follow the preference on <html> (data-ligatures, set from Preferences).
    view.setLigatures(ligaturesOn())
    const unwatchLigatures = watchLigatures(() => view.setLigatures(ligaturesOn()))
    const dispose = (): void => {
      unwatchLigatures()
      view.dispose()
    }
    if (!screenReader) return { ...view, dispose }
    const reading = (on: boolean): void => {
      view.terminal.options.screenReaderMode = on
    }
    const focus = (): void => reading(true)
    // Focus moving between the input and the tree's rows stays in the terminal, and so does
    // focus the window takes with it, which comes back to the row a reader was on.
    const blur = (event: FocusEvent): void => {
      if (!element.ownerDocument.hasFocus()) return
      if (!(event.relatedTarget instanceof Node && element.contains(event.relatedTarget)))
        reading(false)
    }
    element.addEventListener("focusin", focus)
    element.addEventListener("focusout", blur)
    if (element.contains(element.ownerDocument.activeElement)) focus()
    return {
      ...view,
      dispose: () => {
        element.removeEventListener("focusin", focus)
        element.removeEventListener("focusout", blur)
        dispose()
      },
    }
  }
