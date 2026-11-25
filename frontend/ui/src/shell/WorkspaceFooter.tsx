import type { UpdateOffer } from "@novadeck/core/desktop/update"
import { RotateCcw } from "lucide-react"
import { useCallback, useState, type ReactNode } from "react"

import { AgentChatOffer, type AgentChatOfferProps } from "./AgentChatOffer"
import { FooterMurmur, type FooterMurmurProps } from "./FooterMurmur"
import { FooterOrigin, type FooterOriginProps } from "./FooterOrigin"
import { FooterSandbox, type FooterSandboxProps } from "./FooterSandbox"
import { useOverlayOpen } from "./notice-focus"
import { PortableInstall, type PortableInstallProps } from "./PortableInstall"
import { RestartToUpdate, type RestartUpdateProps } from "./RestartToUpdate"
import { UpdateAvailable, type AvailableUpdate } from "./UpdateAvailable"
import { UpdateProgress } from "./UpdateProgress"
import { WhatsNew, type WhatsNewProps } from "./WhatsNew"

// The terminal counts under the workspace. The runner's link isn't reported here: each
// terminal says so over its screen, and a crash loop asks in a dialog; dismissed, it
// leaves a chip at the right end, "Restart terminals", to try again. An update downloading floats a bar above its right end (UpdateProgress.tsx); one it can't install
// itself is a chip, "Update available", that opens the release page (UpdateAvailable.tsx).
// One downloaded and waiting for the next quit is a chip, "Restart to update", whose card checks
// what a restart would do and offers it (RestartToUpdate.tsx).
// A portable copy has a chip there instead, "Install Novadeck" or "Update available", in
// the bar's own colours, which opens its notice (PortableInstall.tsx). Without the security
// sandbox, a chip in the footer's middle says so (FooterSandbox.tsx), as one does when the open
// project's origin keeps failing to fetch (FooterOrigin.tsx). After an update, a card says what
// is new until it is dismissed (WhatsNew.tsx); it waits while a download's bar
// shows, since notices there don't stack. Agent Chat's one-time offer (AgentChatOffer.tsx) takes
// the same corner, and goes before What's new: it is two lines answered in one click, and What's
// new can stay for weeks, so the offer must not wait behind it; What's new returns once the offer
// is answered.
export const WorkspaceFooter = ({
  hidden,
  count,
  running,
  waiting = 0,
  asleep = 0,
  navigate = false,
  onRetry,
  portable,
  restart,
  progress = null,
  available,
  noticeOpen = false,
  whatsNew,
  chatOffer,
  sandbox,
  origin,
  murmur,
  usage,
  feedback,
  help,
}: {
  readonly hidden: boolean
  // The person is navigating the workspace rather than typing in a terminal.
  readonly navigate?: boolean
  readonly count: number
  readonly running: number
  // Agents that ended their turn to wait on something, counted apart from those at work.
  readonly waiting?: number
  // Agents with a saved session and no process, counted apart from those that run.
  readonly asleep?: number
  // Offered while the runner keeps crashing: starts the terminals over.
  readonly onRetry?: (() => void) | undefined
  // A portable copy's install entry, with the release it is missing. Quiet: it never tones
  // the bar, and the link's status keeps its place after it.
  readonly portable?: PortableInstallProps | undefined
  // A downloaded update waiting for the next quit: a chip, "Restart to update", and its card
  // (RestartToUpdate.tsx). Its card also waits for the notices the footer itself knows of.
  readonly restart?: RestartUpdateProps | undefined
  // The update the app updates itself to, whose download the floating bar follows.
  readonly progress?: UpdateOffer | null
  // A release an installed copy can't install itself: a chip that opens its release page.
  readonly available?: AvailableUpdate | undefined
  // What is new in the version the app updated to, as the card above the right end.
  readonly whatsNew?: WhatsNewProps | undefined
  // Agent Chat's one-time offer, as the card above the right end; given while it is due.
  readonly chatOffer?: AgentChatOfferProps | undefined
  // Whether the sandbox notice is open: the bar and the cards above the right end wait for it,
  // so only one notice shows at a time.
  readonly noticeOpen?: boolean
  // Set while the app runs without its security sandbox: a chip in the footer's middle
  // opens the notice that says so.
  readonly sandbox?: FooterSandboxProps | undefined
  // The open project's origin has kept failing to fetch: a chip in the footer's middle, after the
  // sandbox's, that says why and fetches again.
  readonly origin?: FooterOriginProps | undefined
  // Murmur's install under way or just ended, beside the update's chip.
  readonly murmur?: FooterMurmurProps | undefined
  // The account's subscriptions, at the right end before its buttons.
  readonly usage?: ReactNode
  // The feedback button, at the end before Help; only a backend that takes feedback has one.
  readonly feedback?: ReactNode
  // The Help button, after the feedback button, in the corner.
  readonly help?: ReactNode
}): React.JSX.Element => {
  // Murmur's sheet, in the place the download's bar would cover.
  const [murmurSheet, setMurmurSheet] = useState(false)
  // A card is up when nothing else holds the corner: not a notice, Murmur's sheet, or a
  // dialog, menu or popover (looked at, as they come and go in portals). The offer is wanted
  // before What's new, which waits for it, as it does for every other notice.
  const [barActive, setBarActive] = useState(false)
  // The restart card, which the person opens from its chip, is up: it goes before the offer and
  // What's new, which wait for it, so an agent terminal selected meanwhile takes nothing away.
  const [restartShown, setRestartShown] = useState(false)
  const restartShownChange = restart?.onShownChange
  const onRestartShown = useCallback(
    (shown: boolean): void => {
      setRestartShown(shown)
      restartShownChange?.(shown)
    },
    [restartShownChange],
  )
  const cornerFree = !hidden && !murmurSheet && !barActive && !restartShown
  const offerWanted = chatOffer !== undefined && !chatOffer.blocked && cornerFree
  const cardWanted = whatsNew !== undefined && !whatsNew.blocked && cornerFree && !offerWanted
  const overlay = useOverlayOpen(offerWanted || cardWanted)
  // The what's-new card is up and has the corner; the restart card waits for it.
  const whatsNewShown = cardWanted && !overlay
  const offer = chatOffer && {
    ...chatOffer,
    blocked: chatOffer.blocked || murmurSheet || overlay || barActive || restartShown,
  }
  const card = whatsNew && {
    ...whatsNew,
    blocked: whatsNew.blocked || murmurSheet || overlay || barActive || restartShown || offerWanted,
  }
  return (
    <footer
      hidden={hidden}
      className="app-footer max-[701px]:px-3 max-[701px]:text-[8px] max-[701px]:leading-3 h-7 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-x-4 px-4 text-caption"
    >
      <span className="flex items-center gap-2 justify-self-start whitespace-nowrap">
        <span>
          {count} {count === 1 ? "terminal" : "terminals"}
        </span>
        <span className="footer-running max-[701px]:hidden ml-2 pl-3">{running} running</span>
        {waiting > 0 && (
          <span className="footer-running max-[701px]:hidden ml-2 pl-3">{waiting} waiting</span>
        )}
        {asleep > 0 && (
          <span className="footer-sleeping max-[701px]:hidden ml-2 pl-3">{asleep} asleep</span>
        )}
        {navigate && (
          <span role="status" className="footer-navigate ml-2 flex items-center gap-1.5 pl-3">
            <span className="font-bold">Navigating</span>
            <span className="max-[701px]:hidden">· arrows move · Enter to type</span>
          </span>
        )}
      </span>
      {/* The middle: what the person should notice whichever end they look at. It spans the
          bar's height, so the sandbox notice it anchors rises from the bar's top edge. */}
      <span className="footer-middle relative flex items-center self-stretch">
        <FooterSandbox sandbox={sandbox} hidden={hidden} />
        {/* Keyed by project: a fetch under way is the project's it was started for. */}
        {!hidden && <FooterOrigin key={origin?.projectId} origin={origin} />}
      </span>
      {/* Two groups: the subscriptions, then the buttons and chips (`.footer-misc`), set
          apart only while both show something (region.css). */}
      <span className="footer-end flex items-center justify-self-end">
        {usage}
        <span className="footer-misc flex items-center gap-1">
          {/* Most pressing first, nearest the middle: the crash loop's restart, Murmur's
              install, then the update's chip; the feedback and Help buttons, always there,
              hold the edge so nothing else moves them. */}
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
          <FooterMurmur murmur={murmur} hidden={hidden} onSheetChange={setMurmurSheet} />
          <PortableInstall portable={portable} hidden={hidden} />
          <AgentChatOffer offer={offer} hidden={hidden} />
          <WhatsNew card={card} hidden={hidden} />
          <RestartToUpdate
            restart={
              restart && {
                ...restart,
                onShownChange: onRestartShown,
                // Not the download's bar, which only points at this chip: a press on the chip
                // opens the card and ends the bar (`dismissed` below).
                blocked: restart.blocked || noticeOpen || murmurSheet || whatsNewShown,
              }
            }
            hidden={hidden}
          />
          <UpdateAvailable available={available} />
          {/* A download has the corner from its start until its bar fades; the cards wait,
              but the restart card the person opens from its chip ends it. */}
          <UpdateProgress
            offer={progress}
            hidden={hidden || noticeOpen || murmurSheet}
            dismissed={restartShown}
            onActive={setBarActive}
          />
          {feedback}
          {help}
        </span>
      </span>
    </footer>
  )
}
