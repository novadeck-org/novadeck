import { pageTroublesPerCall, type PageContent } from "@novadeck/core/items"
import { pageSights } from "@novadeck/core/items/page-sights"
import { pagesPartition } from "@novadeck/core/items/pages"
import { useShown } from "@novadeck/toolkit/shown"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { mountBrowser, type Load, type Place, type Trouble } from "@novadeck/viewers/browser"
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, Smartphone } from "lucide-react"
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

// How long troubles are gathered before they are told, so a page that logs a burst of them
// makes one call.
const troubleBatch = 500

type Tell = ArtifactBodyProps<"page">["trouble"]

// Gathers troubles, each with the show of the document the viewer says it came from, and
// tells them a moment later, each run of one show in calls of at most what a call takes.
const batcher = (latest: () => { readonly current: Tell }) => {
  let gathered: { trouble: Trouble; shown: number }[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    const all = gathered
    gathered = []
    for (let from = 0; from < all.length;) {
      const shown = all[from]!.shown
      let to = from
      while (to < all.length && all[to]!.shown === shown && to - from < pageTroublesPerCall) to += 1
      latest().current(
        shown,
        all.slice(from, to).map(({ trouble }) => trouble),
      )
      from = to
    }
  }
  const collect = (trouble: Trouble, shown: number): void => {
    gathered.push({ trouble, shown })
    timer ??= setTimeout(flush, troubleBatch)
  }
  return { flush, collect }
}

// The troubles a live page reports, batched. Whatever is gathered when the page goes is
// told then.
const useTroubles = (tell: Tell): ((trouble: Trouble, shown: number) => void) => {
  const latest = useRef(tell)
  useEffect(() => {
    latest.current = tell
  })
  const batch = useMemo(() => batcher(() => latest), [])
  useEffect(() => batch.flush, [batch])
  return batch.collect
}

// A page in the browser viewer: live where the backend's host allows, else its snapshot.
// Where its viewer was, by item, is kept: where the person had taken it, and the picture
// of it a live page rests as while the pane sleeps, which costs nothing to draw.
const ShownPage = ({
  id,
  content: page,
  trouble,
  actions,
  picture,
  phone,
}: {
  id: string
  content: PageContent
  trouble: ArtifactBodyProps<"page">["trouble"]
  actions: ReactNode
  picture: ((page: number, width?: number) => Promise<string | undefined>) | undefined
  phone: ((page: number, phone: boolean) => Promise<boolean>) | undefined
}): React.JSX.Element => {
  const collect = useTroubles(trouble)
  const [place, setPlace] = useState<Place>({ url: page.url, back: false, forward: false })
  const [load, setLoad] = useState<Load>("loading")
  const [size, setSize] = useState(() => pageSights.layout(id))
  // Each show of it loads it afresh and brings its scroll into view, once.
  const content = useMemo(
    () => ({
      url: page.url,
      shown: page.shown,
      ...(page.scroll !== undefined && { scroll: page.scroll }),
    }),
    [page.url, page.shown, page.scroll],
  )
  const { awake, sleeps, wake } = useAwake()
  const { ref, viewer } = useViewerSlot(mountBrowser, {
    id,
    content,
    label: page.url,
    live: page.live,
    ...(page.snapshot ? { snapshot: { src: page.snapshot, alt: `${page.url} as shown` } } : {}),
    partition: pagesPartition,
    // Only where it can rest: a picture nothing rests as costs for nothing.
    ...(picture && sleeps ? { picture } : {}),
    ...(phone ? { phone } : {}),
    awake,
    size,
    on: { navigate: setPlace, load: setLoad, ...(page.live ? { trouble: collect } : {}) },
  })
  // Kept out of sight, the page goes quiet: it stops drawing on its own, but not playing.
  const shown = useShown()
  useEffect(() => viewer?.muted(!shown), [viewer, shown])
  useEffect(() => viewer?.awake(awake), [viewer, awake])
  useEffect(() => viewer?.size(size), [viewer, size])
  const switchSize = (): void => {
    const next = size === "phone" ? "desktop" : "phone"
    pageSights.setLayout(id, next)
    setSize(next)
  }
  // An agent's look at the page is a picture of it as it is here, while it is live on screen.
  useEffect(() => {
    if (!viewer || !picture || !page.live) return
    return pageSights.register(id, async (width, looked) => {
      // A look of a later show than this pane has rendered, as one reaching it before the show.
      if (page.shown < looked) return undefined
      const seen = viewer.seen()
      if (!seen) return undefined
      const src = await picture(seen.page, width)
      // Gone to rest, off screen or elsewhere while the picture was taken: it is of what it was then.
      const now = viewer.seen()
      if (!src || now?.page !== seen.page || now.url !== seen.url) return undefined
      return {
        picture: src,
        url: seen.url,
        title: seen.title,
        size: { width: seen.width, height: seen.height },
      }
    })
  }, [viewer, picture, page.live, page.shown, id])
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
        {page.live && (
          <Tooltip content={size === "phone" ? "Back to desktop size" : "Show at phone size"}>
            <button
              type="button"
              className="icon-button"
              aria-label="Phone size"
              aria-pressed={size === "phone"}
              onClick={switchSize}
            >
              <Smartphone size={14} aria-hidden />
            </button>
          </Tooltip>
        )}
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
  itemStore,
  trouble,
}: ArtifactBodyProps<"page">): React.JSX.Element =>
  page.live || page.snapshot ? (
    // Its own for each address: a new page starts at its own address, not the last one's.
    <ShownPage
      key={page.url}
      id={item.id}
      content={page}
      trouble={trouble}
      actions={actions}
      picture={itemStore.picture}
      phone={itemStore.phone}
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
