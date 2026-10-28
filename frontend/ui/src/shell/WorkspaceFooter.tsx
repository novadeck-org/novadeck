import type { UpdateOffer } from "@novadeck/core/update"
import { RotateCcw } from "lucide-react"
import { useState, type ReactNode } from "react"

import { FooterMurmur, type FooterMurmurProps } from "./FooterMurmur"
import { FooterSandbox, type FooterSandboxProps } from "./FooterSandbox"
import { useOverlayOpen } from "./notice-focus"
import { PortableInstall, type PortableInstallProps } from "./PortableInstall"
import { UpdateAvailable, type FooterAvailable } from "./UpdateAvailable"
import { UpdateProgress } from "./UpdateProgress"
import { WhatsNew, type WhatsNewProps } from "./WhatsNew"

// The terminal counts under the workspace. The runner's link isn't reported here: each
// terminal says so over its screen, and a crash loop asks in a dialog; dismissed, it
// leaves a chip at the end, "Restart terminals", to try again. An update downloading floats a bar above its right end (UpdateProgress.tsx); one it can't install
// itself is a chip, "Update available", that opens the release page (UpdateAvailable.tsx).
// A portable copy has a chip there instead, "Install Novadeck" or "Update available", in
// the bar's own colours, which opens its notice (PortableInstall.tsx). Without the security
// sandbox, a chip before it says so (FooterSandbox.tsx). After an update, a card says what
// is new until it is dismissed (WhatsNew.tsx); it waits while a download's bar
// shows, since notices there don't stack.
export const WorkspaceFooter = ({
  hidden,
  count,
  running,
  waiting = 0,
  navigate = false,
  onRetry,
  portable,
  progress = null,
  available,
  noticeOpen = false,
  whatsNew,
  sandbox,
  murmur,
  usage,
  feedback,
}: {
  readonly hidden: boolean
  // The person is navigating the workspace rather than typing in a terminal.
  readonly navigate?: boolean
  readonly count: number
  readonly running: number
  // Agents that ended their turn to wait on something, counted apart from those at work.
  readonly waiting?: number
  // Offered while the runner keeps crashing: starts the terminals over.
  readonly onRetry?: (() => void) | undefined
  // A portable copy's install entry, with the release it is missing. Quiet: it never tones
  // the bar, and the link's status keeps its place after it.
  readonly portable?: PortableInstallProps | undefined
  // The update the app updates itself to, whose download the floating bar follows.
  readonly progress?: UpdateOffer | null
  // A release an installed copy can't install itself: a chip that opens its release page.
  readonly available?: FooterAvailable | undefined
  // What is new in the version the app updated to, as the card above the right end.
  readonly whatsNew?: WhatsNewProps | undefined
  // Whether a notice is open above the footer's right end, where the bar would cover it.
  readonly noticeOpen?: boolean
  // Set while the app runs without its security sandbox: a chip beside the update's
  // opens the notice that says so.
  readonly sandbox?: FooterSandboxProps | undefined
  // Murmur's install under way or just ended, beside the update's chip.
  readonly murmur?: FooterMurmurProps | undefined
  // The account's subscriptions, at its end before the status.
  readonly usage?: ReactNode
  // The feedback button, after the subscriptions; only a backend that takes feedback has one.
  readonly feedback?: ReactNode
}): React.JSX.Element => {
  // Murmur's sheet, in the place the download's bar would cover.
  const [murmurSheet, setMurmurSheet] = useState(false)
  // The card is up when nothing else holds the corner: not a notice, Murmur's sheet, or a
  // dialog, menu or popover (looked at, as they come and go in portals).
  const [barActive, setBarActive] = useState(false)
  const cardWanted =
    whatsNew !== undefined && !whatsNew.blocked && !hidden && !murmurSheet && !barActive
  const overlay = useOverlayOpen(cardWanted)
  const card = whatsNew && {
    ...whatsNew,
    blocked: whatsNew.blocked || murmurSheet || overlay || barActive,
  }
  return (
    <footer
      hidden={hidden}
      className="app-footer max-[701px]:px-3 max-[701px]:text-[8px] max-[701px]:leading-3 h-7 shrink-0 items-center justify-between px-4 text-caption"
    >
      <span className="flex items-center gap-2">
        <span>
          {count} {count === 1 ? "terminal" : "terminals"}
        </span>
        <span className="footer-running max-[701px]:hidden ml-2 pl-3">{running} running</span>
        {waiting > 0 && (
          <span className="footer-running max-[701px]:hidden ml-2 pl-3">{waiting} waiting</span>
        )}
        {navigate && (
          <span role="status" className="footer-navigate ml-2 flex items-center gap-1.5 pl-3">
            <span className="font-bold">Navigating</span>
            <span className="max-[701px]:hidden">· arrows move · Enter to type</span>
          </span>
        )}
      </span>
      <span className="flex items-center gap-4">
        {usage}
        {feedback}
        <FooterSandbox sandbox={sandbox} hidden={hidden} />
        <FooterMurmur murmur={murmur} hidden={hidden} onSheetChange={setMurmurSheet} />
        <PortableInstall portable={portable} hidden={hidden} />
        <WhatsNew card={card} hidden={hidden} />
        <UpdateAvailable available={available} />
        {/* A download has the corner from its start until its bar fades; the card waits. */}
        <UpdateProgress
          offer={progress}
          hidden={hidden || noticeOpen || murmurSheet}
          onActive={setBarActive}
        />
        {onRetry && (
          <button
            type="button"
            className="footer-update footer-chip cursor-pointer"
            aria-label="Restart terminals"
            title="Restart terminals"
            onClick={onRetry}
          >
            <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
            <span className="footer-chip-text max-[701px]:hidden">Restart terminals</span>
          </button>
        )}
      </span>
    </footer>
  )
}
