import { NovaMark } from "@novadeck/toolkit/NovaLogo"
import type { ReactNode } from "react"

// What some settings look like before the person picks: a few lines of terminal text, and the
// notices an agent's ask or its finish brings. Pictures only (aria-hidden): the rows under them
// say the same in words.

// Lines a terminal might show, with an arrow and an inequality that ligatures join.
const sampleLines = (
  <>
    <span className="settings-sample-muted">~/novadeck</span>{" "}
    <span className="settings-sample-accent">main</span>
    {"\n"}
    <span className="settings-sample-accent">❯</span> pnpm test{" "}
    <span className="settings-sample-muted">--filter runner</span>
    {"\n"}
    {"const ok = (a, b) => a !== b"} <span className="settings-sample-muted">{"// 0O 1lI"}</span>
  </>
)

// The terminal text as Terminal's settings draw it: its font, its size in CSS pixels, and
// whether pairs such as => join.
export const TerminalSample = ({
  family,
  size,
  ligatures,
}: {
  readonly family: string
  readonly size: number
  readonly ligatures: boolean
}): React.JSX.Element => (
  <pre
    className="settings-sample px-4 py-3"
    style={{ fontFamily: `"${family}", var(--font-mono)`, fontSize: `${size}px` }}
    data-ligatures={ligatures ? "on" : "off"}
    aria-hidden="true"
  >
    {sampleLines}
  </pre>
)

// What Notifications' switches bring: the toast for an agent that needs you, where the app gives
// one, and, where it can show them, the desktop notice for one that is done. Each dims while its
// switch is off.
export const NoticePreview = ({
  toast,
  needs,
  done,
  desktop,
}: {
  // The Inbox's toast for an ask, as the app hands it over.
  readonly toast: ReactNode
  readonly needs: boolean
  readonly done: boolean
  // Whether the app can show desktop notifications, as the desktop app can.
  readonly desktop: boolean
}): React.JSX.Element => (
  <div className="settings-preview flex flex-wrap items-start gap-4 px-4 py-4" aria-hidden="true">
    {toast && (
      <figure className="settings-preview-item m-0 w-72 max-w-full" data-off={!needs || undefined}>
        <figcaption className="settings-description mb-1.5 text-caption">
          Needs you{needs ? "" : " · Off"}
        </figcaption>
        {toast}
      </figure>
    )}
    {desktop && (
      <figure className="settings-preview-item m-0 w-64 max-w-full" data-off={!done || undefined}>
        <figcaption className="settings-description mb-1.5 text-caption">
          Done{done ? "" : " · Off"}
        </figcaption>
        <div className="settings-desktop-notice grid grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 px-3 py-2.5 text-control leading-5">
          <span className="row-span-2 pt-0.5">
            <NovaMark size={18} />
          </span>
          <span className="truncate font-medium">@fern is done: Flaky runner test</span>
          <span className="settings-description">Fixed the flaky test in the runner.</span>
        </div>
      </figure>
    )}
  </div>
)
