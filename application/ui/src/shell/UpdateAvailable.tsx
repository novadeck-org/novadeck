// An installed copy that can't install an update itself, as with an unsigned macOS app or
// an AppImage in a folder it can't write to: a quiet chip beside the footer's status that
// opens the release page, where the person gets it. No panel, notes or Later; it stays
// until the copy is updated. A copy that updates itself shows its downloads as a bar
// (UpdateProgress.tsx) instead.
export type FooterAvailable = {
  readonly version: string
  readonly onOpenPage: () => void
}

export const UpdateAvailable = ({
  available,
}: {
  readonly available: FooterAvailable | undefined
}): React.JSX.Element => (
  <>
    {/* Always mounted, so filling it announces the arrival once. */}
    <span role="status" aria-live="polite" className="sr-only">
      {available ? "Update available" : ""}
    </span>
    {available && (
      <button
        type="button"
        className="footer-action footer-update cursor-pointer font-bold"
        aria-label={`Update available: Novadeck ${available.version}`}
        aria-description="Opens the release page"
        title="Opens the release page"
        onClick={available.onOpenPage}
      >
        <span className="max-[701px]:hidden">Update available</span>
        <span className="hidden max-[701px]:inline">Update</span>
      </button>
    )}
  </>
)
