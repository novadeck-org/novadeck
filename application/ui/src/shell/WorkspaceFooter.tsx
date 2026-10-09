import { useEffect, useState, type ReactNode } from "react"

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
// capitals by CSS, so assistive technology still reads ordinary words. A downloaded
// update waits beside it as "Update ready · Restart", in the bar's own colours.
export const WorkspaceFooter = ({
  hidden,
  count,
  running,
  status,
  navigate = false,
  onRetry,
  update,
  onInstall,
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
  // The version of a downloaded update, which waits for a restart. Quiet: it never
  // tones the bar, and the link's status keeps its place after it.
  readonly update?: string | undefined
  // Restarts into the update.
  readonly onInstall?: (() => void) | undefined
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
  // The version the person pressed Restart for: a newer one is a new offer, not pending.
  const [pressed, setPressed] = useState<string>()
  const installing = update !== undefined && pressed === update
  const offered = update !== undefined && onInstall !== undefined
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
        {/* Always mounted, so filling it announces the arrival; out of the layout, and kept
            for assistive technology where the visible words are dropped to fit. */}
        <span role="status" aria-live="polite" className="sr-only">
          {offered ? (installing ? "Restarting to update" : "Update ready") : ""}
        </span>
        {update && onInstall && (
          <span className="footer-update flex items-center gap-1.5">
            {!installing && (
              <>
                <span aria-hidden="true" className="max-[701px]:hidden">
                  Update ready
                </span>
                <span aria-hidden="true" className="max-[701px]:hidden">
                  ·
                </span>
              </>
            )}
            <button
              type="button"
              className="footer-action cursor-pointer font-bold"
              aria-label={
                installing ? `Restarting to update to ${update}` : `Restart to update to ${update}`
              }
              disabled={installing}
              onClick={() => {
                if (installing) return
                setPressed(update)
                onInstall()
              }}
            >
              {/* Narrow, the button alone says what it does. */}
              {installing ? (
                "Restarting…"
              ) : (
                <>
                  <span className="max-[701px]:hidden">Restart</span>
                  <span className="hidden max-[701px]:inline">Update</span>
                </>
              )}
            </button>
          </span>
        )}
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
