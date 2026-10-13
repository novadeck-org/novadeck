import { Component } from "react"
import type { ErrorInfo, ReactNode } from "react"

// One page failing must not blank the header and the footer. `resetKey` (the location) lets
// the next navigation try again.
export class ErrorBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { error: Error | null; key: string }
> {
  override state = { error: null as Error | null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error: Error | null; key: string },
  ) {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack)
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="workspace flex min-w-0 flex-1 items-start justify-center p-6">
        <div className="pane floating max-w-lg p-4 text-body">
          <h1 className="m-0 text-body font-medium">This page failed to render</h1>
          <p className="mt-2 mb-0 font-mono text-[12px] break-words text-muted">{error.message}</p>
        </div>
      </div>
    )
  }
}
