import { loadPage, mountHtml, pageKey, type HtmlContent } from "@novadeck/viewers/html"
import { useEffect, useMemo, useRef, useState } from "react"

import { raisePaneAction } from "../../pane-actions"
import { useViewerSlot } from "../../ViewerSlot"
import { htmlFrame } from "./html-frame"
import type { PreviewProps } from "./previews"

// A web page the agent showed, drawn as the page it is, in the page viewer's frame: its text,
// and the stylesheets, pictures and fonts beside it that it names, which the backend reads from
// the page's folder. The page is read again whenever the file changes, and again as a file it
// was drawn with does (the backend tells that as a new stamp); a page that comes out the same
// as the one drawn is left as it is, so nothing reloads for a file that was only written.

// A page's text past what the runner reads whole is cut short, and can't be drawn.
const cutNote = "This page is too long to draw, so its source is shown."

type Drawn = { readonly key: string; readonly content: HtmlContent }

const Page = ({
  id,
  name,
  content,
}: {
  readonly id: string
  readonly name: string
  readonly content: HtmlContent
}): React.JSX.Element => {
  const element = useRef<HTMLDivElement | null>(null)
  const frame = useMemo(() => htmlFrame(), [])
  const { ref } = useViewerSlot(mountHtml, {
    id,
    content,
    label: name,
    frame,
    onAction: (action) => element.current && raisePaneAction(element.current, action),
  })
  return (
    <div
      ref={(node) => {
        element.current = node
        ref(node)
      }}
      className="artifact-html"
    />
  )
}

export const HtmlViewer = ({
  id,
  name,
  content: file,
  toSource,
  beside,
}: PreviewProps): React.JSX.Element => {
  const [drawn, setDrawn] = useState<Drawn>()
  useEffect(() => {
    if (file.truncated) toSource({ note: cutNote })
  }, [file, toSource])
  // Each content the item gets reads the page again, even one with the same text: a file it was
  // drawn with may have been written, which the backend tells by a new content.
  useEffect(() => {
    if (file.truncated) return
    const html = file.lines.join("\n")
    const stop = new AbortController()
    // Where the backend can't read files beside the page, it draws without them.
    const read = (path: string) => (beside ? beside(path, stop.signal) : Promise.resolve(undefined))
    void loadPage({ html, read, signal: stop.signal }).then((files) => {
      if (!files || stop.signal.aborted) return
      const key = pageKey(html, files)
      // The page as it was drawn is kept, so a file only written draws nothing again.
      setDrawn((now) => (now?.key === key ? now : { key, content: { html, files } }))
    })
    return () => stop.abort()
  }, [file, beside])
  return (
    <div className="html-pane" aria-busy={drawn === undefined}>
      {drawn && <Page id={id} name={name} content={drawn.content} />}
    </div>
  )
}
