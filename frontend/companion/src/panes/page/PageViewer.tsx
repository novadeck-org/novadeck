import type { PageContent } from "@novadeck/core/companion"
import { pagesPartition } from "@novadeck/core/pages"
import { useShown } from "@novadeck/toolkit/shown"
import { mountBrowser, type Load, type Place } from "@novadeck/viewers/browser"
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { useAwake } from "../../awake"
import { useViewerSlot } from "../../ViewerSlot"

const OpenInBrowser = ({ url }: { url: string }): React.JSX.Element => (
  // The desktop app opens a new window's http(s) address in the person's browser.
  <a className="artifact-open" href={url} target="_blank" rel="noreferrer">
    <ExternalLink size={14} aria-hidden="true" />
    Open in browser
  </a>
)

// A page in the browser viewer: live where the backend's host allows, else its snapshot.
// Where its viewer was, by item, is kept: where the person had taken it, and the picture
// of it a live page rests as while the pane sleeps, which costs nothing to draw.
const ShownPage = ({
  id,
  content: page,
  actions,
  picture,
}: {
  id: string
  content: PageContent
  actions: ReactNode
  picture: ((page: number) => Promise<string | undefined>) | undefined
}): React.JSX.Element => {
  const [place, setPlace] = useState<Place>({ url: page.url, back: false, forward: false })
  const [load, setLoad] = useState<Load>("loading")
  // Each show of it loads it afresh and brings its scroll into view, once.
  const content = useMemo(
    () => ({
      url: page.url,
      shown: page.shown,
      ...(page.scroll !== undefined && { scroll: page.scroll }),
    }),
    [page.url, page.shown, page.scroll],
  )
  const { awake, wake } = useAwake()
  const { ref, viewer } = useViewerSlot(mountBrowser, {
    id,
    content,
    label: page.url,
    live: page.live,
    ...(page.snapshot ? { snapshot: { src: page.snapshot, alt: `${page.url} as shown` } } : {}),
    partition: pagesPartition,
    ...(picture ? { picture } : {}),
    awake,
    on: { navigate: setPlace, load: setLoad },
  })
  // Kept out of sight, the page goes quiet: it stops drawing on its own, but not playing.
  const shown = useShown()
  useEffect(() => viewer?.muted(!shown), [viewer, shown])
  useEffect(() => viewer?.awake(awake), [viewer, awake])
  // On screen with no picture to rest as, it wakes for a while, to be pictured as it
  // rests; shown again by its agent, as soon as it's on screen, to show what changed.
  const show = useRef(page.shown)
  useEffect(() => {
    if (!viewer || !shown) return
    const again = show.current !== page.shown
    show.current = page.shown
    if (again || !viewer.pictured()) wake()
  }, [viewer, shown, page.shown, wake])
  return (
    <div
      className="artifact-browser"
      data-live={page.live || undefined}
      aria-busy={load === "loading"}
    >
      <div className="artifact-browser-bar">
        {page.live && (
          <>
            <button
              className="icon-button"
              aria-label="Back"
              disabled={!place.back}
              onClick={() => viewer?.back()}
            >
              <ArrowLeft size={14} />
            </button>
            <button
              className="icon-button"
              aria-label="Forward"
              disabled={!place.forward}
              onClick={() => viewer?.forward()}
            >
              <ArrowRight size={14} />
            </button>
            <button className="icon-button" aria-label="Reload" onClick={() => viewer?.reload()}>
              <RotateCw size={14} />
            </button>
          </>
        )}
        <span className="artifact-url">{place.url}</span>
        <OpenInBrowser url={place.url} />
        {actions}
      </div>
      <div className="artifact-page-frame">
        <div ref={ref} className="artifact-page-view" />
        {load === "failed" && (
          <div className="artifact-page-failed" role="alert">
            <p>This page didn't load.</p>
            <button type="button" className="artifact-open" onClick={() => viewer?.reload()}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// A page loads live where the backend's host allows, in Electron's <webview>, which the
// desktop app locks down (no Node, its own session, http(s) only; see the browser viewer);
// elsewhere it's a link to open in the browser, with a snapshot when the backend has one.
export const PageViewer = ({
  item,
  content: page,
  actions,
  panes,
}: ArtifactBodyProps<"page">): React.JSX.Element =>
  page.live || page.snapshot ? (
    // Its own for each address: a new page starts at its own address, not the last one's.
    <ShownPage
      key={page.url}
      id={item.id}
      content={page}
      actions={actions}
      picture={panes.picture}
    />
  ) : (
    <div className="artifact-browser">
      <div className="artifact-browser-bar">
        <span className="artifact-url">{page.url}</span>
        <OpenInBrowser url={page.url} />
        {actions}
      </div>
      <div className="artifact-status">This page opens in your browser.</div>
    </div>
  )

// The page in a browser frame: its snapshot where it has one, else its address.
export const PageThumb = ({ content }: { content: PageContent }): React.JSX.Element => (
  <span className="peek-page">
    <span className="peek-page-bar">
      <i />
      <i />
      <i />
    </span>
    {content.snapshot ? (
      <img src={content.snapshot} alt="" />
    ) : (
      <span className="peek-page-url">{content.url}</span>
    )}
  </span>
)
