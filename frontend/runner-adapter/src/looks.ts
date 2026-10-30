import { pageSights, type PageSights } from "@novadeck/core/items/page-sights"
import {
  maxLookPicture,
  maxPageTroubles,
  type PageLook,
  type PageLookAnswer,
} from "@novadeck/protocol"
import type { DesktopPageLook } from "@novadeck/protocol/bridge"

import { clip, troubleOf } from "./companions"

// An agent's look at a page item, answered with a picture: the pane's own, if a pane shows the
// page live on screen, else the page loaded afresh by the host, out of sight.

/** The widest a look's picture is, in device pixels; the widths it then tries if it comes out too large. */
export const lookWidths = [1280, 960, 640] as const

/** How long a look has from its arrival until the runner gives up on it, less a margin. */
export const lookDeadlineMs = 18_000

export const noPictures =
  "Novadeck can't take pictures of pages here: only the desktop app loads them."

const sized = (value: number): number => Math.min(8192, Math.max(1, Math.round(value) || 1))

export type Looks = {
  /** Where the host loads a page afresh, out of sight, and pictures it; absent where it can't. */
  readonly fresh?:
    | ((request: {
        readonly url: string
        readonly layout: "desktop" | "phone"
        // When the runner stops waiting, in the clock's milliseconds: a look not begun by then is dropped.
        readonly before: number
      }) => Promise<DesktopPageLook>)
    | undefined
  readonly sights?: PageSights
}

export const answerLook = async (
  look: PageLook,
  { fresh, sights = pageSights }: Looks,
): Promise<PageLookAnswer> => {
  const { lookId, itemId } = look
  // The runner waits only so long for an answer; one that comes later is no use to anyone.
  const before = Date.now() + lookDeadlineMs
  for (const sight of sights.of(itemId)) {
    for (const width of lookWidths) {
      // eslint-disable-next-line no-await-in-loop -- Each width is tried only if the last was too large.
      const seen = await sight(width, look.shown).catch(() => undefined)
      if (!seen) break
      if (seen.picture.length > maxLookPicture) continue
      return {
        lookId,
        picture: seen.picture,
        url: clip(seen.url, 2048),
        title: clip(seen.title, 1024),
        taken: "pane",
        size: { width: sized(seen.size.width), height: sized(seen.size.height) },
        troubles: [],
      }
    }
  }
  if (!fresh) return { lookId, reason: noPictures }
  try {
    const seen = await fresh({ url: look.url, layout: sights.layout(itemId), before })
    if ("reason" in seen) return { lookId, reason: clip(seen.reason, 512) }
    if (seen.picture.length > maxLookPicture)
      return { lookId, reason: "The page's picture came out too large." }
    return {
      lookId,
      picture: seen.picture,
      url: clip(seen.url, 2048),
      title: clip(seen.title, 1024),
      taken: "fresh",
      size: { width: sized(seen.size.width), height: sized(seen.size.height) },
      troubles: seen.troubles.slice(0, maxPageTroubles).map(troubleOf),
    }
  } catch {
    return { lookId, reason: "The page could not be pictured." }
  }
}
