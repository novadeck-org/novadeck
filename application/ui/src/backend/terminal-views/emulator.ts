import { createView, type Renderers, type View } from "@novadeck/emulator/browser"

import { linkOptions } from "./links"

// How every backend's screens open their emulator: in the font and theme the views pass, with
// the page's WebGL pool, its links, and a screen reader's tree where asked.
export const openEmulator =
  ({ renderers, screenReaderMode }: { renderers: Renderers; screenReaderMode?: boolean }) =>
  (
    element: HTMLElement,
    open: Pick<Parameters<typeof createView>[1], "fontSize" | "fontFamily" | "theme">,
  ): View =>
    createView(element, {
      ...open,
      // Programs and agents pick their own colours, often greys meant for another ground;
      // xterm darkens or lightens any that would read under 4.5:1 against the background.
      minimumContrastRatio: 4.5,
      scrollback: 1000,
      links: linkOptions(),
      renderers,
      ...(screenReaderMode && { screenReaderMode }),
    })
