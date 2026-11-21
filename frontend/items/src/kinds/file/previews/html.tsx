import { PanelTop } from "lucide-react"

import type { FilePreview } from "."
import { lazyView } from "../../../lazy-view"

// The page viewer and its frame load when a page first shows, so the workspace's first load
// never carries them.
const HtmlViewer = lazyView(
  () => import("../HtmlViewer").then((module) => module.HtmlViewer),
  <div className="html-pane" aria-busy />,
)

// An HTML file reads as the web page it is, drawn in a sandboxed frame with the files beside it
// it names; its source is one switch away.
export const html: FilePreview = {
  name: "html",
  matches: (path) => /\.html?$/i.test(path),
  icon: PanelTop,
  View: HtmlViewer,
}
