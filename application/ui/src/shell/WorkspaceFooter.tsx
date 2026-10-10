import { useEffect, useState, type ReactNode } from "react"

import { FooterUpdate, type FooterUpdateProps } from "./FooterUpdate"

// How the backend link is doing, most severe first: "ok" shows nothing.
export type FooterStatus = "restarting" | "unavailable" | "reconnecting" | "ok"

// Recovery is announced this long, then the footer returns to its normal colours.
export const recoveredForMs = 3_000

type Tone = "danger" | "warning" | "success"
const shown: Record<Exclude<FooterStatus, "ok">, { readonly tone: Tone; readonly text: string }> = {
  restarting: { tone: "danger", text: "Crash loop" },
  unavailable: { tone: "danger", text: "Offline" },
  reconnecting: { tone: "warning", text: "Reconnecting" },
}
// The terminal counts under the workspace. While the backend link is in trouble the
// whole bar takes the status tone, and says so on the right; after it recovers it
// turns green with "Reconnected" for a moment. The status is short, bold and set in
// capitals by CSS, so assistive technology still reads ordinary words. An update waits
// beside it as a chip, "Update ready" or "Update available", in the bar's own colours;
// it opens the update's notice (FooterUpdate.tsx).
export const WorkspaceFooter = ({
  hidden,
  count,
  running,
  status,
  navigate = false,
  onRetry,
  update,
  usage,
}: {
  readonly hidden: boolean
  // The person is navigating the workspace rather than typing in a terminal.
  readonly navigate?: boolean
  readonly count: number
  readonly running: number
  readonly status: FooterStatus
  // Offered while the runner keeps crashing: starts the terminals over.
  readonly onRetry?: (() => void) | undefined
  // An update waiting, downloaded or to fetch. Quiet: it never tones the bar, and the
  // link's status keeps its place after it.
  readonly update?: FooterUpdateProps | undefined
  // The account's subscriptions, at its end before the status.
  readonly usage?: ReactNode
}): React.JSX.Element => {
  const [previous, setPrevious] = useState(status)
  const [recovered, setRecovered] = useState(false)
  if (status !== previous) {
    setPrevious(status)
    setRecovered(status === "ok")
  }
  useEffect(() => {
    if (!recovered) return
    const timer = setTimeout(() => setRecovered(false), recoveredForMs)
    return () => clearTimeout(timer)
  }, [recovered])
  const current =
    status !== "ok"
      ? shown[status]
      : recovered
        ? { tone: "success" as const, text: "Reconnected" }
        : undefined
  return (
    <footer
      hidden={hidden}
      data-tone={current?.tone}
      className="app-footer max-[701px]:px-3 max-[701px]:text-[8px] h-7 shrink-0 items-center justify-between px-4 text-caption"
    >
      <span className="flex items-center gap-2">
        <span>
          {count} {count === 1 ? "terminal" : "terminals"}
        </span>
        <span className="footer-running max-[701px]:hidden ml-2 pl-3">{running} running</span>
        {navigate && (
          <span role="status" className="footer-navigate ml-2 flex items-center gap-1.5 pl-3">
            <span className="font-bold">Navigating</span>
            <span className="max-[701px]:hidden">· arrows move · Enter to type</span>
          </span>
        )}
      </span>
      <span className="flex items-center gap-4">
        {usage}
        <FooterUpdate update={update} hidden={hidden} />
        <span className="footer-status flex items-center gap-1.5 font-bold">
          <span role="status" aria-live={current?.tone === "danger" ? "assertive" : "polite"}>
            {current?.text}
          </span>
          {status === "restarting" && onRetry && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="footer-action cursor-pointer font-bold"
                onClick={onRetry}
              >
                Try again
              </button>
            </>
          )}
        </span>
      </span>
    </footer>
  )
}
