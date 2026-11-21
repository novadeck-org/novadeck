// The `?frame` import's type, wherever this file is compiled: an app's own check takes it in
// without the package's other declarations, and no import can carry a wildcard module's.
// eslint-disable-next-line typescript/triple-slash-reference -- See above.
/// <reference path="../../frame.d.ts" />
import type { HtmlFrame } from "@novadeck/viewers/html"

// What the web page viewer's frame is handed: the viewer, bundled into one script, as text, in a
// chunk of its own loaded only when a page shows.
const code = async () => {
  const { default: script } = await import("@novadeck/viewers/html-frame?frame")
  return { scripts: [script] }
}

/** The frame: its page beside the app's (frontend/ui/public/viewer-frame.html), and the viewer. */
export const htmlFrame = (): HtmlFrame => ({
  url: new URL("viewer-frame.html", document.baseURI).href,
  code,
})
