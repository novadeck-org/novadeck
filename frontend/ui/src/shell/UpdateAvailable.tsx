import { CircleArrowUp } from "lucide-react"
import { useState } from "react"

import { readFoldedChip, writeFoldedChip } from "./shell-storage"

// An installed copy that can't install an update itself, as with an unsigned macOS app or
// an AppImage in a folder it can't write to: a quiet chip beside the footer's status that
// opens the release page, where the person gets it. No panel, notes or Later; it stays
// until the copy is updated. A copy that updates itself shows its downloads as a bar
// (UpdateProgress.tsx) instead. A macOS copy the person can't write to has one more way:
// an administrator can let it install updates itself, so the chip reads "Allow updates"
// and asks for that (`onAllow`) in place of opening the page. Once the person opened the
// page, the chip folds to its icon (and dot) for that release; any other brings the word
// back.
export type AvailableUpdate = {
  readonly version: string
  readonly onOpenPage: () => void
  readonly onAllow?: (() => void) | undefined
}

const allowNote = "Asks for an administrator's password so Novadeck can install updates itself"

export const UpdateAvailable = ({
  available,
}: {
  readonly available: AvailableUpdate | undefined
}): React.JSX.Element => {
  const [folded, setFolded] = useState(readFoldedChip)
  const iconOnly = available !== undefined && !available.onAllow && folded === available.version
  const openPage = (): void => {
    if (!available) return
    setFolded(available.version)
    writeFoldedChip(available.version)
    available.onOpenPage()
  }
  return (
    <>
      {/* Always mounted, so filling it announces the arrival once. */}
      <span role="status" aria-live="polite" className="sr-only">
        {available ? (available.onAllow ? "Allow updates" : "Update available") : ""}
      </span>
      {available && (
        <button
          type="button"
          className="footer-update footer-chip cursor-pointer"
          aria-label={
            available.onAllow
              ? `Allow updates: Novadeck ${available.version}`
              : `Update available: Novadeck ${available.version}`
          }
          aria-description={available.onAllow ? allowNote : "Opens the release page"}
          // Folded to its icon, it says what it is on hover too.
          title={
            available.onAllow
              ? allowNote
              : iconOnly
                ? "Update available · Opens the release page"
                : "Opens the release page"
          }
          onClick={available.onAllow ?? openPage}
        >
          <span className="footer-chip-icon" aria-hidden="true">
            <CircleArrowUp size={12} strokeWidth={1.75} />
            <span className="attention-dot footer-chip-dot" />
          </span>
          <span className={`footer-chip-text ${iconOnly ? "hidden" : "max-[701px]:hidden"}`}>
            {available.onAllow ? "Allow updates" : "Update available"}
          </span>
        </button>
      )}
    </>
  )
}
