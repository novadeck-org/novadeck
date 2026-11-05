import { Component, type ReactNode } from "react"

import { BootSplash } from "./BootSplash"

// What a person sees once the app can't draw itself: why, in a line, and a reload.
const CrashNotice = ({ reload }: { readonly reload: () => void }): React.JSX.Element => (
  <div role="alert" className="flex max-w-90 flex-col items-center gap-2 text-center">
    <p className="m-0 text-lead font-medium">Novadeck ran into an error</p>
    <p className="boot-failure-note m-0 text-body">
      Part of the app stopped working. Reload to start it over.
    </p>
    <div className="mt-2 flex items-center gap-3">
      <button type="button" className="button primary" onClick={reload}>
        Reload
      </button>
    </div>
  </div>
)

// Stands in for the app once a render throws, or a part of it fails to load, with the
// boot splash's failure and a reload, rather than leaving the window blank. React reports
// the error itself, as it does every error a boundary catches.
export class CrashBoundary extends Component<
  {
    readonly children?: ReactNode
    // Starts the app over: the page's reload, which fetches its parts again.
    readonly reload?: () => void
  },
  { readonly crashed: boolean }
> {
  override state = { crashed: false }

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true }
  }

  override render(): ReactNode {
    if (!this.state.crashed) return this.props.children
    const { reload = () => window.location.reload() } = this.props
    return (
      <BootSplash
        line=""
        fill={1}
        leaving={false}
        failure={<CrashNotice reload={reload} />}
        settled
      />
    )
  }
}
