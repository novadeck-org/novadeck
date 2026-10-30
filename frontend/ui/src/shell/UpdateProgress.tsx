import type { UpdateOffer } from "@novadeck/core/desktop/update"
import { Progress } from "@novadeck/toolkit/Progress"
import { useLayoutEffect, useState } from "react"

import { currentPlatform, type Platform } from "../interaction/shortcuts"
import { useLinger } from "./linger"

// Where the bar stands for the offer heard last. A download this page saw finish keeps the
// bar full for `finishedForMs`, then fades it; a version found ready without a download
// this page saw, as at a launch, shows nothing.
type Moment = "progress" | "finished" | "fading" | "gone"
type Watched = { readonly version: string; readonly moment: Moment }

// The bar's next place once `offer` is heard: a download shows, the same version turning
// ready finishes it, and anything else, a failed download or another version, ends it.
export const watchedAfter = (
  watched: Watched | undefined,
  offer: UpdateOffer | null,
): Watched | undefined => {
  if (offer?.kind === "downloading") return { version: offer.version, moment: "progress" }
  if (watched === undefined || watched.moment === "gone") return watched
  if (offer?.version !== watched.version || offer.kind !== "ready")
    return { ...watched, moment: "gone" }
  return watched.moment === "progress" ? { ...watched, moment: "finished" } : watched
}

// An update downloading, as a bar floating above the footer's right end: what is happening
// and how far along, nothing to press. It never takes keys, focus or clicks, so the corner
// it covers stays usable, and it waits out Zen mode with the footer, and any notice open in
// the same corner. A finished download says it installs on the next restart (on macOS,
// where closing the window doesn't quit, when the person quits) and fades; a failed one (`retrying`) drops the bar at once, as the host tries again by itself.
export const UpdateProgress = ({
  offer,
  hidden,
  onActive,
  platform = currentPlatform(),
}: {
  readonly offer: UpdateOffer | null
  readonly hidden: boolean
  // Told whether the bar has a download to show, hidden or not: from the download's start
  // until its finished bar has faded. The what's-new card waits for it (WorkspaceFooter.tsx).
  readonly onActive?: (active: boolean) => void
  readonly platform?: Platform
}): React.JSX.Element => {
  // The version this page saw downloading, and the moment its bar is at.
  const [watched, setWatched] = useState<Watched>()
  const next = watchedAfter(watched, offer)
  if (next?.version !== watched?.version || next?.moment !== watched?.moment) setWatched(next)
  const moment = watched?.moment ?? "gone"
  useLinger(moment, !hidden, (to) => setWatched((current) => current && { ...current, moment: to }))
  const active = moment !== "gone"
  // Before paint, so the card never shares a frame with a bar that is just starting.
  useLayoutEffect(() => {
    onActive?.(active)
  }, [active, onActive])
  const percent = moment === "progress" && offer?.kind === "downloading" ? offer.percent : 100
  const shown = moment !== "gone" && !hidden
  const when = platform === "mac" ? "when you quit Novadeck" : "on the next restart"
  return (
    <>
      {/* Always mounted, so filling it announces the download and its end, not each percent. */}
      <span role="status" aria-live="polite" className="sr-only">
        {moment === "progress"
          ? "Downloading Novadeck update"
          : moment === "finished"
            ? `Novadeck update downloaded, installs ${when}`
            : ""}
      </span>
      {shown && watched && (
        <div
          className="floating update-progress"
          data-state={moment === "fading" ? "closed" : "open"}
          aria-hidden="true"
        >
          <p className="update-progress-head">
            <span className="update-progress-title">
              {moment === "progress" ? "Updating Novadeck" : "Update ready"}
            </span>
            <span className="update-progress-percent">{percent}%</span>
          </p>
          <Progress label={`Novadeck ${watched.version}`} value={percent} max={100} />
          <p className="update-progress-note">
            {moment === "progress"
              ? `Downloading ${watched.version}`
              : `${watched.version} installs ${when}`}
          </p>
        </div>
      )}
    </>
  )
}
