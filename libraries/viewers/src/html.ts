import type { FrameCode } from "./frame/host.js"
import type { PaneAction } from "./frame/messages.js"
import { mountFrame } from "./frame/mount.js"
import { htmlMessage } from "./html/messages.js"
import type { PageFile } from "./html/page.js"
import type { Mount, Viewer } from "./index.js"

export { loadPage, pageKey, pageLimits, type ReadPageFile } from "./html/load.js"
export { pageNames, type PageFile } from "./html/page.js"

// A web page, drawn from its text and the files beside it it names (stylesheets, pictures and
// fonts, as the runner read them) in a frame of its own (html/frame-viewer.ts), never in the
// app's page, as a PDF is (frame/mount.ts): the frame is sandboxed with scripts only, so its
// origin is opaque, and its policy allows no network, no storage and no script but its own.
// The page is built from what it was given (html/page.ts) and drawn in a child frame that runs
// nothing, so a script in the page never runs, and nothing it names is fetched. The text and
// files go in as messages; out come only the common ones (started, working). A page written
// again is drawn anew, the old one in view until it has loaded.

/** A page's text and the files beside it that it names, by name from its folder. */
export type HtmlContent = {
  readonly html: string
  readonly files: readonly PageFile[]
}

export type HtmlViewer = Viewer<HtmlContent>

/** The frame, as the app serves it (frame/frame.html as `viewer-frame.html`), and the viewer. */
export type HtmlFrame = {
  readonly url: string
  readonly code: FrameCode
  readonly viewer?: string
}

/**
 * Mounts a web page viewer in its frame. `onAction` hears what the pane does for a key
 * pressed in it, which the frame has no script to tell: it never does, and is here as every
 * frame viewer has it.
 */
export const mountHtml: Mount<
  HtmlContent,
  { readonly frame: HtmlFrame; readonly onAction?: (action: PaneAction) => void },
  HtmlViewer
> = (element, { content, label, frame, onAction }) => {
  const mounted = mountFrame(element, {
    name: "html",
    label,
    url: frame.url,
    code: frame.code,
    viewer: frame.viewer,
    tokens: [],
    stoppedText: "The page viewer stopped.",
    check: htmlMessage,
    onAction,
    through: true,
    hear: () => {},
  })
  const open = (next: HtmlContent): void =>
    mounted.post({
      type: "open",
      html: next.html,
      // Copies, so what the app holds stays its own.
      files: next.files.map(({ name, bytes }) => ({ name, bytes: bytes.slice().buffer })),
    })
  open(content)
  return {
    update: open,
    state: () => ({}) as ReturnType<HtmlViewer["state"]>,
    restore: () => {},
    jumpTo: () => {},
    focus: mounted.focus,
    destroy: mounted.destroy,
  }
}
