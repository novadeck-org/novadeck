import { pageTroublesPerCall, type PageContent } from "@novadeck/core/items"
import { pageSights } from "@novadeck/core/items/page-sights"
import { pagesPartition } from "@novadeck/core/items/pages"
import { ContextMenu } from "@novadeck/toolkit/ContextMenu"
import { useShown } from "@novadeck/toolkit/shown"
import {
  mountBrowser,
  type Load,
  type PageMenu,
  type Place,
  type Trouble,
} from "@novadeck/viewers/browser"
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, Smartphone } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { useAwake } from "../../awake"
import { PaneTools, usePaneNote, type PaneTool } from "../../pane-row"
import { useViewerSlot } from "../../ViewerSlot"
import { AddressField } from "./AddressField"
import { pageMenuItems } from "./page-menu"

/** Whether two addresses share an origin: scheme, host and port. */
const sameOrigin = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

// The one-time line that says a phone can be zoomed: seen once, kept across launches in
// local storage, which may be unavailable (a private window), where it shows each launch.
const zoomHintKey = "novadeck.page-zoom-hint"
const zoomHint = {
  seen: (): boolean => {
    try {
      return localStorage.getItem(zoomHintKey) === "1"
    } catch {
      return false
    }
  },
  see: (): void => {
    try {
      localStorage.setItem(zoomHintKey, "1")
    } catch {
      /* It shows again next launch. */
    }
  },
}

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

// Opens an address in the person's browser, never in the pane.
const openOut = (url: string): void => {
  window.open(url, "_blank", "noreferrer")
}

// Puts text on the clipboard, as a menu's Copy does; one the app can't write goes nowhere.
const copyText = (text: string): void => {
  void navigator.clipboard?.writeText(text).catch(() => undefined)
}

// Opens the page in the person's browser, never in the pane.
const openTool = (url: string): PaneTool => ({
  key: "open",
  icon: ExternalLink,
  label: "Open in browser",
  href: url,
})

// A page in the browser viewer: live where the app can load it, else its snapshot.
// Where its viewer was, by item, is kept: where the person had taken it, and the picture
// of it a live page rests as while the pane sleeps, which costs nothing to draw.
const ShownPage = ({
  id,
  content: page,
  trouble,
  picture,
  phone,
  zoom,
}: {
  id: string
  content: PageContent
  trouble: ArtifactBodyProps<"page">["trouble"]
  picture:
    | ((page: number, width?: number, forLook?: boolean) => Promise<string | undefined>)
    | undefined
  phone: ((page: number, phone: boolean) => Promise<boolean>) | undefined
  zoom: ((page: number, factor: number) => Promise<boolean>) | undefined
}): React.JSX.Element => {
  const collect = useTroubles(trouble)
  const [place, setPlace] = useState<Place>({ url: page.url, back: false, forward: false })
  const [load, setLoad] = useState<Load>("loading")
  // A phone-size page with no mobile viewport tag, which a phone would lay out wider.
  const [unmobile, setUnmobile] = useState(false)
  // The menu the person asked for on the page, until it closes. It goes as the person goes
  // back to the page, which the app's page hears only as its window losing focus to the
  // page's view, as it does to another app, where a menu goes too.
  const [menu, setMenu] = useState<PageMenu | undefined>(undefined)
  const menuOpen = menu !== undefined
  useEffect(() => {
    if (!menuOpen) return
    const close = (): void => setMenu(undefined)
    window.addEventListener("blur", close)
    return () => window.removeEventListener("blur", close)
  }, [menuOpen])
  // The tab says where the page is now, which isn't always where it was shown.
  usePaneNote([], false, place.url)
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
    ...(zoom ? { zoom } : {}),
    zoomHint,
    awake,
    size,
    on: {
      navigate: setPlace,
      unmobile: setUnmobile,
      load: setLoad,
      menu: setMenu,
      ...(page.live ? { trouble: collect } : {}),
    },
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
      // Only the page the agent showed: the pane signed in elsewhere, or on another origin
      // than the item's, is the person's own, and the look falls back to a fresh load.
      if (!sameOrigin(seen.url, page.url)) return undefined
      // The main process refuses a picture while the page holds a frame from off this machine.
      const src = await picture(seen.page, width, true)
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
  }, [viewer, picture, page.live, page.shown, page.url, id])
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
      <PaneTools
        chip={
          <AddressField
            where={place.url}
            live={page.live}
            onGo={(url) => {
              if (!page.live) return openOut(url)
              viewer?.visit(url)
              // Resting, it goes there as it wakes.
              wake()
            }}
            onReturn={() => viewer?.focus()}
          />
        }
        tools={[
          ...(page.live
            ? [
                {
                  key: "back",
                  icon: ArrowLeft,
                  label: "Back",
                  disabled: !place.back,
                  onClick: () => viewer?.back(),
                },
                {
                  key: "forward",
                  icon: ArrowRight,
                  label: "Forward",
                  disabled: !place.forward,
                  onClick: () => viewer?.forward(),
                },
                { key: "reload", icon: RotateCw, label: "Reload", onClick: () => viewer?.reload() },
                {
                  key: "phone",
                  icon: Smartphone,
                  label: size === "phone" ? "Back to desktop size" : "Show at phone size",
                  pressed: size === "phone",
                  onClick: switchSize,
                },
              ]
            : []),
          openTool(place.url),
        ]}
      />
      {unmobile && (
        <div className="pane-notice" data-tone="warning" role="status">
          <p>
            This page has no mobile viewport tag: a phone would lay it out 980 wide and shrink it.
          </p>
        </div>
      )}
      <div className="artifact-page-frame">
        <div ref={ref} className="artifact-page-view" />
        {/* The menu's keys are its own: its Escape closes it, not the pane around it. */}
        <span
          className="contents"
          onKeyDown={(event) => {
            if (event.key === "Escape") event.stopPropagation()
          }}
        >
          <ContextMenu
            label="Page actions"
            at={menu && { x: menu.x, y: menu.y }}
            items={
              menu
                ? pageMenuItems({
                    menu,
                    live: page.live,
                    place,
                    actions: {
                      edit: (edit) => viewer?.edit(edit),
                      back: () => viewer?.back(),
                      forward: () => viewer?.forward(),
                      reload: () => viewer?.reload(),
                      copy: copyText,
                      open: openOut,
                    },
                  })
                : []
            }
            onOpenChange={(open) => {
              if (!open) setMenu(undefined)
            }}
          />
        </span>
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

// A page loads live where the app can, in Electron's <webview>, which the
// desktop app locks down (no Node, its own session, http(s) only; see the browser viewer);
// elsewhere it's a link to open in the browser, with a snapshot when the backend has one.
export const PageViewer = ({
  item,
  content: page,
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
      picture={itemStore.picture}
      phone={itemStore.phone}
      zoom={itemStore.zoom}
    />
  ) : (
    <div className="artifact-browser">
      <PaneTools
        chip={<AddressField where={page.url} live={false} onGo={openOut} onReturn={() => {}} />}
        tools={[openTool(page.url)]}
      />
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
