// What a page an agent showed looks like in the panes right now, for the agent to look at.
// A live page's viewer registers here while it is mounted; the backend asks when the
// runner passes on an agent's look, and takes a picture of the page as the person sees it,
// or, where no pane shows it live, loads it afresh at the size the person last chose for it.

/** How a page lays out: a desktop's window, or a phone's screen. */
export type PageLayout = "desktop" | "phone"

/** A live page as a pane shows it: a JPEG `data:` address, where it is, and its laid-out size in CSS pixels. */
export type PageSeen = {
  readonly picture: string
  readonly url: string
  readonly title: string
  readonly size: { readonly width: number; readonly height: number }
}

/**
 * Pictures the page as its pane shows it, no wider than `width` device pixels; undefined
 * unless it is live and on screen, not resting as its picture or kept out of sight, and at
 * the item's show `shown` or a later one: a pane still at an earlier show isn't what the
 * agent showed.
 */
export type PageSight = (width: number, shown: number) => Promise<PageSeen | undefined>

export type PageSights = {
  /** Registers the live viewer of an item's page; returns the undo. */
  readonly register: (itemId: string, sight: PageSight) => () => void
  /** The sights of an item's page, the latest registered first. */
  readonly of: (itemId: string) => readonly PageSight[]
  /** What the item's page lays out as: as the person last switched it, else a desktop's. */
  readonly layout: (itemId: string) => PageLayout
  readonly setLayout: (itemId: string, layout: PageLayout) => void
}

export const createPageSights = (): PageSights => {
  const sights = new Map<string, PageSight[]>()
  // For as long as the app runs: a page shown again, or at another address, keeps it.
  const layouts = new Map<string, PageLayout>()
  return {
    register: (itemId, sight) => {
      sights.set(itemId, [sight, ...(sights.get(itemId) ?? [])])
      return () => {
        const rest = (sights.get(itemId) ?? []).filter((each) => each !== sight)
        if (rest.length) sights.set(itemId, rest)
        else sights.delete(itemId)
      }
    },
    of: (itemId) => sights.get(itemId) ?? [],
    layout: (itemId) => layouts.get(itemId) ?? "desktop",
    setLayout: (itemId, layout) => void layouts.set(itemId, layout),
  }
}

/** The app's page sights: its viewers register on them, and the backend's looks ask them. */
export const pageSights = createPageSights()
