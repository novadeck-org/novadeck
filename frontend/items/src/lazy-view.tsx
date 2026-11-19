import {
  lazy,
  Suspense,
  useSyncExternalStore,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react"

// What a view whose code didn't load shows instead: "retry" says so in its pane, with a Retry
// that loads it again; "quiet" keeps the fallback, for a part that isn't a view of its own,
// as a peek's still or a file's steps beside its body.
type Failed = "retry" | "quiet"

// One go at loading a view's code, which React keeps once settled, failed or not: loading it
// again takes a new one.
type Attempt<P> = LazyExoticComponent<ComponentType<P>>

// The views made here that say when they couldn't load, so the demo's debug panel can fail
// them all at once.
const views = new Set<() => void>()

// A failed load goes on to the page's `error` event, as an uncaught error would, where the
// desktop app sends it to its log; the view says it couldn't load in its own place.
const report = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  window.dispatchEvent(new ErrorEvent("error", { error, message }))
}

const ViewFailed = ({ retry }: { readonly retry: () => void }): React.JSX.Element => (
  <div className="artifact-unavailable" data-reason="load" role="alert">
    <p>Couldn't load this view.</p>
    <div className="artifact-unavailable-actions">
      <button type="button" className="artifact-open" onClick={retry}>
        Retry
      </button>
    </div>
  </div>
)

/**
 * A view whose code loads when it first shows, so the workspace's first load never carries a
 * viewer it may not need; `fallback` stands in till it's in. Its code failing to load, as a
 * chunk that couldn't be fetched, stays in its pane: it says it couldn't load, with a Retry
 * that loads it again, instead of taking the app to its crash screen. Only the load is
 * watched: a view that loads renders as it would plainly lazy, and what it throws once
 * loaded goes on as before.
 */
export const lazyView = <P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode,
  failed: Failed = "retry",
): ComponentType<P> => {
  const listeners = new Set<() => void>()
  const Quiet = (): ReactNode => fallback
  const attempt = (from: () => Promise<ComponentType<P>>): Attempt<P> => {
    const next: Attempt<P> = lazy(() =>
      from().then(
        (view) => ({ default: view }),
        (error: unknown) => {
          report(error)
          return { default: failed === "quiet" ? Quiet : Retry }
        },
      ),
    )
    const Retry = (): React.JSX.Element => <ViewFailed retry={() => retry(next)} />
    return next
  }
  let current = attempt(load)
  const swap = (next: Attempt<P>): void => {
    current = next
    for (const listener of listeners) listener()
  }
  // A Retry in one pane loads the view for every pane that shows it; one pressed after
  // another already started the load leaves it be.
  const retry = (failedAttempt: Attempt<P>): void => {
    if (current === failedAttempt) swap(attempt(load))
  }
  if (failed === "retry")
    views.add(() => swap(attempt(() => Promise.reject(new Error("The demo failed this view.")))))
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const snapshot = (): Attempt<P> => current
  return (props: P) => {
    const View = useSyncExternalStore(subscribe, snapshot)
    return (
      <Suspense fallback={fallback}>
        <View {...props} />
      </Suspense>
    )
  }
}

/** Fails every lazy view as if its code couldn't be fetched, till each one's Retry: the demo's. */
export const failViewLoads = (): void => {
  for (const fail of views) fail()
}
